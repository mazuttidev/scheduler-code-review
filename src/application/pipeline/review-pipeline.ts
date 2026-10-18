import { join } from 'node:path';

import { ErrorKind, SkipReason } from '../../domain/enums.js';
import type { Verdict } from '../../domain/enums.js';
import { ConfigurationError, RunAbortedError, toAppError } from '../../domain/errors.js';
import type { AppError, SerializedError } from '../../domain/errors.js';
import type { PipelineEvents, RunSummary } from '../../domain/events.js';
import type { DiffContext, MergeRequestRef } from '../../domain/merge-request.js';
import { countBySeverity } from '../../domain/review-report.js';
import type { ReviewReport } from '../../domain/review-report.js';
import type { ReviewTask } from '../../domain/review-task.js';
import { toPathSegment, writeFileAtomic } from '../../shared/fs.js';
import { CommandInvoker } from '../commands/command-invoker.js';
import type { CommandDecoration } from '../commands/command.js';
import {
  CleanupWorkspaceCommand,
  FetchChangesCommand,
  FetchPendingTasksCommand,
  MarkReviewedCommand,
  PrepareWorkspaceCommand,
  ResolveMergeRequestCommand,
  RunReviewCommand,
  WriteReportsCommand,
} from '../commands/review-commands.js';
import type { ReviewExecution, ReviewFamily } from '../commands/review-commands.js';
import type { EventPublisher } from '../events/event-bus.js';
import type { CodeHost } from '../ports/code-host.js';
import type { ReportWriter } from '../ports/report-writer.js';
import type { ReviewEngine, ReviewProviderFactory } from '../ports/review-provider.js';
import type { ReviewStateStore } from '../ports/review-state-store.js';
import type { TaskSource } from '../ports/task-source.js';
import type { Workspace, WorkspaceManager } from '../ports/workspace-manager.js';
import { ReviewPromptBuilder } from '../prompt/review-prompt-builder.js';
import type { ReviewPrompt } from '../prompt/review-prompt.js';

/** Resultado de uma tarefa na execução. */
export type TaskOutcome =
  | {
      readonly status: 'reviewed';
      readonly taskId: string;
      readonly verdict: Verdict;
      readonly reportPaths: readonly string[];
    }
  | { readonly status: 'skipped'; readonly taskId: string; readonly reason: SkipReason }
  | { readonly status: 'failed'; readonly taskId: string; readonly error: SerializedError }
  | { readonly status: 'pending'; readonly taskId: string };

export interface RunResult {
  readonly runId: string;
  readonly outcomes: readonly TaskOutcome[];
  readonly summary: RunSummary;
  /** Erro que interrompeu a execução, ou `null` se ela chegou ao fim. */
  readonly aborted: AppError | null;
}

export function summarize(outcomes: readonly TaskOutcome[]): RunSummary {
  const counts: Record<TaskOutcome['status'], number> = {
    reviewed: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
  };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return { total: outcomes.length, ...counts };
}

export interface ReviewPipelineDeps {
  readonly runId: string;
  readonly taskSource: TaskSource;
  readonly codeHost: CodeHost;
  readonly workspaces: WorkspaceManager;
  readonly provider: ReviewProviderFactory;
  /** Ponto de extensão do motor; é por aqui que entra a gravação de transcrições. */
  readonly decorateEngine: (engine: ReviewEngine) => ReviewEngine;
  readonly reportWriters: readonly ReportWriter[];
  readonly state: ReviewStateStore;
  readonly events: EventPublisher<PipelineEvents>;
  readonly decorate: CommandDecoration;
  readonly prompt: {
    readonly systemRules: string;
    readonly instructions: string;
    readonly outputSchema: Readonly<Record<string, unknown>>;
  };
  readonly limits: { readonly maxTasksPerRun: number; readonly maxDiffBytes: number };
  /** Pastas da execução, dentro de `runs/<runId>/`. */
  readonly paths: { readonly reviewsDirectory: string; readonly promptsDirectory: string };
  readonly options: {
    readonly dryRun: boolean;
    readonly keepWorkspaces: boolean;
    /** Revisa só esta tarefa, se ela estiver entre as pendentes. */
    readonly onlyTaskId?: string;
    readonly timeoutMs?: number;
  };
  readonly redact?: (text: string) => string;
  readonly now?: () => Date;
}

/** Quantas pendentes buscar para localizar a tarefa pedida em `--task`. */
const ONLY_TASK_FETCH_LIMIT = 100;

/**
 * Orquestra a execução: busca as tarefas e passa cada uma pelas etapas, que
 * são comandos executados por um `CommandInvoker` próprio da tarefa.
 *
 * É o cliente da Abstract Factory, o diretor do Builder e quem publica os
 * eventos do ciclo de vida. Só conhece portas, nunca classes concretas.
 */
export class ReviewPipeline {
  private readonly family: ReviewFamily;
  private readonly now: () => Date;

  constructor(private readonly deps: ReviewPipelineDeps) {
    // A família inteira vem da mesma fábrica, uma única vez.
    this.family = {
      formatter: deps.provider.createPromptFormatter(),
      engine: deps.decorateEngine(deps.provider.createEngine()),
      parser: deps.provider.createResponseParser(),
    };
    this.now = deps.now ?? (() => new Date());
  }

  async run(): Promise<RunResult> {
    const { events, provider, taskSource, options } = this.deps;
    const startedAt = this.now();
    events.emit('run.started', {
      startedAt: startedAt.toISOString(),
      provider: provider.kind,
      taskSource: taskSource.kind,
      dryRun: options.dryRun,
    });

    const outcomes: TaskOutcome[] = [];
    let tasks: readonly ReviewTask[];
    try {
      tasks = await this.fetchTasks();
    } catch (thrown) {
      // Sem a lista de tarefas não há execução: qualquer falha aqui interrompe.
      const error = toAppError(thrown);
      events.emit('run.aborted', { error: error.toJSON(), pendingTaskIds: [] });
      return this.finish(startedAt, outcomes, error);
    }
    events.emit('tasks.fetched', { count: tasks.length, taskIds: tasks.map((task) => task.id) });

    let aborted: AppError | null = null;
    for (const [index, task] of tasks.entries()) {
      try {
        outcomes.push(await this.reviewTask(task));
      } catch (thrown) {
        // `reviewTask` só deixa escapar a interrupção da execução.
        aborted = toAppError(thrown);
        const pendingTaskIds = tasks.slice(index).map((pending) => pending.id);
        outcomes.push(...pendingTaskIds.map((taskId) => ({ status: 'pending', taskId }) as const));
        events.emit('run.aborted', { error: aborted.toJSON(), pendingTaskIds });
        break;
      }
    }
    return this.finish(startedAt, outcomes, aborted);
  }

  private finish(startedAt: Date, outcomes: readonly TaskOutcome[], aborted: AppError | null): RunResult {
    const summary = summarize(outcomes);
    this.deps.events.emit('run.finished', {
      summary,
      durationMs: this.now().getTime() - startedAt.getTime(),
    });
    return { runId: this.deps.runId, outcomes, summary, aborted };
  }

  private async fetchTasks(): Promise<readonly ReviewTask[]> {
    const { taskSource, limits, options, decorate, events } = this.deps;
    const onlyTaskId = options.onlyTaskId;
    const limit = onlyTaskId === undefined ? limits.maxTasksPerRun : ONLY_TASK_FETCH_LIMIT;
    const invoker = new CommandInvoker(decorate, events);
    const tasks = await invoker.run(new FetchPendingTasksCommand(taskSource, limit));
    if (onlyTaskId === undefined) return tasks;

    const selected = tasks.filter((task) => task.id === onlyTaskId);
    if (selected.length === 0) {
      throw new ConfigurationError('A tarefa pedida não está entre as pendentes', {
        taskId: onlyTaskId,
      });
    }
    return selected;
  }

  /** Revisa uma tarefa. Só lança `RunAbortedError`; as demais falhas viram resultado. */
  private async reviewTask(task: ReviewTask): Promise<TaskOutcome> {
    const { events, decorate } = this.deps;
    events.emit('task.started', { taskId: task.id, title: task.title });
    const invoker = new CommandInvoker(decorate, events);
    try {
      return await this.runSteps(task, invoker);
    } catch (thrown) {
      await invoker.rollback();
      const abort = asRunAbort(thrown);
      if (abort) throw abort;
      const error = toAppError(thrown).toJSON();
      events.emit('task.failed', { taskId: task.id, error });
      return { status: 'failed', taskId: task.id, error };
    }
  }

  private async runSteps(task: ReviewTask, invoker: CommandInvoker): Promise<TaskOutcome> {
    const { codeHost, workspaces, state, limits, options } = this.deps;
    const { mergeRequestUrl } = task;
    if (mergeRequestUrl === null) return this.skip(task, SkipReason.MissingMergeRequestLink);

    const resolved = await invoker.run(
      new ResolveMergeRequestCommand(codeHost, { ...task, mergeRequestUrl }),
    );
    if (resolved.state !== 'opened') return this.skip(task, SkipReason.MergeRequestNotOpen);
    if (await state.wasReviewed(task.id, resolved.diffRefs.headSha)) {
      return this.skip(task, SkipReason.AlreadyReviewed);
    }

    const diff = await invoker.run(new FetchChangesCommand(workspaces, task.id, resolved));
    // Daqui em diante valem os commits realmente comparados.
    const mr = withComparedCommits(resolved, diff);
    const headMoved = diff.headSha !== resolved.diffRefs.headSha;
    if (headMoved && (await state.wasReviewed(task.id, diff.headSha))) {
      return this.skip(task, SkipReason.AlreadyReviewed);
    }
    if (diff.bytes > limits.maxDiffBytes) return this.skip(task, SkipReason.DiffTooLarge);

    const prompt = new ReviewPromptBuilder()
      .withSystemRules(this.deps.prompt.systemRules)
      .withInstructions(this.deps.prompt.instructions)
      .withTask(task)
      .withMergeRequest(mr)
      .withDiff(diff)
      .withOutputSchema(this.deps.prompt.outputSchema)
      .build();

    if (options.dryRun) {
      await this.writeDryRunPrompt(task, prompt);
      return this.skip(task, SkipReason.DryRun);
    }

    const workspace = await invoker.run(new PrepareWorkspaceCommand(workspaces, task.id, mr));
    const execution = await invoker.run(
      new RunReviewCommand(this.family, {
        runId: this.deps.runId,
        taskId: task.id,
        workspace,
        prompt,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
    );

    const report = this.buildReport(task, mr, execution);
    const reportPaths = await invoker.run(
      new WriteReportsCommand(
        this.deps.reportWriters,
        task.id,
        report,
        join(this.deps.paths.reviewsDirectory, toPathSegment(task.id)),
      ),
    );
    await invoker.run(
      new MarkReviewedCommand(state, {
        taskId: task.id,
        headSha: mr.diffRefs.headSha,
        runId: this.deps.runId,
        reviewedAt: report.generatedAt,
        verdict: report.output.verdict,
      }),
    );
    if (!options.keepWorkspaces) await this.cleanup(invoker, task.id, workspace);

    this.deps.events.emit('review.completed', {
      taskId: task.id,
      verdict: report.output.verdict,
      findingsBySeverity: report.stats.findingsBySeverity,
      reportPaths,
    });
    return { status: 'reviewed', taskId: task.id, verdict: report.output.verdict, reportPaths };
  }

  /** A limpeza nunca reprova um review já gravado; a falha fica no log da etapa. */
  private async cleanup(invoker: CommandInvoker, taskId: string, workspace: Workspace): Promise<void> {
    try {
      await invoker.run(new CleanupWorkspaceCommand(this.deps.workspaces, taskId, workspace));
    } catch {
      // A próxima execução remove os restos no início.
    }
  }

  private skip(task: ReviewTask, reason: SkipReason): TaskOutcome {
    this.deps.events.emit('task.skipped', { taskId: task.id, reason });
    return { status: 'skipped', taskId: task.id, reason };
  }

  private async writeDryRunPrompt(task: ReviewTask, prompt: ReviewPrompt): Promise<void> {
    const { system, user } = this.family.formatter.format(prompt);
    const redact = this.deps.redact ?? ((text: string) => text);
    await writeFileAtomic(
      join(this.deps.paths.promptsDirectory, `${toPathSegment(task.id)}.md`),
      redact(`# System\n\n${system}\n\n# User\n\n${user}\n`),
    );
  }

  private buildReport(task: ReviewTask, mr: MergeRequestRef, execution: ReviewExecution): ReviewReport {
    const { output, usage } = execution;
    return {
      runId: this.deps.runId,
      generatedAt: this.now().toISOString(),
      provider: this.deps.provider.kind,
      task: { id: task.id, title: task.title, url: task.url, source: task.source },
      mergeRequest: {
        iid: mr.iid,
        title: mr.title,
        webUrl: mr.webUrl,
        projectPath: mr.projectPath,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        headSha: mr.diffRefs.headSha,
      },
      output,
      stats: {
        findingsBySeverity: countBySeverity(output.findings),
        durationMs: usage.durationMs,
        ...(usage.turns === undefined ? {} : { turns: usage.turns }),
        ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
      },
    };
  }
}

function withComparedCommits(mr: MergeRequestRef, diff: DiffContext): MergeRequestRef {
  return { ...mr, diffRefs: { ...mr.diffRefs, baseSha: diff.baseSha, headSha: diff.headSha } };
}

/**
 * Decide se uma falha interrompe a execução. As etapas já chegam aqui com a
 * decisão da política de retentativa. Fora delas (estado, montagem do prompt),
 * vale a mesma regra da ARCHITECTURE §9: erro de configuração interrompe.
 */
function asRunAbort(thrown: unknown): RunAbortedError | null {
  if (thrown instanceof RunAbortedError) return thrown;
  const error = toAppError(thrown);
  return error.kind === ErrorKind.Configuration ? new RunAbortedError(error) : null;
}
