import { describe, expect, it } from 'vitest';

import { ReviewPromptBuilder } from '../../src/application/prompt/review-prompt-builder.js';
import { ConfigurationError, InvalidInputError } from '../../src/domain/errors.js';
import { reviewOutputJsonSchema } from '../../src/domain/review-output.js';
import { XmlSectionsPromptFormatter } from '../../src/infrastructure/providers/claude/xml-sections-prompt-formatter.js';
import { MarkdownPromptFormatter } from '../../src/infrastructure/providers/fake/fake-provider-factory.js';
import {
  INSTRUCTIONS,
  SYSTEM_RULES,
  completeBuilder,
  sampleDiff,
  sampleMergeRequest,
  sampleTask,
} from '../helpers/samples.js';

/**
 * Builder no nightly-review.
 *
 * - Builder: `ReviewPromptBuilder`.
 * - Product: `ReviewPrompt`, neutro, sem formato.
 * - Director: no sistema, `ReviewPipeline.reviewTask()`; aqui, cada teste.
 *
 * O prompt tem sete partes de origens diferentes, que ficam disponíveis em
 * momentos diferentes. O builder as recebe em etapas e valida tudo no `build()`.
 */

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Esperava uma exceção');
}

describe('Builder: ReviewPromptBuilder', () => {
  it('recusa montar um prompt incompleto e lista as partes que faltam', () => {
    const builder = new ReviewPromptBuilder().withTask(sampleTask()).addNote('Só uma nota');

    const error = thrownBy(() => builder.build());

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).details).toEqual({
      missing: ['systemRules', 'instructions', 'mergeRequest', 'diff', 'outputSchema'],
    });
  });

  it('trata um texto vazio como parte faltando', () => {
    const error = thrownBy(() => completeBuilder().withInstructions('').build());

    expect((error as ConfigurationError).details).toEqual({ missing: ['instructions'] });
  });

  it('recusa um MR sem arquivos alterados', () => {
    const builder = completeBuilder().withDiff(sampleDiff({ files: [] }));

    const error = thrownBy(() => builder.build());

    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).details).toEqual({ iid: 1 });
  });

  it('tem API fluente: cada etapa devolve o próprio builder', () => {
    const builder = new ReviewPromptBuilder();

    expect(builder.withTask(sampleTask())).toBe(builder);
    expect(builder.addNote('nota')).toBe(builder);
  });

  it('aceita as partes em qualquer ordem', () => {
    const inPipelineOrder = completeBuilder().build();
    const reversed = new ReviewPromptBuilder()
      .withOutputSchema(reviewOutputJsonSchema())
      .withDiff(sampleDiff())
      .withMergeRequest(sampleMergeRequest())
      .withTask(sampleTask())
      .withInstructions(INSTRUCTIONS)
      .withSystemRules(SYSTEM_RULES)
      .build();

    expect(reversed).toEqual(inPipelineOrder);
  });

  it('entrega o produto completo e congelado', () => {
    const prompt = completeBuilder().addNote('O MR depende do !41.').build();

    expect(prompt).toMatchObject({
      systemRules: SYSTEM_RULES,
      instructions: INSTRUCTIONS,
      task: sampleTask(),
      mergeRequest: sampleMergeRequest(),
      notes: ['O MR depende do !41.'],
    });
    expect(Object.isFrozen(prompt)).toBe(true);
    expect(Object.isFrozen(prompt.notes)).toBe(true);
  });

  it('não altera um produto já entregue quando o builder segue em uso', () => {
    const builder = completeBuilder().addNote('primeira');
    const first = builder.build();

    const second = builder.addNote('segunda').build();

    expect(first.notes).toEqual(['primeira']);
    expect(second.notes).toEqual(['primeira', 'segunda']);
  });

  it('mantém o tipo da subclasse ao encadear (this polimórfico)', () => {
    class AnnotatedPromptBuilder extends ReviewPromptBuilder {
      reviewedBy(name: string): this {
        return this.addNote(`Revisor responsável: ${name}`);
      }
    }

    // Só compila porque withTask devolve `this`, e não `ReviewPromptBuilder`.
    const builder = new AnnotatedPromptBuilder().withTask(sampleTask()).reviewedBy('Ana');

    expect(builder).toBeInstanceOf(AnnotatedPromptBuilder);
  });
});

describe('Builder: o produto é neutro', () => {
  it('o mesmo ReviewPrompt gera saídas diferentes em formatadores diferentes', () => {
    const prompt = completeBuilder().addNote('O MR depende do !41.').build();

    const markdown = new MarkdownPromptFormatter().format(prompt);
    const xml = new XmlSectionsPromptFormatter().format(prompt);

    expect(markdown.user).toContain('# Tarefa');
    expect(xml.user).toContain('<task id="t1" url="https://tarefas.example.com/t1">');
    expect(markdown.user).not.toBe(xml.user);
    for (const formatted of [markdown, xml]) {
      expect(formatted.system).toBe(SYSTEM_RULES);
      expect(formatted.user).toContain('Aplicar desconto no carrinho');
      expect(formatted.user).toContain('+  return coupon / total;');
      expect(formatted.user).toContain('O MR depende do !41.');
    }
  });
});
