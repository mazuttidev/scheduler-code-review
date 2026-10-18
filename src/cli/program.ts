import { Command, CommanderError, InvalidArgumentError } from 'commander';

import type { RunResult } from '../application/pipeline/review-pipeline.js';
import { composeApplication } from '../composition-root.js';
import type { Application } from '../composition-root.js';
import { fileConfigSource } from '../config/app-config.js';
import type { SettingsOverrides } from '../config/app-config.js';
import { ErrorKind, ProviderKind } from '../domain/enums.js';
import { toAppError } from '../domain/errors.js';
import { SimulatedFailure } from '../infrastructure/providers/fake/fake-provider-factory.js';

import { prepareDemoScenario } from './demo-scenario.js';

/** Códigos de saída: 0 sucesso, 1 erro de configuração ou de uso, 2 execução interrompida. */
export const EXIT_CODE = { ok: 0, configuration: 1, aborted: 2 } as const;

export interface CliIo {
  readonly write: (line: string) => void;
  readonly writeError: (line: string) => void;
  /** Ambiente de onde vêm os tokens. Padrão: o do processo. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Onde criar a pasta da demonstração. Padrão: a pasta temporária do sistema. */
  readonly demoParentDirectory?: string;
  /** Espera entre retentativas; os testes injetam uma que não dorme. */
  readonly sleep?: (ms: number) => Promise<unknown>;
}

const DEFAULT_IO: CliIo = {
  write: (line) => process.stdout.write(`${line}\n`),
  writeError: (line) => process.stderr.write(`${line}\n`),
};

interface RunFlags {
  readonly config: string;
  readonly limit?: number;
  readonly task?: string;
  readonly dryRun?: boolean;
  readonly provider?: ProviderKind;
}

interface TasksFlags {
  readonly config: string;
}

interface DemoFlags {
  readonly simulate?: readonly SimulatedFailure[];
}

/** Interpreta os argumentos, executa o subcomando e devolve o código de saída. */
export async function runCli(argv: readonly string[], io: CliIo = DEFAULT_IO): Promise<number> {
  let exitCode: number = EXIT_CODE.ok;
  const program = new Command('nightly-review')
    .description('Automação noturna de code review')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        io.write(text.trimEnd());
      },
      writeErr: (text) => {
        io.writeError(text.trimEnd());
      },
    });

  program
    .command('run')
    .description('Revisa as tarefas em revisão')
    .option('--config <caminho>', 'arquivo de configuração', 'review.config.json')
    .option('--limit <n>', 'máximo de tarefas nesta execução', parsePositiveInteger)
    .option('--task <id>', 'revisa só esta tarefa')
    .option('--dry-run', 'grava o prompt de cada tarefa e não chama a IA')
    .option('--provider <tipo>', `provedor de IA (${Object.values(ProviderKind).join(' ou ')})`, parseProvider)
    .action(async (flags: RunFlags) => {
      exitCode = await runReviews(flags, io);
    });

  program
    .command('tasks')
    .description('Lista as tarefas em revisão, sem revisar')
    .option('--config <caminho>', 'arquivo de configuração', 'review.config.json')
    .action(async (flags: TasksFlags) => {
      exitCode = await listTasks(flags, io);
    });

  program
    .command('demo')
    .description('Execução completa offline, com repositório temporário e provedor falso')
    .option(
      '--simulate <falhas>',
      `falhas a encenar, separadas por vírgula (${Object.values(SimulatedFailure).join(', ')})`,
      parseSimulatedFailures,
    )
    .action(async (flags: DemoFlags) => {
      exitCode = await runDemo(flags, io);
    });

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help e --version saem com 0; erro de uso já foi escrito pelo commander.
      return error.exitCode === 0 ? EXIT_CODE.ok : EXIT_CODE.configuration;
    }
    return reportFailure(error, io);
  }
}

async function runReviews(flags: RunFlags, io: CliIo): Promise<number> {
  const overrides: SettingsOverrides = {
    ...(flags.limit === undefined ? {} : { limits: { maxTasksPerRun: flags.limit } }),
    ...(flags.provider === undefined ? {} : { provider: { kind: flags.provider } }),
  };
  const application = await composeApplication(
    fileConfigSource(flags.config, io.env ?? process.env),
    overrides,
    {
      dryRun: flags.dryRun ?? false,
      write: io.write,
      reportError: io.writeError,
      sleep: io.sleep,
      ...(flags.task === undefined ? {} : { onlyTaskId: flags.task }),
    },
  );
  return execute(application, io);
}

async function listTasks(flags: TasksFlags, io: CliIo): Promise<number> {
  const application = await composeApplication(
    fileConfigSource(flags.config, io.env ?? process.env),
    {},
    { write: io.write, reportError: io.writeError },
  );
  const tasks = await application.listPendingTasks();
  for (const task of tasks) {
    io.write(`${task.id}  ${task.title}  ${task.mergeRequestUrl ?? '(sem link de MR)'}`);
  }
  io.write(`${String(tasks.length)} tarefa(s) em revisão`);
  return EXIT_CODE.ok;
}

async function runDemo(flags: DemoFlags, io: CliIo): Promise<number> {
  const scenario = await prepareDemoScenario(io.demoParentDirectory);
  io.write(`Demonstração offline em ${scenario.root}`);
  const application = await composeApplication(
    scenario.source,
    {},
    {
      fake: { failures: flags.simulate ?? [], output: scenario.output },
      git: scenario.git,
      write: io.write,
      reportError: io.writeError,
      sleep: io.sleep,
    },
  );
  return execute(application, io);
}

/** Roda o pipeline sob o lock e traduz o resultado em código de saída. */
async function execute(application: Application, io: CliIo): Promise<number> {
  const { lock, paths } = application;
  if (!lock.acquire()) {
    const pid = lock.holder()?.pid;
    io.write(
      `Outra execução já está em andamento${pid === undefined ? '' : ` (PID ${String(pid)})`}. Nada a fazer.`,
    );
    return EXIT_CODE.ok;
  }

  const onSignal = (): void => {
    lock.release();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await application.run();
    io.write(`Relatórios: ${paths.reviews}`);
    io.write(`Log de eventos: ${paths.events}`);
    io.write(`Manifesto: ${paths.manifest}`);
    return exitCodeFor(result);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    lock.release();
  }
}

/** Tarefas que falharam não mudam a saída: elas ficam no manifesto e no log. */
export function exitCodeFor(result: Pick<RunResult, 'aborted'>): number {
  if (result.aborted === null) return EXIT_CODE.ok;
  return result.aborted.kind === ErrorKind.Configuration
    ? EXIT_CODE.configuration
    : EXIT_CODE.aborted;
}

function reportFailure(thrown: unknown, io: CliIo): number {
  const error = toAppError(thrown);
  io.writeError(`Erro: ${error.message}`);
  if (Object.keys(error.details).length > 0) io.writeError(JSON.stringify(error.details, null, 2));
  return EXIT_CODE.configuration;
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new InvalidArgumentError('Informe um inteiro positivo.');
  return Number(value);
}

function parseProvider(value: string): ProviderKind {
  const kind = findEnumValue(Object.values(ProviderKind), value);
  if (kind === undefined) throw new InvalidArgumentError('Provedor desconhecido.');
  return kind;
}

function parseSimulatedFailures(value: string): SimulatedFailure[] {
  return value.split(',').map((name) => {
    const failure = findEnumValue(Object.values(SimulatedFailure), name.trim());
    if (failure === undefined) throw new InvalidArgumentError(`Falha desconhecida: ${name}.`);
    return failure;
  });
}

/** Estreita um texto da linha de comando para o valor do enum correspondente. */
function findEnumValue<T extends string>(values: readonly T[], text: string): T | undefined {
  return values.find((candidate) => candidate === text);
}
