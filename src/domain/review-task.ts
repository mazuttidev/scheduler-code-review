import type { TaskSourceKind } from './enums.js';

/** Tarefa no modelo interno, independente da plataforma de origem. */
export interface ReviewTask {
  readonly id: string;
  readonly source: TaskSourceKind;
  readonly url: string;
  readonly title: string;
  /** Corpo da tarefa convertido para Markdown. */
  readonly description: string;
  readonly businessRules: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  /** Campo estruturado com o link do MR; `null` quando vazio. */
  readonly mergeRequestUrl: string | null;
}
