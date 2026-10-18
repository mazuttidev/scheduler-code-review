import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_CODE, exitCodeFor } from '../../src/cli/program.js';
import { buildApplication } from '../../src/composition-root.js';
import type { Application } from '../../src/composition-root.js';
import { SettingsSchema } from '../../src/config/app-config.js';
import type { Secrets } from '../../src/config/app-config.js';
import { ErrorKind, SkipReason, Verdict } from '../../src/domain/enums.js';
import { LocalCodeHost } from '../../src/infrastructure/code-hosts/local-code-host.js';
import {
  createDemoRepository,
  isolatedGitClient,
} from '../../src/infrastructure/git/demo-repository.js';
import type { DemoRepository } from '../../src/infrastructure/git/demo-repository.js';
import type { RunManifest } from '../../src/infrastructure/logging/observers.js';
import { SimulatedFailure } from '../../src/infrastructure/providers/fake/fake-provider-factory.js';
import { sampleOutput } from '../helpers/samples.js';

/**
 * Pipeline completo, offline: git real numa pasta temporária, tarefas num
 * arquivo JSON e o provedor falso. A aplicação é montada pela raiz de
 * composição, como na execução de verdade.
 */

interface LoggedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface NightOptions {
  readonly failures?: readonly SimulatedFailure[];
  readonly dryRun?: boolean;
  readonly onlyTaskId?: string;
  readonly tasks?: readonly unknown[];
  readonly settings?: Record<string, unknown>;
}

const NO_SECRETS: Secrets = {
  notionToken: undefined,
  gitlabToken: undefined,
  claudeOauthToken: undefined,
};

describe('ReviewPipeline: execução completa offline', () => {
  const git = isolatedGitClient();
  let root: string;
  let demo: DemoRepository;
  let mergeRequestUrl: string;
  let counter = 0;

  function defaultTasks(): unknown[] {
    return [
      {
        id: 'DEMO-1',
        title: 'Aplicar desconto por cupom',
        acceptanceCriteria: ['Carrinho vazio não quebra.'],
        mergeRequestUrl,
      },
      { id: 'DEMO-2', title: 'Exportar o pedido em PDF' },
    ];
  }

  /** Uma pasta de dados nova, para uma execução sem estado anterior. */
  function freshDataDir(): string {
    counter += 1;
    return join(root, `data-${String(counter)}`);
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  async function night(dataDir: string, options: NightOptions = {}) {
    const tasksPath = join(root, `tasks-${String((counter += 1))}.json`);
    await writeFile(tasksPath, JSON.stringify(options.tasks ?? defaultTasks()));
    const settings = SettingsSchema.parse({
      dataDir,
      taskSource: { kind: 'json-file', jsonFile: { path: tasksPath } },
      codeHost: { kind: 'local', repositoryPath: demo.path },
      provider: { kind: 'fake' },
      ...options.settings,
    });
    const lines: string[] = [];
    const application: Application = await buildApplication(settings, NO_SECRETS, {
      fake: { failures: options.failures ?? [], output: sampleOutput() },
      dryRun: options.dryRun ?? false,
      git,
      write: (line) => lines.push(line),
      // As retentativas não dormem de verdade.
      sleep: () => Promise.resolve(),
      ...(options.onlyTaskId === undefined ? {} : { onlyTaskId: options.onlyTaskId }),
    });
    const result = await application.run();
    const events = (await readFile(application.paths.events, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as LoggedEvent);
    return { application, result, events, lines, dataDir };
  }

  function typesOf(events: readonly LoggedEvent[]): string[] {
    return events.map((event) => event.type);
  }

  function commandsOf(events: readonly LoggedEvent[], type: string): unknown[] {
    return events.filter((event) => event.type === type).map((event) => event.payload.command);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nightly-review-pipeline-'));
    demo = await createDemoRepository(join(root, 'origin'), git);
    mergeRequestUrl = new LocalCodeHost(git, {
      repositoryPath: demo.path,
      projectPath: 'demo/loja',
      targetBranch: 'main',
    }).mergeRequestUrl(demo.mergeRequestIid);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('três noites', () => {
    let sharedDataDir: string;

    beforeAll(() => {
      sharedDataDir = freshDataDir();
    });

    it('noite 1: revisa com retentativas (transient e depois invalid-output)', async () => {
      const { application, result, events } = await night(sharedDataDir, {
        failures: [SimulatedFailure.Transient, SimulatedFailure.InvalidOutput],
      });
      const { paths, runId } = application;

      expect(result.aborted).toBeNull();
      expect(result.summary).toEqual({ total: 2, reviewed: 1, skipped: 1, failed: 0, pending: 0 });
      expect(result.outcomes).toEqual([
        {
          status: 'reviewed',
          taskId: 'DEMO-1',
          verdict: Verdict.ChangesRequested,
          reportPaths: [
            join(paths.reviews, 'DEMO-1', 'review.json'),
            join(paths.reviews, 'DEMO-1', 'review.md'),
          ],
        },
        { status: 'skipped', taskId: 'DEMO-2', reason: SkipReason.MissingMergeRequestLink },
      ]);

      // Os relatórios foram gravados, com o head realmente revisado.
      const report = JSON.parse(
        await readFile(join(paths.reviews, 'DEMO-1', 'review.json'), 'utf8'),
      ) as { mergeRequest: { headSha: string }; runId: string };
      expect(report).toMatchObject({ runId, mergeRequest: { headSha: demo.headSha } });
      expect(await readFile(join(paths.reviews, 'DEMO-1', 'review.md'), 'utf8')).toContain(
        '## Veredito: Mudanças solicitadas',
      );

      // As transcrições têm as 3 tentativas do motor.
      expect(await readdir(join(paths.transcripts, 'DEMO-1'))).toEqual([
        'attempt-1.error.json',
        'attempt-1.prompt.md',
        'attempt-2.prompt.md',
        'attempt-2.response.json',
        'attempt-3.prompt.md',
        'attempt-3.response.json',
      ]);

      // As retentativas ficaram no log, cada uma pelo seu tipo de erro.
      expect(
        events.filter((event) => event.type === 'retry.scheduled').map((event) => event.payload),
      ).toMatchObject([
        { command: 'run-review', attempt: 1, errorKind: ErrorKind.Transient },
        { command: 'run-review', attempt: 2, errorKind: ErrorKind.InvalidOutput },
      ]);

      // As oito etapas, na ordem, cada uma logada uma única vez.
      expect(commandsOf(events, 'command.succeeded')).toEqual([
        'fetch-pending-tasks',
        'resolve-merge-request',
        'fetch-changes',
        'prepare-workspace',
        'run-review',
        'write-reports',
        'mark-reviewed',
        'cleanup-workspace',
      ]);
      expect(typesOf(events).at(0)).toBe('run.started');
      expect(typesOf(events).at(-1)).toBe('run.finished');

      // O worktree foi removido, o estado foi marcado e o manifesto existe.
      expect(await readdir(join(sharedDataDir, 'worktrees', runId))).toEqual([]);
      const state = JSON.parse(
        await readFile(join(sharedDataDir, 'state', 'reviewed.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(Object.keys(state)).toEqual([`DEMO-1:${demo.headSha}`]);
      const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as RunManifest;
      expect(manifest.tasks.map((task) => task.status)).toEqual(['reviewed', 'skipped']);
      expect(manifest.summary).toEqual(result.summary);
    });

    it('noite 2: o mesmo head_sha é pulado, sem chamar a IA', async () => {
      const { application, result, events } = await night(sharedDataDir);

      expect(result.summary).toEqual({ total: 2, reviewed: 0, skipped: 2, failed: 0, pending: 0 });
      expect(result.outcomes).toEqual([
        { status: 'skipped', taskId: 'DEMO-1', reason: SkipReason.AlreadyReviewed },
        { status: 'skipped', taskId: 'DEMO-2', reason: SkipReason.MissingMergeRequestLink },
      ]);
      expect(commandsOf(events, 'command.succeeded')).toEqual([
        'fetch-pending-tasks',
        'resolve-merge-request',
      ]);
      expect(await exists(application.paths.transcripts)).toBe(false);
      expect(await exists(application.paths.reviews)).toBe(false);
    });

    it('noite 3: o limite da assinatura interrompe a execução e desfaz o worktree', async () => {
      const dataDir = freshDataDir();

      const { application, result, events } = await night(dataDir, {
        failures: [SimulatedFailure.RateLimit],
      });

      expect(result.aborted?.kind).toBe(ErrorKind.RateLimit);
      expect(exitCodeFor(result)).toBe(EXIT_CODE.aborted);
      expect(result.outcomes).toEqual([
        { status: 'pending', taskId: 'DEMO-1' },
        { status: 'pending', taskId: 'DEMO-2' },
      ]);
      expect(result.summary).toEqual({ total: 2, reviewed: 0, skipped: 0, failed: 0, pending: 2 });

      // run.aborted com as pendentes, e depois o run.finished com o resumo.
      expect(typesOf(events).slice(-2)).toEqual(['run.aborted', 'run.finished']);
      expect(events.find((event) => event.type === 'run.aborted')?.payload).toMatchObject({
        error: { kind: ErrorKind.RateLimit },
        pendingTaskIds: ['DEMO-1', 'DEMO-2'],
      });

      // O rollback removeu o worktree antes de a execução terminar.
      expect(commandsOf(events, 'command.undone')).toEqual(['prepare-workspace']);
      expect(await readdir(join(dataDir, 'worktrees', application.runId))).toEqual([]);

      // Nada foi gravado como revisado.
      expect(await exists(application.paths.reviews)).toBe(false);
      expect(await exists(join(dataDir, 'state', 'reviewed.json'))).toBe(false);
      const manifest = JSON.parse(await readFile(application.paths.manifest, 'utf8')) as RunManifest;
      expect(manifest.aborted?.pendingTaskIds).toEqual(['DEMO-1', 'DEMO-2']);
    });
  });

  it('--dry-run grava o prompt e não chama o motor', async () => {
    const dataDir = freshDataDir();

    const { application, result, events } = await night(dataDir, { dryRun: true });

    expect(result.outcomes[0]).toEqual({
      status: 'skipped',
      taskId: 'DEMO-1',
      reason: SkipReason.DryRun,
    });
    const prompt = await readFile(join(application.paths.prompts, 'DEMO-1.md'), 'utf8');
    expect(prompt).toContain('# System');
    expect(prompt).toContain('Aplicar desconto por cupom');
    expect(prompt).toContain('+  return Math.min(coupon / total, 0.5);');

    // Sem motor, sem worktree e sem marcação: a próxima execução revisa de verdade.
    expect(commandsOf(events, 'command.started')).not.toContain('run-review');
    expect(await exists(application.paths.transcripts)).toBe(false);
    expect(await exists(join(dataDir, 'worktrees'))).toBe(false);
    expect(await exists(join(dataDir, 'state', 'reviewed.json'))).toBe(false);
  });

  it('uma tarefa que falha não impede a seguinte', async () => {
    const tasks = [
      {
        id: 'OUTRO-HOST',
        title: 'Link de outro host',
        mergeRequestUrl: 'https://gitlab.com/demo/loja/-/merge_requests/1',
      },
      ...defaultTasks(),
    ];

    const { result } = await night(freshDataDir(), { tasks });

    expect(result.aborted).toBeNull();
    expect(exitCodeFor(result)).toBe(EXIT_CODE.ok);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'failed',
      'reviewed',
      'skipped',
    ]);
    expect(result.outcomes[0]).toMatchObject({ error: { kind: ErrorKind.InvalidInput } });
  });

  it('pula o MR cujo diff passa do limite, antes de criar o worktree', async () => {
    const dataDir = freshDataDir();

    const { result, events } = await night(dataDir, {
      settings: { limits: { maxDiffBytes: 10 } },
    });

    expect(result.outcomes[0]).toMatchObject({ reason: SkipReason.DiffTooLarge });
    expect(commandsOf(events, 'command.started')).not.toContain('prepare-workspace');
  });

  it('--task revisa só a tarefa pedida', async () => {
    const { result } = await night(freshDataDir(), { onlyTaskId: 'DEMO-2' });

    expect(result.outcomes).toEqual([
      { status: 'skipped', taskId: 'DEMO-2', reason: SkipReason.MissingMergeRequestLink },
    ]);
  });

  it('--task com uma tarefa que não está pendente é erro de configuração', async () => {
    const { result, events } = await night(freshDataDir(), { onlyTaskId: 'NAO-EXISTE' });

    expect(result.aborted?.kind).toBe(ErrorKind.Configuration);
    expect(exitCodeFor(result)).toBe(EXIT_CODE.configuration);
    expect(result.outcomes).toEqual([]);
    expect(typesOf(events).slice(-2)).toEqual(['run.aborted', 'run.finished']);
  });

  it('um estado corrompido interrompe a execução, em vez de revisar tudo de novo', async () => {
    const dataDir = freshDataDir();
    await mkdir(join(dataDir, 'state'), { recursive: true });
    await writeFile(join(dataDir, 'state', 'reviewed.json'), '{ corrompido');

    const { result, events } = await night(dataDir);

    expect(result.aborted?.kind).toBe(ErrorKind.Configuration);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['pending', 'pending']);
    expect(commandsOf(events, 'command.started')).not.toContain('run-review');
    expect(await readFile(join(dataDir, 'state', 'reviewed.json'), 'utf8')).toBe('{ corrompido');
  });

  it('keepWorkspaces mantém o worktree depois do review', async () => {
    const dataDir = freshDataDir();

    const { application, result, events } = await night(dataDir, {
      settings: { keepWorkspaces: true },
    });

    expect(result.outcomes[0]?.status).toBe('reviewed');
    expect(commandsOf(events, 'command.started')).not.toContain('cleanup-workspace');
    expect(await readdir(join(dataDir, 'worktrees', application.runId))).toEqual([
      'demo__loja__mr-1',
    ]);
  });

  it('retention.days apaga as execuções antigas antes de rodar', async () => {
    const dataDir = freshDataDir();
    await mkdir(join(dataDir, 'runs', '2020-01-01T00-00-00Z-aaaa'), { recursive: true });
    await mkdir(join(dataDir, 'runs', 'anotacoes'), { recursive: true });

    const { application, lines } = await night(dataDir, {
      settings: { retention: { days: 30 } },
    });

    expect((await readdir(join(dataDir, 'runs'))).sort()).toEqual(
      [application.runId, 'anotacoes'].sort(),
    );
    expect(lines[0]).toBe('1 execução(ões) com mais de 30 dia(s) removida(s)');
  });

  it('sem retention.days, nenhuma execução antiga é apagada', async () => {
    const dataDir = freshDataDir();
    await mkdir(join(dataDir, 'runs', '2020-01-01T00-00-00Z-aaaa'), { recursive: true });

    await night(dataDir);

    expect(await readdir(join(dataDir, 'runs'))).toContain('2020-01-01T00-00-00Z-aaaa');
  });

  it('mostra o andamento no terminal', async () => {
    const { lines } = await night(freshDataDir(), { failures: [SimulatedFailure.Transient] });

    const output = lines.join('\n');
    expect(output).toContain('Execução iniciada (provedor: fake, fonte: json-file)');
    expect(output).toContain('↻ run-review: tentativa 1 falhou (transient: Falha de rede simulada)');
    expect(output).toContain('veredito: changes_requested');
    expect(output).toContain('review.md');
    expect(output).toContain('1 revisada(s), 1 pulada(s), 0 com falha, 0 pendente(s)');
  });
});
