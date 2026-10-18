import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { CommandDecoration } from './application/commands/command.js';
import { LoggingCommand, RetryingCommand } from './application/decorators/command-decorators.js';
import { EventBus } from './application/events/event-bus.js';
import { ReviewPipeline } from './application/pipeline/review-pipeline.js';
import type { RunResult } from './application/pipeline/review-pipeline.js';
import type { CodeHost } from './application/ports/code-host.js';
import type { ReviewProviderFactory } from './application/ports/review-provider.js';
import type { TaskSource } from './application/ports/task-source.js';
import { ErrorKindRetryPolicy, defaultRetryPolicies } from './application/retry/retry-policy.js';
import { AppConfig, fileConfigSource } from './config/app-config.js';
import type { ConfigSource, Secrets, Settings, SettingsOverrides } from './config/app-config.js';
import { CodeHostKind, ProviderKind, TaskSourceKind } from './domain/enums.js';
import { ConfigurationError, toAppError } from './domain/errors.js';
import type { PipelineEvents } from './domain/events.js';
import { reviewOutputJsonSchema } from './domain/review-output.js';
import type { ReviewTask } from './domain/review-task.js';
import { LocalCodeHost } from './infrastructure/code-hosts/local-code-host.js';
import { GitClient, WorktreeManager } from './infrastructure/git/worktree-manager.js';
import { RunLock } from './infrastructure/lock/run-lock.js';
import {
  ConsoleReporter,
  JsonlEventLogger,
  RunManifestWriter,
  createRedactor,
} from './infrastructure/logging/observers.js';
import { ClaudeProviderFactory } from './infrastructure/providers/claude/claude-provider-factory.js';
import { FakeProviderFactory } from './infrastructure/providers/fake/fake-provider-factory.js';
import type { FakeProviderSettings } from './infrastructure/providers/fake/fake-provider-factory.js';
import { TranscriptRecordingEngine } from './infrastructure/providers/transcript-recording-engine.js';
import { REPORT_WRITERS } from './infrastructure/reports/file-report-writers.js';
import { pruneOldRuns } from './infrastructure/retention/run-retention.js';
import { JsonFileStateStore } from './infrastructure/state/json-file-state-store.js';
import { JsonFileTaskSource } from './infrastructure/task-sources/json-file-task-source.js';
import { assertNever } from './shared/types.js';
import type { DeepReadonly } from './shared/types.js';

/**
 * Raiz de composição: o único lugar que conhece as classes concretas e chama
 * `AppConfig.load()`. Aqui os nove padrões são ligados uns aos outros.
 */

/** Pasta do `package.json`. Vale para `src/` (tsx) e para `dist/` (build). */
const APPLICATION_ROOT = join(import.meta.dirname, '..');

export interface ApplicationOptions {
  readonly dryRun?: boolean;
  /** Revisa só esta tarefa (`--task`). */
  readonly onlyTaskId?: string;
  /** Roteiro do provedor falso: falhas encenadas e review devolvido. */
  readonly fake?: FakeProviderSettings;
  /** Destino das linhas do terminal. Padrão: a saída padrão. */
  readonly write?: (line: string) => void;
  readonly reportError?: (line: string) => void;
  readonly git?: GitClient;
  readonly sleep?: (ms: number) => Promise<unknown>;
  readonly now?: () => Date;
  readonly random?: () => number;
}

export interface Application {
  readonly runId: string;
  readonly runDirectory: string;
  readonly paths: {
    readonly events: string;
    readonly manifest: string;
    readonly reviews: string;
    readonly transcripts: string;
    readonly prompts: string;
  };
  readonly lock: RunLock;
  /** Lista as tarefas em revisão, sem revisar. */
  listPendingTasks(): Promise<readonly ReviewTask[]>;
  /** Limpa os restos de execuções anteriores e roda o pipeline. */
  run(): Promise<RunResult>;
}

/** Carrega a configuração (Singleton) e monta a aplicação. */
export async function composeApplication(
  source: ConfigSource = fileConfigSource(),
  overrides: SettingsOverrides = {},
  options: ApplicationOptions = {},
): Promise<Application> {
  const config = AppConfig.load(source, overrides);
  return buildApplication(config.settings, config.secrets, options);
}

/** Monta a aplicação a partir de uma configuração já validada. */
export async function buildApplication(
  settings: DeepReadonly<Settings>,
  secrets: Readonly<Secrets>,
  options: ApplicationOptions = {},
): Promise<Application> {
  const now = options.now ?? (() => new Date());
  const runId = createRunId(now(), options.random ?? (() => Math.random()));
  const { dataDir } = settings;
  const runDirectory = join(dataDir, 'runs', runId);
  const paths = {
    events: join(runDirectory, 'events.jsonl'),
    manifest: join(runDirectory, 'manifest.json'),
    reviews: join(runDirectory, 'reviews'),
    transcripts: join(runDirectory, 'transcripts'),
    prompts: join(runDirectory, 'prompts'),
  };

  const redact = createRedactor(Object.values(secrets));
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const reportError = options.reportError ?? ((line) => process.stderr.write(`${line}\n`));

  // Observer: um Subject e três observadores, que o pipeline não conhece.
  const bus = new EventBus<PipelineEvents>({
    now,
    onListenerError: (error, type) => {
      reportError(`Um observador falhou em ${type}: ${toAppError(error).message}`);
    },
  });
  new JsonlEventLogger(paths.events, runId, redact).attach(bus);
  new RunManifestWriter(paths.manifest, runId, redact).attach(bus);
  new ConsoleReporter({ write, redact }).attach(bus);

  // Decorator + Strategy: uma única função decora qualquer comando, nesta ordem.
  const retryPolicy = new ErrorKindRetryPolicy(defaultRetryPolicies());
  const decorate: CommandDecoration = (command) =>
    new LoggingCommand(new RetryingCommand(command, retryPolicy, bus, options.sleep), bus);

  // Adapter: as plataformas externas atrás das portas.
  const git = options.git ?? new GitClient();
  const codeHost = createCodeHost(settings.codeHost, git);
  const taskSource = createTaskSource(settings.taskSource);
  const workspaces = new WorktreeManager(git, codeHost, {
    reposDirectory: join(dataDir, 'repos'),
    worktreesRoot: join(dataDir, 'worktrees'),
    runId,
  });

  // Abstract Factory: trocar de IA é trocar esta fábrica.
  const provider = createProvider(settings.provider, secrets, options.fake);

  const [systemRules, instructions] = await Promise.all([
    readPrompt(settings.prompts.systemPath),
    readPrompt(settings.prompts.instructionsPath),
  ]);

  // Só cria a pasta de dados depois de saber que a configuração é utilizável.
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const pipeline = new ReviewPipeline({
    runId,
    taskSource,
    codeHost,
    workspaces,
    provider,
    decorateEngine: (engine) => new TranscriptRecordingEngine(engine, paths.transcripts, redact),
    // Factory Method: um writer por formato configurado.
    reportWriters: settings.outputs.map((format) => REPORT_WRITERS[format](redact)),
    state: new JsonFileStateStore(join(dataDir, 'state', 'reviewed.json')),
    events: bus,
    decorate,
    prompt: { systemRules, instructions, outputSchema: reviewOutputJsonSchema() },
    limits: settings.limits,
    paths: { reviewsDirectory: paths.reviews, promptsDirectory: paths.prompts },
    options: {
      dryRun: options.dryRun ?? false,
      keepWorkspaces: settings.keepWorkspaces,
      timeoutMs: settings.provider.timeoutMs,
      ...(options.onlyTaskId === undefined ? {} : { onlyTaskId: options.onlyTaskId }),
    },
    redact,
    now,
  });

  return {
    runId,
    runDirectory,
    paths,
    lock: new RunLock(join(dataDir, 'run.lock')),
    listPendingTasks: () => taskSource.fetchPending(settings.limits.maxTasksPerRun),
    async run() {
      const { days } = settings.retention;
      if (days !== undefined) {
        const removed = await pruneOldRuns(join(dataDir, 'runs'), { days, now: now(), keep: runId });
        if (removed.length > 0) {
          write(`${String(removed.length)} execução(ões) com mais de ${String(days)} dia(s) removida(s)`);
        }
      }
      await workspaces.pruneOrphans({ removeStaleDirectories: !settings.keepWorkspaces });
      return pipeline.run();
    },
  };
}

/** Identificador ordenável da execução, como `2026-10-12T05-55-00Z-k3x9`. */
export function createRunId(now: Date, random: () => number): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${stamp}Z-${suffix}`;
}

function createCodeHost(settings: DeepReadonly<Settings>['codeHost'], git: GitClient): CodeHost {
  switch (settings.kind) {
    case CodeHostKind.Local:
      return new LocalCodeHost(git, {
        repositoryPath: settings.repositoryPath,
        projectPath: settings.projectPath,
        targetBranch: settings.targetBranch,
      });
    case CodeHostKind.GitLab:
      throw notImplemented('codeHost', settings.kind);
    default:
      return assertNever(settings);
  }
}

function createTaskSource(settings: DeepReadonly<Settings>['taskSource']): TaskSource {
  switch (settings.kind) {
    case TaskSourceKind.JsonFile:
      return new JsonFileTaskSource(settings.jsonFile.path);
    case TaskSourceKind.Notion:
      throw notImplemented('taskSource', settings.kind);
    default:
      return assertNever(settings);
  }
}

function createProvider(
  settings: DeepReadonly<Settings>['provider'],
  secrets: Readonly<Secrets>,
  fake?: FakeProviderSettings,
): ReviewProviderFactory {
  switch (settings.kind) {
    case ProviderKind.Fake:
      return new FakeProviderFactory(fake);
    case ProviderKind.Claude: {
      if (secrets.claudeOauthToken === undefined) {
        throw new ConfigurationError('Variáveis de ambiente obrigatórias ausentes', {
          missing: ['CLAUDE_CODE_OAUTH_TOKEN'],
        });
      }
      return new ClaudeProviderFactory({
        oauthToken: secrets.claudeOauthToken,
        maxTurns: settings.maxTurns,
        ...(settings.model === undefined ? {} : { model: settings.model }),
      });
    }
    default:
      return assertNever(settings.kind);
  }
}

/** Os adapters do Notion e do GitLab ainda não foram implementados (fase 8a e 8b). */
function notImplemented(setting: string, kind: string): ConfigurationError {
  return new ConfigurationError('Esta integração ainda não está disponível', { setting, kind });
}

async function readPrompt(path: string): Promise<string> {
  const resolved = isAbsolute(path) ? path : join(APPLICATION_ROOT, path);
  try {
    return await readFile(resolved, 'utf8');
  } catch (cause) {
    throw new ConfigurationError(
      'Não foi possível ler o arquivo de prompt',
      { path: resolved },
      { cause },
    );
  }
}
