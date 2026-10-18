import type { Verdict } from '../../domain/enums.js';

/** Registro de que um par tarefa + `head_sha` já foi revisado. */
export interface ReviewedEntry {
  readonly taskId: string;
  readonly headSha: string;
  readonly runId: string;
  /** Instante da marcação, em ISO 8601. */
  readonly reviewedAt: string;
  readonly verdict: Verdict;
}

/** Guarda o que já foi revisado, para não revisar duas vezes o mesmo `head_sha`. */
export interface ReviewStateStore {
  wasReviewed(taskId: string, headSha: string): Promise<boolean>;
  markReviewed(entry: ReviewedEntry): Promise<void>;
  /** Desfaz a marcação. Não falha se o par não estiver marcado. */
  unmark(taskId: string, headSha: string): Promise<void>;
}
