import type { DiffContext, MergeRequestRef } from '../../domain/merge-request.js';
import type { ReviewOutput } from '../../domain/review-output.js';
import type { ReviewReport } from '../../domain/review-report.js';
import type { ReviewTask } from '../../domain/review-task.js';
import type { CodeHost } from '../ports/code-host.js';
import type { ReportWriter } from '../ports/report-writer.js';
import type {
  EngineResponse,
  PromptFormatter,
  ResponseParser,
  ReviewEngine,
} from '../ports/review-provider.js';
import type { ReviewStateStore, ReviewedEntry } from '../ports/review-state-store.js';
import type { TaskSource } from '../ports/task-source.js';
import type { Workspace, WorkspaceManager } from '../ports/workspace-manager.js';
import type { ReviewPrompt } from '../prompt/review-prompt.js';

import type { Command } from './command.js';

/** Command (ConcreteCommand): busca as tarefas em revisão. Roda uma vez por execução. */
export class FetchPendingTasksCommand implements Command<readonly ReviewTask[]> {
  readonly name = 'fetch-pending-tasks';
  readonly taskId = null;

  constructor(
    private readonly source: TaskSource,
    private readonly limit: number,
  ) {}

  execute(): Promise<readonly ReviewTask[]> {
    return this.source.fetchPending(this.limit);
  }
}

export type TaskWithMergeRequest = ReviewTask & { readonly mergeRequestUrl: string };

/** Command (ConcreteCommand): resolve o link do MR na plataforma de código. */
export class ResolveMergeRequestCommand implements Command<MergeRequestRef> {
  readonly name = 'resolve-merge-request';
  readonly taskId: string;

  constructor(
    private readonly codeHost: CodeHost,
    private readonly task: TaskWithMergeRequest,
  ) {
    this.taskId = task.id;
  }

  execute(): Promise<MergeRequestRef> {
    return this.codeHost.resolveMergeRequest(this.task.mergeRequestUrl);
  }
}

/** Command (ConcreteCommand): atualiza o clone base e calcula o diff do MR. */
export class FetchChangesCommand implements Command<DiffContext> {
  readonly name = 'fetch-changes';

  constructor(
    private readonly workspaces: WorkspaceManager,
    readonly taskId: string,
    private readonly mergeRequest: MergeRequestRef,
  ) {}

  execute(): Promise<DiffContext> {
    return this.workspaces.fetchChanges(this.mergeRequest);
  }
}

/** Command (ConcreteCommand): cria o worktree do MR. Desfazer remove o worktree. */
export class PrepareWorkspaceCommand implements Command<Workspace> {
  readonly name = 'prepare-workspace';
  private workspace: Workspace | undefined;

  constructor(
    private readonly workspaces: WorkspaceManager,
    readonly taskId: string,
    private readonly mergeRequest: MergeRequestRef,
  ) {}

  async execute(): Promise<Workspace> {
    this.workspace = await this.workspaces.prepare(this.mergeRequest);
    return this.workspace;
  }

  async undo(): Promise<void> {
    if (!this.workspace) return;
    await this.workspaces.dispose(this.workspace);
    this.workspace = undefined;
  }
}

/** As três peças de um provedor, criadas pela mesma Abstract Factory. */
export interface ReviewFamily {
  readonly formatter: PromptFormatter;
  readonly engine: ReviewEngine;
  readonly parser: ResponseParser;
}

export interface ReviewExecution {
  readonly output: ReviewOutput;
  readonly usage: EngineResponse['usage'];
}

export interface RunReviewInput {
  readonly runId: string;
  readonly taskId: string;
  readonly workspace: Workspace;
  readonly prompt: ReviewPrompt;
  /** Tempo máximo do review. O motor recebe o cancelamento por `signal`. */
  readonly timeoutMs?: number;
}

/**
 * Command (ConcreteCommand): formata o prompt, executa o review e interpreta
 * a resposta, usando a família do provedor. Uma resposta inválida vira
 * `InvalidOutputError`, e a política de retentativa decide o que fazer.
 */
export class RunReviewCommand implements Command<ReviewExecution> {
  readonly name = 'run-review';
  readonly taskId: string;

  constructor(
    private readonly family: ReviewFamily,
    private readonly input: RunReviewInput,
  ) {
    this.taskId = input.taskId;
  }

  async execute(): Promise<ReviewExecution> {
    const { runId, taskId, workspace, prompt, timeoutMs } = this.input;
    const response = await this.family.engine.review({
      prompt: this.family.formatter.format(prompt),
      workingDirectory: workspace.path,
      outputSchema: prompt.outputSchema,
      correlation: { runId, taskId },
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    });
    const parsed = this.family.parser.parse(response);
    if (!parsed.ok) throw parsed.error;
    return { output: parsed.value, usage: response.usage };
  }
}

interface WrittenReport {
  readonly writer: ReportWriter;
  readonly path: string;
}

/**
 * Command (ConcreteCommand): grava o relatório em cada formato configurado.
 * Desfazer apaga os arquivos gravados.
 */
export class WriteReportsCommand implements Command<readonly string[]> {
  readonly name = 'write-reports';
  private written: readonly WrittenReport[] = [];

  constructor(
    private readonly writers: readonly ReportWriter[],
    readonly taskId: string,
    private readonly report: ReviewReport,
    private readonly directory: string,
  ) {}

  async execute(): Promise<readonly string[]> {
    const written: WrittenReport[] = [];
    try {
      for (const writer of this.writers) {
        written.push({ writer, path: await writer.write(this.report, this.directory) });
      }
    } catch (error) {
      // Efeito parcial: o histórico só guarda sucessos, então a limpeza é daqui.
      await Promise.all(
        written.map(({ writer, path }) => writer.remove(path).catch(() => undefined)),
      );
      throw error;
    }
    this.written = written;
    return written.map(({ path }) => path);
  }

  async undo(): Promise<void> {
    const written = this.written;
    this.written = [];
    for (const { writer, path } of written) await writer.remove(path);
  }
}

/** Command (ConcreteCommand): marca o par tarefa + head_sha como revisado. Desfazer desmarca. */
export class MarkReviewedCommand implements Command<void> {
  readonly name = 'mark-reviewed';
  readonly taskId: string;

  constructor(
    private readonly store: ReviewStateStore,
    private readonly entry: ReviewedEntry,
  ) {
    this.taskId = entry.taskId;
  }

  execute(): Promise<void> {
    return this.store.markReviewed(this.entry);
  }

  undo(): Promise<void> {
    return this.store.unmark(this.entry.taskId, this.entry.headSha);
  }
}

/** Command (ConcreteCommand): remove o worktree ao fim de um review bem-sucedido. */
export class CleanupWorkspaceCommand implements Command<void> {
  readonly name = 'cleanup-workspace';

  constructor(
    private readonly workspaces: WorkspaceManager,
    readonly taskId: string,
    private readonly workspace: Workspace,
  ) {}

  execute(): Promise<void> {
    return this.workspaces.dispose(this.workspace);
  }
}
