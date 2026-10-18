import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prepareDemoScenario } from '../../src/cli/demo-scenario.js';

/**
 * Roda o `scripts/nightly.sh` de verdade, como o agendador faria, mas com
 * `HOME`, configuração e arquivo de ambiente temporários. A execução é
 * offline: tarefas em JSON, repositório local e provedor falso.
 */

const PROJECT_ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'nightly.sh');
const SYSTEM_PATH = '/usr/bin:/bin';

function execute(file: string, args: string[], options: object): Promise<number> {
  return new Promise((resolve) => {
    execFile(file, args, options, (error) => {
      resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : 1);
    });
  });
}

describe('scripts/nightly.sh', () => {
  let parent: string;
  let home: string;
  let dataDir: string;
  let logPath: string;
  let env: Record<string, string>;

  function runScript(script = SCRIPT, extra: Record<string, string> = {}): Promise<number> {
    return execute('/bin/bash', [script], { env: { ...env, ...extra } });
  }

  beforeAll(async () => {
    // O script roda o que está em dist/.
    const tsc = join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const built = await execute(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
      cwd: PROJECT_ROOT,
    });
    expect(built).toBe(0);

    parent = await mkdtemp(join(tmpdir(), 'nightly-review-script-'));
    home = join(parent, 'home');
    await mkdir(home);
    const scenario = await prepareDemoScenario(parent);
    const configPath = join(scenario.root, 'review.config.json');
    await writeFile(configPath, JSON.stringify(scenario.source.readSettings()));
    dataDir = join(scenario.root, 'data');
    logPath = join(home, '.nightly-review', 'logs', 'cron.log');
    env = {
      HOME: home,
      PATH: SYSTEM_PATH,
      NIGHTLY_REVIEW_PATH: `${dirname(process.execPath)}:${SYSTEM_PATH}`,
      NIGHTLY_REVIEW_CONFIG: configPath,
      NIGHTLY_REVIEW_ENV_FILE: join(parent, 'nao-existe.env'),
    };
  }, 120_000);

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('é executável e passa na checagem de sintaxe do bash', async () => {
    expect((await stat(SCRIPT)).mode & 0o111).not.toBe(0);
    expect(await execute('/bin/bash', ['-n', SCRIPT], {})).toBe(0);
  });

  it('roda a execução e escreve em logs/cron.log, sem nada no terminal', async () => {
    const exitCode = await runScript();

    const log = await readFile(logPath, 'utf8');
    expect(exitCode).toBe(0);
    expect(log).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] nightly-review: início\n/);
    expect(log).toContain('veredito: needs_discussion');
    expect(log).toContain('Execução concluída');
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);

    const [runId = ''] = await readdir(join(dataDir, 'runs'));
    expect(runId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-z]{4}$/);
    expect(await readdir(join(dataDir, 'runs', runId))).toEqual(
      expect.arrayContaining(['events.jsonl', 'manifest.json', 'reviews', 'transcripts']),
    );
    expect(existsSync(join(dataDir, 'run.lock'))).toBe(false);
  });

  it('acrescenta ao mesmo log na execução seguinte, que pula o que já foi revisado', async () => {
    const exitCode = await runScript();

    const log = await readFile(logPath, 'utf8');
    expect(exitCode).toBe(0);
    expect(log.match(/nightly-review: início/g)).toHaveLength(2);
    expect(log).toContain('pulada: este head_sha já foi revisado');
    expect(await readdir(join(dataDir, 'runs'))).toHaveLength(2);
  });

  it('sai com erro e explica no log quando o Node é mais antigo que o 22', async () => {
    const oldNode = join(parent, 'node-antigo');
    await mkdir(oldNode);
    await writeFile(
      join(oldNode, 'node'),
      '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 20; else echo v20.17.0; fi\n',
    );
    await chmod(join(oldNode, 'node'), 0o755);
    const logDir = join(parent, 'logs-node-antigo');

    const exitCode = await runScript(SCRIPT, {
      NIGHTLY_REVIEW_PATH: `${oldNode}:${SYSTEM_PATH}`,
      NIGHTLY_REVIEW_LOG_DIR: logDir,
    });

    expect(exitCode).toBe(1);
    expect(await readFile(join(logDir, 'cron.log'), 'utf8')).toContain(
      'nightly-review: é preciso Node.js 22 ou superior (encontrado: v20.17.0)',
    );
  });

  it.skipIf(existsSync('/usr/bin/node') || existsSync('/bin/node'))(
    'sai com erro quando não há node no PATH',
    async () => {
      const logDir = join(parent, 'logs-sem-node');

      const exitCode = await runScript(SCRIPT, {
        NIGHTLY_REVIEW_PATH: SYSTEM_PATH,
        NIGHTLY_REVIEW_LOG_DIR: logDir,
      });

      expect(exitCode).toBe(1);
      expect(await readFile(join(logDir, 'cron.log'), 'utf8')).toContain(
        'nightly-review: node não encontrado no PATH',
      );
    },
  );

  it('sai com erro e pede o build quando dist/ não existe', async () => {
    // Uma cópia do script numa árvore sem dist/.
    const copy = join(parent, 'sem-build', 'scripts', 'nightly.sh');
    await mkdir(dirname(copy), { recursive: true });
    await cp(SCRIPT, copy);
    const logDir = join(parent, 'logs-sem-build');

    const exitCode = await runScript(copy, { NIGHTLY_REVIEW_LOG_DIR: logDir });

    expect(exitCode).toBe(1);
    expect(await readFile(join(logDir, 'cron.log'), 'utf8')).toContain(
      'nightly-review: dist/cli/index.js não existe; rode npm run build',
    );
  });
});
