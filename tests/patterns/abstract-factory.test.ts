import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewProviderFactory } from '../../src/application/ports/review-provider.js';
import type { ReviewPrompt } from '../../src/application/prompt/review-prompt.js';
import { ProviderKind } from '../../src/domain/enums.js';
import { InvalidOutputError, RateLimitError, TransientError } from '../../src/domain/errors.js';
import type { ReviewOutput } from '../../src/domain/review-output.js';
import { ReviewOutputSchema } from '../../src/domain/review-output.js';
import { ClaudeAgentEngine } from '../../src/infrastructure/providers/claude/claude-agent-engine.js';
import {
  ClaudeProviderFactory,
  StructuredOutputParser,
} from '../../src/infrastructure/providers/claude/claude-provider-factory.js';
import { XmlSectionsPromptFormatter } from '../../src/infrastructure/providers/claude/xml-sections-prompt-formatter.js';
import {
  DEFAULT_FAKE_OUTPUT,
  FakeProviderFactory,
  FakeReviewEngine,
  JsonTextResponseParser,
  MarkdownPromptFormatter,
  SimulatedFailure,
} from '../../src/infrastructure/providers/fake/fake-provider-factory.js';
import type { Result } from '../../src/shared/types.js';
import { sampleOutput, samplePrompt } from '../helpers/samples.js';

/**
 * Abstract Factory no nightly-review.
 *
 * - AbstractFactory: `ReviewProviderFactory`.
 * - ConcreteFactory: `FakeProviderFactory` e `ClaudeProviderFactory`.
 * - AbstractProduct: `PromptFormatter`, `ReviewEngine`, `ResponseParser`.
 * - ConcreteProduct, família falsa: `MarkdownPromptFormatter`, `FakeReviewEngine`,
 *   `JsonTextResponseParser`.
 * - ConcreteProduct, família Claude: `XmlSectionsPromptFormatter`,
 *   `ClaudeAgentEngine`, `StructuredOutputParser`.
 * - Client: no sistema, `ReviewPipeline`; aqui, `createFamily` e `runReview`.
 *
 * As três peças de um provedor precisam combinar entre si. O cliente pede as
 * três à mesma fábrica e nunca conhece as classes concretas.
 */

// A família Claude roda aqui com o `query()` do SDK simulado.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

function claudeAnswersWith(output: ReviewOutput): void {
  vi.mocked(query).mockImplementation(() => {
    async function* stream(): AsyncGenerator<object> {
      await Promise.resolve();
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Review concluído.',
        structured_output: output,
        duration_ms: 1_200,
        num_turns: 4,
        total_cost_usd: 0.1,
      };
    }
    return stream() as unknown as ReturnType<typeof query>;
  });
}

/** Client: só enxerga a fábrica abstrata, como o pipeline. */
function createFamily(factory: ReviewProviderFactory) {
  return {
    formatter: factory.createPromptFormatter(),
    engine: factory.createEngine(),
    parser: factory.createResponseParser(),
  };
}

async function runReview(
  family: ReturnType<typeof createFamily>,
  prompt: ReviewPrompt,
): Promise<Result<ReviewOutput, InvalidOutputError>> {
  const response = await family.engine.review({
    prompt: family.formatter.format(prompt),
    workingDirectory: '/tmp/worktree',
    outputSchema: prompt.outputSchema,
    correlation: { runId: 'run-1', taskId: prompt.task.id },
  });
  return family.parser.parse(response);
}

describe('Abstract Factory: FakeProviderFactory', () => {
  it('entrega os três produtos da própria família', () => {
    const factory = new FakeProviderFactory();

    const family = createFamily(factory);

    expect(factory.kind).toBe(ProviderKind.Fake);
    expect(family.formatter).toBeInstanceOf(MarkdownPromptFormatter);
    expect(family.engine).toBeInstanceOf(FakeReviewEngine);
    expect(family.parser).toBeInstanceOf(JsonTextResponseParser);
  });

  it('executa um review completo só com as peças da família', async () => {
    const family = createFamily(new FakeProviderFactory({ output: sampleOutput() }));

    const result = await runReview(family, samplePrompt());

    expect(result).toEqual({ ok: true, value: sampleOutput() });
  });

  it('devolve por padrão um review válido para o schema do domínio', async () => {
    const family = createFamily(new FakeProviderFactory());

    const result = await runReview(family, samplePrompt());

    expect(result).toEqual({ ok: true, value: DEFAULT_FAKE_OUTPUT });
    expect(ReviewOutputSchema.safeParse(DEFAULT_FAKE_OUTPUT).success).toBe(true);
  });

  it('as peças combinam: o formatador pede JSON em texto, que é o que o parser lê', () => {
    const { formatter } = createFamily(new FakeProviderFactory());

    const { user } = formatter.format(samplePrompt());

    expect(user).toContain('Responda somente com um JSON que siga este schema:');
    expect(user).toContain('"$schema": "http://json-schema.org/draft-07/schema#"');
  });

  it('encena as falhas pedidas, na ordem, e depois responde normalmente', async () => {
    const family = createFamily(
      new FakeProviderFactory({
        failures: [
          SimulatedFailure.Transient,
          SimulatedFailure.InvalidOutput,
          SimulatedFailure.RateLimit,
        ],
        output: sampleOutput(),
      }),
    );
    const prompt = samplePrompt();

    await expect(runReview(family, prompt)).rejects.toBeInstanceOf(TransientError);

    const invalid = await runReview(family, prompt);
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.error).toBeInstanceOf(InvalidOutputError);

    await expect(runReview(family, prompt)).rejects.toBeInstanceOf(RateLimitError);

    await expect(runReview(family, prompt)).resolves.toEqual({ ok: true, value: sampleOutput() });
  });
});

describe('Abstract Factory: ClaudeProviderFactory', () => {
  const settings = { oauthToken: 'claude-token-de-teste', maxTurns: 30 };

  it('entrega os três produtos da família Claude', () => {
    const factory = new ClaudeProviderFactory(settings);

    const family = createFamily(factory);

    expect(factory.kind).toBe(ProviderKind.Claude);
    expect(family.formatter).toBeInstanceOf(XmlSectionsPromptFormatter);
    expect(family.engine).toBeInstanceOf(ClaudeAgentEngine);
    expect(family.parser).toBeInstanceOf(StructuredOutputParser);
  });

  it('o mesmo cliente executa o review com a outra família, sem mudar uma linha', async () => {
    claudeAnswersWith(sampleOutput());
    const family = createFamily(new ClaudeProviderFactory(settings));

    const result = await runReview(family, samplePrompt());

    expect(result).toEqual({ ok: true, value: sampleOutput() });
    // O prompt chegou ao SDK no formato desta família: seções em XML.
    expect(vi.mocked(query).mock.calls[0]?.[0].prompt).toContain('<task id="t1"');
  });
});

describe('Abstract Factory: por que a família precisa ser coerente', () => {
  it('o parser da família Claude não entende a resposta do motor falso', async () => {
    // O motor falso entrega o review como texto JSON, sem `structured`.
    const response = await new FakeProviderFactory({ output: sampleOutput() })
      .createEngine()
      .review({
        prompt: { system: '', user: '' },
        workingDirectory: '/tmp/worktree',
        outputSchema: {},
        correlation: { runId: 'run-1', taskId: 't1' },
      });

    expect(new StructuredOutputParser().parse(response).ok).toBe(false);
    expect(new JsonTextResponseParser().parse(response).ok).toBe(true);
  });

  it('o parser da família falsa não entende a resposta de um motor de outra família', () => {
    // Um motor no estilo do Agent SDK entrega o review em `structured`, não em `text`.
    const fromAnotherFamily = {
      text: 'Review concluído.',
      structured: sampleOutput(),
      usage: { durationMs: 1_200, turns: 4 },
    };

    const result = new JsonTextResponseParser().parse(fromAnotherFamily);

    expect(result.ok).toBe(false);
  });
});
