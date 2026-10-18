import type {
  ErrorKind,
  ProviderKind,
  Severity,
  SkipReason,
  TaskSourceKind,
  Verdict,
} from './enums.js';
import type { SerializedError } from './errors.js';

/** Contagem das tarefas de uma execução, por resultado. */
export interface RunSummary {
  readonly total: number;
  readonly reviewed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly pending: number;
}

/** Identifica a etapa. `taskId` é `null` nas etapas da execução, sem tarefa. */
export interface CommandRef {
  readonly command: string;
  readonly taskId: string | null;
}

/**
 * Mapa de cada tipo de evento para o seu payload. É a fonte única de verdade
 * do Observer, do log em JSONL e do manifesto.
 */
export interface PipelineEvents {
  'run.started': {
    readonly startedAt: string;
    readonly provider: ProviderKind;
    readonly taskSource: TaskSourceKind;
    readonly dryRun: boolean;
  };
  'run.finished': { readonly summary: RunSummary; readonly durationMs: number };
  'run.aborted': { readonly error: SerializedError; readonly pendingTaskIds: readonly string[] };

  'tasks.fetched': { readonly count: number; readonly taskIds: readonly string[] };

  'task.started': { readonly taskId: string; readonly title: string };
  'task.skipped': { readonly taskId: string; readonly reason: SkipReason };
  'task.failed': { readonly taskId: string; readonly error: SerializedError };

  'command.started': CommandRef;
  'command.succeeded': CommandRef & { readonly durationMs: number };
  'command.failed': CommandRef & { readonly durationMs: number; readonly error: SerializedError };
  /** `error` presente quando o próprio desfazer falhou. */
  'command.undone': CommandRef & { readonly error?: SerializedError };

  'retry.scheduled': CommandRef & {
    readonly attempt: number;
    readonly delayMs: number;
    readonly errorKind: ErrorKind;
    readonly message: string;
  };

  'review.completed': {
    readonly taskId: string;
    readonly verdict: Verdict;
    readonly findingsBySeverity: Readonly<Record<Severity, number>>;
    readonly reportPaths: readonly string[];
  };
}

export type PipelineEventType = keyof PipelineEvents;

/** União de envelopes derivada do mapa: um membro por tipo de evento. */
export type EventEnvelope<TEvents> = {
  [K in keyof TEvents]: {
    readonly type: K;
    /** Instante da emissão, em ISO 8601. */
    readonly at: string;
    readonly payload: TEvents[K];
  };
}[keyof TEvents];
