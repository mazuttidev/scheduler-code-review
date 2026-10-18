import type { DiffContext, MergeRequestRef } from '../../domain/merge-request.js';
import type { ReviewTask } from '../../domain/review-task.js';

/**
 * Builder (Product): o prompt do review, sem formato. Quem o transforma em
 * texto é o `PromptFormatter` da família do provedor.
 */
export interface ReviewPrompt {
  /** Papel do revisor e regras do prompt (`prompts/system.md`). */
  readonly systemRules: string;
  /** Critérios do time (`prompts/review-instructions.md`). */
  readonly instructions: string;
  readonly task: ReviewTask;
  readonly mergeRequest: MergeRequestRef;
  readonly diff: DiffContext;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
}
