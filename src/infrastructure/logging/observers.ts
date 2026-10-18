import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { EventSubscriber, Unsubscribe } from '../../application/events/event-bus.js';
import { SkipReason } from '../../domain/enums.js';
import type { ProviderKind, Severity, TaskSourceKind, Verdict } from '../../domain/enums.js';
import type { SerializedError } from '../../domain/errors.js';
import type { EventEnvelope, PipelineEvents, RunSummary } from '../../domain/events.js';
import { writeFileAtomicSync } from '../../shared/fs.js';
import { assertNever } from '../../shared/types.js';

type PipelineEnvelope = EventEnvelope<PipelineEvents>;

export type Redactor = (text: string) => string;

const REDACTED = '[REDACTED]';

/** Cria a função que troca os valores dos segredos por `[REDACTED]`. */
export function createRedactor(secrets: readonly (string | undefined)[]): Redactor {
  const values = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    values.add(secret);
    // Dentro de um JSON o valor aparece com escapes.
    values.add(JSON.stringify(secret).slice(1, -1));
  }
  // Do mais longo para o mais curto, para um segredo não mascarar parte de outro.
  const ordered = [...values].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((result, value) => result.replaceAll(value, REDACTED), text);
}

/**
 * Observer (ConcreteObserver): grava cada evento como uma linha de JSON em
 * `events.jsonl`. Usa `appendFileSync`, que preserva a ordem e não perde
 * linhas se o processo cair.
 */
export class JsonlEventLogger {
  private directoryReady = false;

  constructor(
    private readonly filePath: string,
    private readonly runId: string,
    private readonly redact: Redactor,
  ) {}

  attach(subscriber: EventSubscriber<PipelineEvents>): Unsubscribe {
    return subscriber.onAny((envelope) => {
      this.write(envelope);
    });
  }

  private write({ type, at, payload }: PipelineEnvelope): void {
    if (!this.directoryReady) {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      this.directoryReady = true;
    }
    const line = JSON.stringify({ runId: this.runId, type, at, payload });
    appendFileSync(this.filePath, `${this.redact(line)}\n`, { mode: 0o600 });
  }
}

const SKIP_REASON_LABEL: Readonly<Record<SkipReason, string>> = {
  [SkipReason.MissingMergeRequestLink]: 'a tarefa não tem link de MR',
  [SkipReason.MergeRequestNotOpen]: 'o MR não está aberto',
  [SkipReason.AlreadyReviewed]: 'este head_sha já foi revisado',
  [SkipReason.DiffTooLarge]: 'o diff passa do limite configurado',
  [SkipReason.DryRun]: 'dry-run: o prompt foi gravado e a IA não foi chamada',
};

export interface ConsoleReporterOptions {
  /** Destino das linhas. Padrão: a saída padrão do processo. */
  readonly write?: (line: string) => void;
  readonly redact?: Redactor;
}

/** Observer (ConcreteObserver): mostra o progresso da execução no terminal. */
export class ConsoleReporter {
  private readonly write: (line: string) => void;
  private readonly redact: Redactor;

  constructor(options: ConsoleReporterOptions = {}) {
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.redact = options.redact ?? ((text) => text);
  }

  attach(subscriber: EventSubscriber<PipelineEvents>): Unsubscribe {
    return subscriber.onAny((envelope) => {
      const line = describe(envelope);
      if (line !== null) this.write(this.redact(line));
    });
  }
}

function describe(envelope: PipelineEnvelope): string | null {
  switch (envelope.type) {
    case 'run.started': {
      const { provider, taskSource, dryRun } = envelope.payload;
      return `Execução iniciada (provedor: ${provider}, fonte: ${taskSource})${dryRun ? ' [dry-run]' : ''}`;
    }
    case 'tasks.fetched':
      return `${String(envelope.payload.count)} tarefa(s) em revisão`;
    case 'task.started':
      return `▶ ${envelope.payload.taskId}: ${envelope.payload.title}`;
    case 'task.skipped':
      return `  pulada: ${SKIP_REASON_LABEL[envelope.payload.reason]}`;
    case 'task.failed':
      return `  falhou (${envelope.payload.error.kind}): ${envelope.payload.error.message}`;
    case 'command.started':
      return null;
    case 'command.succeeded':
      return `  ✓ ${envelope.payload.command} (${formatDuration(envelope.payload.durationMs)})`;
    case 'command.failed':
      return `  ✗ ${envelope.payload.command}: ${envelope.payload.error.message}`;
    case 'command.undone': {
      const { command, error } = envelope.payload;
      return error
        ? `  ↩ ${command}: falha ao desfazer (${error.message})`
        : `  ↩ ${command} desfeito`;
    }
    case 'retry.scheduled': {
      const { command, attempt, delayMs, errorKind, message } = envelope.payload;
      return `  ↻ ${command}: tentativa ${String(attempt)} falhou (${errorKind}: ${message}); nova tentativa em ${formatDuration(delayMs)}`;
    }
    case 'review.completed': {
      const { verdict, findingsBySeverity, reportPaths } = envelope.payload;
      const counts = Object.entries(findingsBySeverity)
        .map(([severity, count]) => `${severity} ${String(count)}`)
        .join(', ');
      return [`  veredito: ${verdict} | ${counts}`, ...reportPaths.map((path) => `  → ${path}`)].join(
        '\n',
      );
    }
    case 'run.aborted': {
      const { error, pendingTaskIds } = envelope.payload;
      return `Execução interrompida: ${error.message}. Tarefas pendentes: ${String(pendingTaskIds.length)}`;
    }
    case 'run.finished': {
      const { summary, durationMs } = envelope.payload;
      const counts = [
        `${String(summary.reviewed)} revisada(s)`,
        `${String(summary.skipped)} pulada(s)`,
        `${String(summary.failed)} com falha`,
        `${String(summary.pending)} pendente(s)`,
      ];
      return `Execução concluída em ${formatDuration(durationMs)}: ${counts.join(', ')}`;
    }
    default:
      return assertNever(envelope);
  }
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${String(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

export type ManifestTaskStatus = 'pending' | 'reviewed' | 'skipped' | 'failed';

export interface ManifestTask {
  readonly taskId: string;
  /** `null` enquanto a tarefa não começou. */
  readonly title: string | null;
  readonly status: ManifestTaskStatus;
  readonly reason?: SkipReason;
  readonly error?: SerializedError;
  readonly verdict?: Verdict;
  readonly findingsBySeverity?: Readonly<Record<Severity, number>>;
  readonly reportPaths?: readonly string[];
}

/** Conteúdo do `manifest.json`: resumo da execução e resultado de cada tarefa. */
export interface RunManifest {
  readonly runId: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly provider: ProviderKind | null;
  readonly taskSource: TaskSourceKind | null;
  readonly dryRun: boolean | null;
  readonly summary: RunSummary | null;
  readonly aborted: {
    readonly at: string;
    readonly error: SerializedError;
    readonly pendingTaskIds: readonly string[];
  } | null;
  readonly tasks: readonly ManifestTask[];
}

/**
 * Observer (ConcreteObserver): acumula o resultado das tarefas e grava o
 * `manifest.json` quando a execução termina ou é interrompida.
 */
export class RunManifestWriter {
  private readonly tasks = new Map<string, ManifestTask>();
  private manifest: Omit<RunManifest, 'tasks'>;

  constructor(
    private readonly filePath: string,
    runId: string,
    private readonly redact: Redactor,
  ) {
    this.manifest = {
      runId,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      provider: null,
      taskSource: null,
      dryRun: null,
      summary: null,
      aborted: null,
    };
  }

  attach(subscriber: EventSubscriber<PipelineEvents>): Unsubscribe {
    return subscriber.onAny((envelope) => {
      this.record(envelope);
    });
  }

  private record(envelope: PipelineEnvelope): void {
    switch (envelope.type) {
      case 'run.started': {
        const { startedAt, provider, taskSource, dryRun } = envelope.payload;
        this.manifest = { ...this.manifest, startedAt, provider, taskSource, dryRun };
        return;
      }
      case 'tasks.fetched':
        for (const taskId of envelope.payload.taskIds) this.update(taskId, {});
        return;
      case 'task.started':
        this.update(envelope.payload.taskId, { title: envelope.payload.title });
        return;
      case 'task.skipped':
        this.update(envelope.payload.taskId, {
          status: 'skipped',
          reason: envelope.payload.reason,
        });
        return;
      case 'task.failed':
        this.update(envelope.payload.taskId, { status: 'failed', error: envelope.payload.error });
        return;
      case 'review.completed': {
        const { taskId, verdict, findingsBySeverity, reportPaths } = envelope.payload;
        this.update(taskId, { status: 'reviewed', verdict, findingsBySeverity, reportPaths });
        return;
      }
      case 'run.aborted':
        // Grava já: o manifesto existe mesmo que o `run.finished` não venha.
        this.manifest = { ...this.manifest, aborted: { at: envelope.at, ...envelope.payload } };
        this.write();
        return;
      case 'run.finished': {
        const { summary, durationMs } = envelope.payload;
        this.manifest = { ...this.manifest, finishedAt: envelope.at, summary, durationMs };
        this.write();
        return;
      }
      case 'command.started':
      case 'command.succeeded':
      case 'command.failed':
      case 'command.undone':
      case 'retry.scheduled':
        // O detalhe das etapas fica no events.jsonl.
        return;
      default:
        assertNever(envelope);
    }
  }

  private update(taskId: string, changes: Partial<Omit<ManifestTask, 'taskId'>>): void {
    const current = this.tasks.get(taskId) ?? { taskId, title: null, status: 'pending' };
    this.tasks.set(taskId, { ...current, ...changes });
  }

  private write(): void {
    const manifest: RunManifest = { ...this.manifest, tasks: [...this.tasks.values()] };
    writeFileAtomicSync(this.filePath, `${this.redact(JSON.stringify(manifest, null, 2))}\n`);
  }
}
