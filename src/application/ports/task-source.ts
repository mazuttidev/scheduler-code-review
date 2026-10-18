import type { TaskSourceKind } from '../../domain/enums.js';
import type { ReviewTask } from '../../domain/review-task.js';

/** Adapter (Target): qualquer gerenciador de tarefas. */
export interface TaskSource {
  readonly kind: TaskSourceKind;
  /** Tarefas em revisão, no modelo interno, até o limite pedido. */
  fetchPending(limit: number): Promise<readonly ReviewTask[]>;
}
