import { ConfigurationError, InvalidInputError } from '../../domain/errors.js';
import type { DiffContext, MergeRequestRef } from '../../domain/merge-request.js';
import type { ReviewTask } from '../../domain/review-task.js';

import type { ReviewPrompt } from './review-prompt.js';

/**
 * Builder (ConcreteBuilder): monta o `ReviewPrompt` em etapas, com as partes
 * chegando em momentos diferentes do pipeline. O `build()` confere que nada
 * obrigatório faltou e devolve o produto congelado.
 */
export class ReviewPromptBuilder {
  private systemRules: string | undefined;
  private instructions: string | undefined;
  private task: ReviewTask | undefined;
  private mergeRequest: MergeRequestRef | undefined;
  private diff: DiffContext | undefined;
  private outputSchema: Readonly<Record<string, unknown>> | undefined;
  private readonly notes: string[] = [];

  withSystemRules(markdown: string): this {
    this.systemRules = markdown;
    return this;
  }

  withInstructions(markdown: string): this {
    this.instructions = markdown;
    return this;
  }

  withTask(task: ReviewTask): this {
    this.task = task;
    return this;
  }

  withMergeRequest(mergeRequest: MergeRequestRef): this {
    this.mergeRequest = mergeRequest;
    return this;
  }

  withDiff(diff: DiffContext): this {
    this.diff = diff;
    return this;
  }

  withOutputSchema(schema: Readonly<Record<string, unknown>>): this {
    this.outputSchema = schema;
    return this;
  }

  /** Parte opcional: observações extras para o revisor. */
  addNote(note: string): this {
    this.notes.push(note);
    return this;
  }

  build(): ReviewPrompt {
    const { systemRules, instructions, task, mergeRequest, diff, outputSchema } = this;
    if (!systemRules || !instructions || !task || !mergeRequest || !diff || !outputSchema) {
      throw new ConfigurationError('Prompt incompleto', { missing: this.missingParts() });
    }
    if (diff.files.length === 0) {
      throw new InvalidInputError('O MR não tem arquivos alterados', { iid: mergeRequest.iid });
    }
    return Object.freeze({
      systemRules,
      instructions,
      task,
      mergeRequest,
      diff,
      outputSchema,
      notes: Object.freeze([...this.notes]),
    });
  }

  private missingParts(): string[] {
    const parts = {
      systemRules: this.systemRules,
      instructions: this.instructions,
      task: this.task,
      mergeRequest: this.mergeRequest,
      diff: this.diff,
      outputSchema: this.outputSchema,
    };
    return Object.entries(parts)
      .filter(([, value]) => !value)
      .map(([name]) => name);
  }
}
