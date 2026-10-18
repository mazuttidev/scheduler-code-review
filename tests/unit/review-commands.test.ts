import { describe, expect, it, vi } from 'vitest';

import {
  CleanupWorkspaceCommand,
  FetchChangesCommand,
  FetchPendingTasksCommand,
  MarkReviewedCommand,
  PrepareWorkspaceCommand,
  ResolveMergeRequestCommand,
  RunReviewCommand,
  WriteReportsCommand,
} from '../../src/application/commands/review-commands.js';
import type { ReviewFamily } from '../../src/application/commands/review-commands.js';
import type { ReportWriter } from '../../src/application/ports/report-writer.js';
import type { ReviewStateStore } from '../../src/application/ports/review-state-store.js';
import type { Workspace, WorkspaceManager } from '../../src/application/ports/workspace-manager.js';
import { OutputFormat, Verdict } from '../../src/domain/enums.js';
import { InvalidOutputError } from '../../src/domain/errors.js';
import { FakeProviderFactory, SimulatedFailure } from '../../src/infrastructure/providers/fake/fake-provider-factory.js';
import {
  sampleDiff,
  sampleMergeRequest,
  sampleOutput,
  samplePrompt,
  sampleReport,
  sampleTask,
} from '../helpers/samples.js';

const WORKSPACE: Workspace = {
  path: '/tmp/worktrees/run-1/demo__loja__mr-1',
  headSha: 'b'.repeat(40),
  repositoryPath: '/tmp/repos/demo__loja',
};

function workspaceManager() {
  return {
    fetchChanges: vi.fn<WorkspaceManager['fetchChanges']>(() => Promise.resolve(sampleDiff())),
    prepare: vi.fn<WorkspaceManager['prepare']>(() => Promise.resolve(WORKSPACE)),
    dispose: vi.fn<WorkspaceManager['dispose']>(() => Promise.resolve()),
  };
}

function reportWriter(format: OutputFormat, path: string, failure?: Error) {
  return {
    format,
    write: vi.fn<ReportWriter['write']>(() =>
      failure ? Promise.reject(failure) : Promise.resolve(path),
    ),
    remove: vi.fn<ReportWriter['remove']>(() => Promise.resolve()),
  };
}

function familyOf(factory: FakeProviderFactory): ReviewFamily {
  return {
    formatter: factory.createPromptFormatter(),
    engine: factory.createEngine(),
    parser: factory.createResponseParser(),
  };
}

describe('comandos das etapas', () => {
  it('cada comando tem o nome da etapa e a tarefa a que pertence', () => {
    const workspaces = workspaceManager();
    const task = { ...sampleTask(), mergeRequestUrl: 'https://exemplo.test/mr/1' };
    const state: ReviewStateStore = {
      wasReviewed: () => Promise.resolve(false),
      markReviewed: () => Promise.resolve(),
      unmark: () => Promise.resolve(),
    };
    const entry = {
      taskId: 't1',
      headSha: 'b'.repeat(40),
      runId: 'run-1',
      reviewedAt: '2026-10-12T06:01:37.552Z',
      verdict: Verdict.Approve,
    };
    const family = familyOf(new FakeProviderFactory());

    const commands = [
      new FetchPendingTasksCommand({ kind: task.source, fetchPending: () => Promise.resolve([]) }, 5),
      new ResolveMergeRequestCommand(
        {
          kind: sampleMergeRequest().host,
          resolveMergeRequest: () => Promise.resolve(sampleMergeRequest()),
          cloneUrl: () => '',
          mergeRequestRef: () => '',
        },
        task,
      ),
      new FetchChangesCommand(workspaces, 't1', sampleMergeRequest()),
      new PrepareWorkspaceCommand(workspaces, 't1', sampleMergeRequest()),
      new RunReviewCommand(family, {
        runId: 'run-1',
        taskId: 't1',
        workspace: WORKSPACE,
        prompt: samplePrompt(),
      }),
      new WriteReportsCommand([], 't1', sampleReport(), '/tmp/reviews/t1'),
      new MarkReviewedCommand(state, entry),
      new CleanupWorkspaceCommand(workspaces, 't1', WORKSPACE),
    ];

    expect(commands.map((command) => [command.name, command.taskId])).toEqual([
      ['fetch-pending-tasks', null],
      ['resolve-merge-request', 't1'],
      ['fetch-changes', 't1'],
      ['prepare-workspace', 't1'],
      ['run-review', 't1'],
      ['write-reports', 't1'],
      ['mark-reviewed', 't1'],
      ['cleanup-workspace', 't1'],
    ]);
  });
});

describe('PrepareWorkspaceCommand', () => {
  it('desfazer remove o worktree que ele criou', async () => {
    const workspaces = workspaceManager();
    const command = new PrepareWorkspaceCommand(workspaces, 't1', sampleMergeRequest());

    expect(await command.execute()).toBe(WORKSPACE);
    await command.undo();
    await command.undo();

    expect(workspaces.dispose).toHaveBeenCalledTimes(1);
    expect(workspaces.dispose).toHaveBeenCalledWith(WORKSPACE);
  });

  it('desfazer sem ter executado não faz nada', async () => {
    const workspaces = workspaceManager();

    await new PrepareWorkspaceCommand(workspaces, 't1', sampleMergeRequest()).undo();

    expect(workspaces.dispose).not.toHaveBeenCalled();
  });
});

describe('RunReviewCommand', () => {
  const input = { runId: 'run-1', taskId: 't1', workspace: WORKSPACE, prompt: samplePrompt() };

  it('devolve o review interpretado e o uso informado pelo motor', async () => {
    const family = familyOf(new FakeProviderFactory({ output: sampleOutput() }));

    const execution = await new RunReviewCommand(family, input).execute();

    expect(execution).toEqual({ output: sampleOutput(), usage: { durationMs: 0, turns: 1 } });
  });

  it('entrega ao motor o worktree, o prompt formatado e a correlação', async () => {
    const family = familyOf(new FakeProviderFactory());
    const review = vi.spyOn(family.engine, 'review');

    await new RunReviewCommand(family, { ...input, timeoutMs: 60_000 }).execute();

    const request = review.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      workingDirectory: WORKSPACE.path,
      correlation: { runId: 'run-1', taskId: 't1' },
      outputSchema: samplePrompt().outputSchema,
    });
    expect(request?.prompt.user).toContain('# Tarefa');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('lança InvalidOutputError quando o parser rejeita a resposta', async () => {
    const family = familyOf(
      new FakeProviderFactory({ failures: [SimulatedFailure.InvalidOutput] }),
    );

    await expect(new RunReviewCommand(family, input).execute()).rejects.toBeInstanceOf(
      InvalidOutputError,
    );
  });
});

describe('WriteReportsCommand', () => {
  it('grava em cada formato e devolve os caminhos', async () => {
    const json = reportWriter(OutputFormat.Json, '/tmp/reviews/t1/review.json');
    const markdown = reportWriter(OutputFormat.Markdown, '/tmp/reviews/t1/review.md');
    const report = sampleReport();
    const command = new WriteReportsCommand([json, markdown], 't1', report, '/tmp/reviews/t1');

    const paths = await command.execute();

    expect(paths).toEqual(['/tmp/reviews/t1/review.json', '/tmp/reviews/t1/review.md']);
    expect(json.write).toHaveBeenCalledWith(report, '/tmp/reviews/t1');
  });

  it('desfazer apaga os arquivos gravados, uma única vez', async () => {
    const json = reportWriter(OutputFormat.Json, '/tmp/reviews/t1/review.json');
    const markdown = reportWriter(OutputFormat.Markdown, '/tmp/reviews/t1/review.md');
    const command = new WriteReportsCommand([json, markdown], 't1', sampleReport(), '/tmp/reviews/t1');
    await command.execute();

    await command.undo();
    await command.undo();

    expect(json.remove).toHaveBeenCalledExactlyOnceWith('/tmp/reviews/t1/review.json');
    expect(markdown.remove).toHaveBeenCalledExactlyOnceWith('/tmp/reviews/t1/review.md');
  });

  it('limpa o efeito parcial quando um formato falha, e relança o erro', async () => {
    const failure = new Error('disco cheio');
    const json = reportWriter(OutputFormat.Json, '/tmp/reviews/t1/review.json');
    const markdown = reportWriter(OutputFormat.Markdown, '/tmp/reviews/t1/review.md', failure);
    const command = new WriteReportsCommand([json, markdown], 't1', sampleReport(), '/tmp/reviews/t1');

    await expect(command.execute()).rejects.toBe(failure);

    expect(json.remove).toHaveBeenCalledExactlyOnceWith('/tmp/reviews/t1/review.json');
    // Nada ficou para o rollback desfazer.
    await command.undo();
    expect(json.remove).toHaveBeenCalledTimes(1);
  });
});

describe('MarkReviewedCommand', () => {
  it('marca o par tarefa + head_sha, e desfazer desmarca', async () => {
    const state = {
      wasReviewed: vi.fn<ReviewStateStore['wasReviewed']>(() => Promise.resolve(false)),
      markReviewed: vi.fn<ReviewStateStore['markReviewed']>(() => Promise.resolve()),
      unmark: vi.fn<ReviewStateStore['unmark']>(() => Promise.resolve()),
    };
    const entry = {
      taskId: 't1',
      headSha: 'b'.repeat(40),
      runId: 'run-1',
      reviewedAt: '2026-10-12T06:01:37.552Z',
      verdict: Verdict.ChangesRequested,
    };
    const command = new MarkReviewedCommand(state, entry);

    await command.execute();
    await command.undo();

    expect(state.markReviewed).toHaveBeenCalledWith(entry);
    expect(state.unmark).toHaveBeenCalledWith('t1', 'b'.repeat(40));
  });
});
