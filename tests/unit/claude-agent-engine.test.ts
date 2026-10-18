import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorKind } from '../../src/domain/enums.js';
import { AppError, TimeoutError } from '../../src/domain/errors.js';
import { ClaudeAgentEngine } from '../../src/infrastructure/providers/claude/claude-agent-engine.js';
import { StructuredOutputParser } from '../../src/infrastructure/providers/claude/claude-provider-factory.js';
import { sampleOutput, sampleRequest } from '../helpers/samples.js';

// O SDK é simulado: nenhum teste abre um processo do Claude.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const queryMock = vi.mocked(query);
type QueryResult = ReturnType<typeof query>;

const TOKEN = 'claude-token-de-teste';

function engine(extra: { model?: string } = {}): ClaudeAgentEngine {
  return new ClaudeAgentEngine({
    oauthToken: TOKEN,
    maxTurns: 30,
    baseEnv: {
      PATH: '/usr/bin:/bin',
      HOME: '/home/dev',
      GITLAB_TOKEN: 'gitlab-token-de-teste',
      NOTION_TOKEN: 'notion-token-de-teste',
      AWS_SECRET_ACCESS_KEY: 'outro-segredo',
    },
    ...extra,
  });
}

/** Faz o `query()` simulado emitir as mensagens e, se pedido, lançar no fim. */
function sdkEmits(messages: readonly object[], thrown?: Error): void {
  queryMock.mockImplementation(() => {
    async function* stream(): AsyncGenerator<object> {
      for (const message of messages) {
        await Promise.resolve();
        yield message;
      }
      if (thrown) throw thrown;
    }
    return stream() as unknown as QueryResult;
  });
}

function success(extra: object = {}): object {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Review concluído.',
    structured_output: sampleOutput(),
    duration_ms: 393_432,
    num_turns: 12,
    total_cost_usd: 0.42,
    ...extra,
  };
}

function resultError(subtype: string, errors: string[] = []): object {
  return { type: 'result', subtype, is_error: true, errors, duration_ms: 1, num_turns: 1 };
}

function assistantError(error: SDKAssistantMessageError): object {
  return { type: 'assistant', error, message: { content: [] } };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Esperava um AppError');
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('ClaudeAgentEngine: resultado', () => {
  it('devolve a saída estruturada e o uso de um resultado de sucesso', async () => {
    sdkEmits([{ type: 'system', subtype: 'init' }, { type: 'assistant', message: {} }, success()]);

    const response = await engine().review(sampleRequest());

    expect(response).toEqual({
      text: 'Review concluído.',
      structured: sampleOutput(),
      usage: { durationMs: 393_432, turns: 12, costUsd: 0.42 },
    });
    expect(new StructuredOutputParser().parse(response)).toEqual({
      ok: true,
      value: sampleOutput(),
    });
  });

  it('trata error_max_structured_output_retries como saída inválida', async () => {
    sdkEmits([resultError('error_max_structured_output_retries', ['schema não atendido'])]);

    const error = await failure(engine().review(sampleRequest()));

    expect(error.kind).toBe(ErrorKind.InvalidOutput);
    expect(error.details).toEqual({
      subtype: 'error_max_structured_output_retries',
      errors: ['schema não atendido'],
    });
  });

  it.each([
    ['error_max_turns', ErrorKind.InvalidOutput],
    ['error_max_budget_usd', ErrorKind.Configuration],
    ['error_during_execution', ErrorKind.Unknown],
  ])('classifica o resultado %s como %s', async (subtype, kind) => {
    sdkEmits([resultError(subtype)]);

    expect((await failure(engine().review(sampleRequest()))).kind).toBe(kind);
  });

  it('um success sem structured_output conta como saída inválida', async () => {
    sdkEmits([success({ structured_output: undefined })]);

    const error = await failure(engine().review(sampleRequest()));

    expect(error.kind).toBe(ErrorKind.InvalidOutput);
    expect(error.message).toContain('sem saída estruturada');
  });

  it('um success com is_error conta como falha, pelo erro de API visto', async () => {
    sdkEmits([assistantError('overloaded'), success({ is_error: true })]);

    expect((await failure(engine().review(sampleRequest()))).kind).toBe(ErrorKind.Transient);
  });

  it('falha quando a sessão termina sem mensagem de resultado', async () => {
    sdkEmits([{ type: 'system', subtype: 'init' }]);

    const error = await failure(engine().review(sampleRequest()));

    expect(error.kind).toBe(ErrorKind.Unknown);
    expect(error.message).toContain('sem resultado');
  });
});

describe('ClaudeAgentEngine: erros de API', () => {
  it('classifica rate_limit na mensagem assistant como limite da assinatura', async () => {
    sdkEmits([assistantError('rate_limit'), resultError('error_during_execution')]);

    const error = await failure(engine().review(sampleRequest()));

    expect(error.kind).toBe(ErrorKind.RateLimit);
    expect(error.details).toEqual({ apiError: 'rate_limit', subtype: 'error_during_execution' });
  });

  it('reconhece o limite da assinatura também pelo evento de rate limit', async () => {
    sdkEmits([
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
    ]);

    expect((await failure(engine().review(sampleRequest()))).kind).toBe(ErrorKind.RateLimit);
  });

  it('um aviso de rate limit que não rejeita não atrapalha o review', async () => {
    sdkEmits([
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
      success(),
    ]);

    await expect(engine().review(sampleRequest())).resolves.toMatchObject({
      structured: sampleOutput(),
    });
  });

  it('classifica a exceção lançada depois de um resultado de erro pelo último erro de API', async () => {
    const thrown = new Error('Claude Code process exited with code 1');
    sdkEmits([assistantError('server_error'), resultError('error_during_execution')], thrown);

    const error = await failure(engine().review(sampleRequest()));

    expect(error.kind).toBe(ErrorKind.Transient);
    expect(error.cause).toBe(thrown);
  });

  it('classifica como desconhecida a exceção sem nenhum erro de API antes', async () => {
    sdkEmits([], new Error('spawn claude ENOENT'));

    expect((await failure(engine().review(sampleRequest()))).kind).toBe(ErrorKind.Unknown);
  });

  // O Record<SDKAssistantMessageError, …> obriga o compilador a cobrar uma linha por valor.
  const expectedKinds: Record<SDKAssistantMessageError, ErrorKind> = {
    rate_limit: ErrorKind.RateLimit,
    overloaded: ErrorKind.Transient,
    server_error: ErrorKind.Transient,
    authentication_failed: ErrorKind.Configuration,
    billing_error: ErrorKind.Configuration,
    oauth_org_not_allowed: ErrorKind.Configuration,
    account_on_hold: ErrorKind.Configuration,
    verification_required: ErrorKind.Configuration,
    cloud_credential_error: ErrorKind.Configuration,
    model_not_found: ErrorKind.Configuration,
    max_output_tokens: ErrorKind.InvalidOutput,
    invalid_request: ErrorKind.Unknown,
    unknown: ErrorKind.Unknown,
  };

  it.each(Object.keys(expectedKinds) as SDKAssistantMessageError[])(
    'mapeia o erro de API %s para o tipo certo',
    async (apiError) => {
      sdkEmits([assistantError(apiError)]);

      expect((await failure(engine().review(sampleRequest()))).kind).toBe(expectedKinds[apiError]);
    },
  );
});

describe('ClaudeAgentEngine: tempo limite', () => {
  /** Um `query()` que só termina quando o SDK é cancelado. */
  function sdkHangsUntilAborted(): void {
    queryMock.mockImplementation(({ options }) => {
      const signal = options?.abortController?.signal;
      const next = (): Promise<never> =>
        new Promise((_resolve, reject) => {
          const fail = (): void => {
            reject(new Error('Claude Code process aborted by user'));
          };
          if (signal?.aborted) fail();
          signal?.addEventListener('abort', fail);
        });
      return { [Symbol.asyncIterator]: () => ({ next }) } as unknown as QueryResult;
    });
  }

  it('cancela o SDK e lança TimeoutError quando o sinal do pedido dispara', async () => {
    sdkHangsUntilAborted();
    const deadline = new AbortController();

    const review = engine().review(sampleRequest({ signal: deadline.signal }));
    deadline.abort();

    const error = await failure(review);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.details).toEqual({ taskId: 't1' });
    expect(queryMock.mock.calls[0]?.[0].options?.abortController?.signal.aborted).toBe(true);
  });

  it('lança TimeoutError quando o sinal já chega disparado', async () => {
    sdkHangsUntilAborted();

    const review = engine().review(sampleRequest({ signal: AbortSignal.abort() }));

    await expect(review).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('ClaudeAgentEngine: postura de segurança (ARCHITECTURE §12)', () => {
  async function optionsUsed(extra: { model?: string } = {}) {
    sdkEmits([success()]);
    await engine(extra).review(sampleRequest({ workingDirectory: '/tmp/worktrees/run-1/mr-1' }));
    const call = queryMock.mock.calls[0]?.[0];
    if (!call?.options) throw new Error('query() não foi chamado com opções');
    return { prompt: call.prompt, options: call.options };
  }

  it('só oferece e autoaprova as ferramentas de leitura', async () => {
    const { options } = await optionsUsed();

    expect(options.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options.disallowedTools).toEqual([
      'Bash',
      'Write',
      'Edit',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
      'Agent',
    ]);
  });

  it('nega o que pediria permissão e não carrega nada do repositório revisado', async () => {
    const { options } = await optionsUsed();

    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({});
    expect(options).not.toHaveProperty('canUseTool');
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions');
  });

  it('entrega ao processo do Claude só PATH, HOME e o token do Claude', async () => {
    const { options } = await optionsUsed();

    expect(options.env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/dev',
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    expect(JSON.stringify(options.env)).not.toContain('gitlab-token-de-teste');
    expect(JSON.stringify(options.env)).not.toContain('notion-token-de-teste');
  });

  it('instala o hook PreToolUse com a guarda do worktree do pedido', async () => {
    const { options } = await optionsUsed();

    const matchers = options.hooks?.PreToolUse ?? [];
    expect(Object.keys(options.hooks ?? {})).toEqual(['PreToolUse']);
    expect(matchers).toHaveLength(1);
    expect(matchers[0]?.matcher).toBeUndefined();

    const guard = matchers[0]?.hooks[0];
    const decision = await guard?.(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sessao-de-teste',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/worktrees/run-1/mr-1',
        tool_name: 'Bash',
        tool_input: { command: 'cat ~/.ssh/id_rsa' },
        tool_use_id: 'tool-1',
      },
      'tool-1',
      { signal: new AbortController().signal },
    );
    expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('passa o worktree, o prompt, o schema e os limites do pedido', async () => {
    const request = sampleRequest();

    const { prompt, options } = await optionsUsed();

    expect(prompt).toBe(request.prompt.user);
    expect(options.cwd).toBe('/tmp/worktrees/run-1/mr-1');
    expect(options.systemPrompt).toBe(request.prompt.system);
    expect(options.outputFormat).toEqual({ type: 'json_schema', schema: request.outputSchema });
    expect(options.maxTurns).toBe(30);
    expect(options.abortController).toBeInstanceOf(AbortController);
  });

  it('só fixa o modelo quando a configuração pede', async () => {
    expect((await optionsUsed()).options).not.toHaveProperty('model');

    queryMock.mockReset();
    expect((await optionsUsed({ model: 'claude-sonnet-5-5' })).options.model).toBe(
      'claude-sonnet-5-5',
    );
  });
});

describe('StructuredOutputParser', () => {
  const parser = new StructuredOutputParser();

  it('rejeita uma resposta sem saída estruturada', () => {
    const result = parser.parse({ text: JSON.stringify(sampleOutput()), usage: { durationMs: 1 } });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe(ErrorKind.InvalidOutput);
  });

  it('valida de novo com o Zod e aponta o que está fora do schema', () => {
    const result = parser.parse({
      text: '',
      structured: { ...sampleOutput(), verdict: 'talvez' },
      usage: { durationMs: 1 },
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && JSON.stringify(result.error.details)).toContain('verdict');
  });
});
