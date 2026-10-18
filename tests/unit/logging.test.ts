import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventBus } from '../../src/application/events/event-bus.js';
import {
  ErrorKind,
  ProviderKind,
  SkipReason,
  TaskSourceKind,
  Verdict,
} from '../../src/domain/enums.js';
import type { PipelineEvents } from '../../src/domain/events.js';
import {
  ConsoleReporter,
  JsonlEventLogger,
  RunManifestWriter,
  createRedactor,
} from '../../src/infrastructure/logging/observers.js';
import type { RunManifest } from '../../src/infrastructure/logging/observers.js';

const RUN_ID = '2026-10-12T05-55-00Z-k3x9';
const AT = '2026-10-12T05:55:04.120Z';
const TOKEN = 'glpat-segredo-de-teste-123';
const noRedaction = createRedactor([]);

function createBus(): EventBus<PipelineEvents> {
  return new EventBus<PipelineEvents>({ now: () => new Date(AT) });
}

const started: PipelineEvents['run.started'] = {
  startedAt: '2026-10-12T05:55:00.000Z',
  provider: ProviderKind.Fake,
  taskSource: TaskSourceKind.JsonFile,
  dryRun: false,
};

const failedWithToken: PipelineEvents['task.failed'] = {
  taskId: 't3',
  error: {
    name: 'ConfigurationError',
    kind: ErrorKind.Configuration,
    message: `GitLab recusou o token ${TOKEN}`,
  },
};

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nightly-review-logging-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('createRedactor', () => {
  it('troca cada segredo por [REDACTED]', () => {
    const redact = createRedactor(['abc123', 'xyz789']);

    expect(redact('token abc123 e xyz789, de novo abc123')).toBe(
      'token [REDACTED] e [REDACTED], de novo [REDACTED]',
    );
  });

  it('ignora segredos vazios ou ausentes', () => {
    const redact = createRedactor(['', undefined]);

    expect(redact('nada a esconder')).toBe('nada a esconder');
  });

  it('mascara primeiro o segredo mais longo', () => {
    const redact = createRedactor(['abc', 'abcdef']);

    expect(redact('abcdef')).toBe('[REDACTED]');
  });

  it('mascara o segredo também na forma escapada de um JSON', () => {
    const secret = 'se"gre\\do';
    const redact = createRedactor([secret]);

    expect(redact(JSON.stringify({ message: `token ${secret}` }))).toBe(
      '{"message":"token [REDACTED]"}',
    );
  });
});

describe('JsonlEventLogger', () => {
  it('grava uma linha de JSON por evento, com runId, tipo, horário e payload', () => {
    const filePath = join(directory, 'runs', RUN_ID, 'events.jsonl');
    const bus = createBus();
    new JsonlEventLogger(filePath, RUN_ID, noRedaction).attach(bus);

    bus.emit('command.started', { command: 'run-review', taskId: '1a2b' });
    bus.emit('retry.scheduled', {
      command: 'run-review',
      taskId: '1a2b',
      attempt: 1,
      delayMs: 0,
      errorKind: ErrorKind.InvalidOutput,
      message: 'A resposta não segue o schema',
    });
    bus.emit('command.succeeded', { command: 'run-review', taskId: '1a2b', durationMs: 393_432 });

    const content = readFileSync(filePath, 'utf8');
    const lines = content.trimEnd().split('\n');
    expect(content.endsWith('\n')).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      `{"runId":"${RUN_ID}","type":"command.started","at":"${AT}","payload":{"command":"run-review","taskId":"1a2b"}}`,
    );
    expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
      'command.started',
      'retry.scheduled',
      'command.succeeded',
    ]);
  });

  it('cria o arquivo com modo 600 e o diretório com 700', () => {
    const filePath = join(directory, 'runs', RUN_ID, 'events.jsonl');
    const bus = createBus();
    new JsonlEventLogger(filePath, RUN_ID, noRedaction).attach(bus);

    bus.emit('run.started', started);

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'runs', RUN_ID)).mode & 0o777).toBe(0o700);
  });

  it('mascara os segredos antes de gravar', () => {
    const filePath = join(directory, 'events.jsonl');
    const bus = createBus();
    new JsonlEventLogger(filePath, RUN_ID, createRedactor([TOKEN])).attach(bus);

    bus.emit('task.failed', failedWithToken);

    const content = readFileSync(filePath, 'utf8');
    expect(content).not.toContain(TOKEN);
    expect(content).toContain('GitLab recusou o token [REDACTED]');
  });

  it('para de gravar depois que a assinatura é cancelada', () => {
    const filePath = join(directory, 'events.jsonl');
    const bus = createBus();
    const detach = new JsonlEventLogger(filePath, RUN_ID, noRedaction).attach(bus);

    bus.emit('run.started', started);
    detach();
    bus.emit('tasks.fetched', { count: 0, taskIds: [] });

    expect(readFileSync(filePath, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('RunManifestWriter', () => {
  function readManifest(filePath: string): RunManifest {
    return JSON.parse(readFileSync(filePath, 'utf8')) as RunManifest;
  }

  it('grava no run.finished o resumo e o resultado de cada tarefa', () => {
    const filePath = join(directory, 'runs', RUN_ID, 'manifest.json');
    const bus = createBus();
    new RunManifestWriter(filePath, RUN_ID, noRedaction).attach(bus);
    const findingsBySeverity = { blocker: 0, major: 1, minor: 0, nit: 2 };
    const summary = { total: 4, reviewed: 1, skipped: 1, failed: 1, pending: 1 };

    bus.emit('run.started', started);
    bus.emit('tasks.fetched', { count: 4, taskIds: ['t1', 't2', 't3', 't4'] });
    bus.emit('task.started', { taskId: 't1', title: 'Aplicar desconto' });
    bus.emit('command.started', { command: 'run-review', taskId: 't1' });
    bus.emit('review.completed', {
      taskId: 't1',
      verdict: Verdict.ChangesRequested,
      findingsBySeverity,
      reportPaths: ['reviews/t1/review.json', 'reviews/t1/review.md'],
    });
    bus.emit('task.started', { taskId: 't2', title: 'Corrigir login' });
    bus.emit('task.skipped', { taskId: 't2', reason: SkipReason.AlreadyReviewed });
    bus.emit('task.started', { taskId: 't3', title: 'Exportar relatório' });
    bus.emit('task.failed', failedWithToken);
    expect(existsSync(filePath)).toBe(false);
    bus.emit('run.finished', { summary, durationMs: 4_120 });

    expect(readManifest(filePath)).toEqual({
      runId: RUN_ID,
      startedAt: '2026-10-12T05:55:00.000Z',
      finishedAt: AT,
      durationMs: 4_120,
      provider: 'fake',
      taskSource: 'json-file',
      dryRun: false,
      summary,
      aborted: null,
      tasks: [
        {
          taskId: 't1',
          title: 'Aplicar desconto',
          status: 'reviewed',
          verdict: 'changes_requested',
          findingsBySeverity,
          reportPaths: ['reviews/t1/review.json', 'reviews/t1/review.md'],
        },
        { taskId: 't2', title: 'Corrigir login', status: 'skipped', reason: 'already_reviewed' },
        { taskId: 't3', title: 'Exportar relatório', status: 'failed', error: failedWithToken.error },
        { taskId: 't4', title: null, status: 'pending' },
      ],
    });
    expect(readdirSync(join(directory, 'runs', RUN_ID))).toEqual(['manifest.json']);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('grava já no run.aborted, com o erro e as tarefas pendentes', () => {
    const filePath = join(directory, 'manifest.json');
    const bus = createBus();
    new RunManifestWriter(filePath, RUN_ID, noRedaction).attach(bus);
    const error = {
      name: 'RateLimitError',
      kind: ErrorKind.RateLimit,
      message: 'Limite da assinatura atingido',
    };

    bus.emit('run.started', started);
    bus.emit('tasks.fetched', { count: 2, taskIds: ['t1', 't2'] });
    bus.emit('run.aborted', { error, pendingTaskIds: ['t1', 't2'] });

    const manifest = readManifest(filePath);
    expect(manifest.aborted).toEqual({ at: AT, error, pendingTaskIds: ['t1', 't2'] });
    expect(manifest.finishedAt).toBeNull();
    expect(manifest.tasks.map((task) => task.status)).toEqual(['pending', 'pending']);
  });

  it('mascara os segredos no manifesto', () => {
    const filePath = join(directory, 'manifest.json');
    const bus = createBus();
    new RunManifestWriter(filePath, RUN_ID, createRedactor([TOKEN])).attach(bus);

    bus.emit('task.failed', failedWithToken);
    bus.emit('run.finished', {
      summary: { total: 1, reviewed: 0, skipped: 0, failed: 1, pending: 0 },
      durationMs: 10,
    });

    const content = readFileSync(filePath, 'utf8');
    expect(content).not.toContain(TOKEN);
    expect(content).toContain('[REDACTED]');
  });
});

describe('ConsoleReporter', () => {
  function report(emit: (bus: EventBus<PipelineEvents>) => void, secrets: string[] = []): string[] {
    const lines: string[] = [];
    const bus = createBus();
    new ConsoleReporter({
      write: (line) => lines.push(line),
      redact: createRedactor(secrets),
    }).attach(bus);
    emit(bus);
    return lines;
  }

  it('descreve o andamento em linhas legíveis', () => {
    const lines = report((bus) => {
      bus.emit('run.started', started);
      bus.emit('tasks.fetched', { count: 2, taskIds: ['t1', 't2'] });
      bus.emit('task.started', { taskId: 't1', title: 'Aplicar desconto' });
      bus.emit('command.started', { command: 'run-review', taskId: 't1' });
      bus.emit('retry.scheduled', {
        command: 'run-review',
        taskId: 't1',
        attempt: 1,
        delayMs: 2_000,
        errorKind: ErrorKind.Transient,
        message: 'rede indisponível',
      });
      bus.emit('command.succeeded', { command: 'run-review', taskId: 't1', durationMs: 850 });
      bus.emit('task.skipped', { taskId: 't2', reason: SkipReason.MergeRequestNotOpen });
      bus.emit('run.finished', {
        summary: { total: 2, reviewed: 1, skipped: 1, failed: 0, pending: 0 },
        durationMs: 61_500,
      });
    });

    expect(lines).toEqual([
      'Execução iniciada (provedor: fake, fonte: json-file)',
      '2 tarefa(s) em revisão',
      '▶ t1: Aplicar desconto',
      '  ↻ run-review: tentativa 1 falhou (transient: rede indisponível); nova tentativa em 2.0 s',
      '  ✓ run-review (850 ms)',
      '  pulada: o MR não está aberto',
      'Execução concluída em 61.5 s: 1 revisada(s), 1 pulada(s), 0 com falha, 0 pendente(s)',
    ]);
  });

  it('mostra o veredito, as contagens e o caminho dos relatórios', () => {
    const lines = report((bus) => {
      bus.emit('review.completed', {
        taskId: 't1',
        verdict: Verdict.Approve,
        findingsBySeverity: { blocker: 0, major: 0, minor: 1, nit: 0 },
        reportPaths: ['reviews/t1/review.md'],
      });
    });

    expect(lines).toEqual([
      '  veredito: approve | blocker 0, major 0, minor 1, nit 0\n  → reviews/t1/review.md',
    ]);
  });

  it('mascara os segredos no terminal', () => {
    const lines = report((bus) => {
      bus.emit('task.failed', failedWithToken);
    }, [TOKEN]);

    expect(lines).toEqual(['  falhou (configuration): GitLab recusou o token [REDACTED]']);
  });
});
