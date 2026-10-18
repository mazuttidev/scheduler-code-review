import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareDemoScenario } from '../../src/cli/demo-scenario.js';
import { EXIT_CODE, exitCodeFor, runCli } from '../../src/cli/program.js';
import type { CliIo } from '../../src/cli/program.js';
import { createRunId } from '../../src/composition-root.js';
import { AppConfig } from '../../src/config/app-config.js';
import { ConfigurationError, RateLimitError } from '../../src/domain/errors.js';

describe('CLI', () => {
  let parent: string;
  let lines: string[];
  let errors: string[];
  let io: CliIo;

  /** Grava um review.config.json offline (tarefas em JSON, repositório local). */
  async function offlineConfig(provider: string): Promise<{ path: string; dataDir: string }> {
    const scenario = await prepareDemoScenario(parent);
    const settings = { ...(scenario.source.readSettings() as object), provider: { kind: provider } };
    const path = join(scenario.root, 'review.config.json');
    await writeFile(path, JSON.stringify(settings));
    return { path, dataDir: join(scenario.root, 'data') };
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  beforeEach(async () => {
    AppConfig.resetForTesting();
    parent = await mkdtemp(join(tmpdir(), 'nightly-review-cli-'));
    lines = [];
    errors = [];
    io = {
      write: (line) => lines.push(line),
      writeError: (line) => errors.push(line),
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-de-teste' },
      demoParentDirectory: parent,
      sleep: () => Promise.resolve(),
    };
  });

  afterEach(async () => {
    AppConfig.resetForTesting();
    await rm(parent, { recursive: true, force: true });
  });

  describe('demo', () => {
    it('roda de ponta a ponta e mostra retentativas, veredito e os arquivos gerados', async () => {
      const exitCode = await runCli(['demo', '--simulate', 'transient,invalid-output'], io);

      const output = lines.join('\n');
      expect(exitCode).toBe(EXIT_CODE.ok);
      expect(errors).toEqual([]);
      expect(output).toContain('▶ DEMO-1: Aplicar desconto por cupom no carrinho');
      expect(output).toContain('tentativa 1 falhou (transient: Falha de rede simulada)');
      expect(output).toContain('tentativa 2 falhou (invalid_output:');
      expect(output).toContain('veredito: changes_requested | blocker 0, major 1, minor 1, nit 0');
      expect(output).toContain('pulada: a tarefa não tem link de MR');
      expect(output).toMatch(/→ .*\/reviews\/DEMO-1\/review\.md/);
      expect(output).toMatch(/Log de eventos: .*\/events\.jsonl/);
      expect(output).toMatch(/Manifesto: .*\/manifest\.json/);
    });

    it('mantém os arquivos da demonstração e solta o lock ao final', async () => {
      await runCli(['demo'], io);

      const [demoDirectory = ''] = await readdir(parent);
      const dataDir = join(parent, demoDirectory, 'data');
      const [runId = ''] = await readdir(join(dataDir, 'runs'));
      expect(await exists(join(dataDir, 'runs', runId, 'reviews', 'DEMO-1', 'review.md'))).toBe(true);
      expect(await exists(join(dataDir, 'run.lock'))).toBe(false);
    });

    it('sai com 2 quando a execução é interrompida pelo limite da assinatura', async () => {
      const exitCode = await runCli(['demo', '--simulate', 'rate-limit'], io);

      expect(exitCode).toBe(EXIT_CODE.aborted);
      expect(lines.join('\n')).toContain(
        'Execução interrompida: Limite da assinatura simulado. Tarefas pendentes: 2',
      );
    });

    it('sai com 1 para uma falha encenada desconhecida', async () => {
      const exitCode = await runCli(['demo', '--simulate', 'terremoto'], io);

      expect(exitCode).toBe(EXIT_CODE.configuration);
      expect(errors.join('\n')).toContain('Falha desconhecida: terremoto.');
      expect(await readdir(parent)).toEqual([]);
    });
  });

  describe('run', () => {
    it('sai com 1 quando o arquivo de configuração não existe', async () => {
      const config = join(parent, 'nao-existe.json');

      const exitCode = await runCli(['run', '--config', config], io);

      expect(exitCode).toBe(EXIT_CODE.configuration);
      expect(errors[0]).toBe('Erro: Não foi possível ler o arquivo de configuração');
    });

    it('sai com 1 quando falta um token exigido, sem criar a pasta de dados', async () => {
      const { path, dataDir } = await offlineConfig('claude');

      const exitCode = await runCli(['run', '--config', path], { ...io, env: {} });

      expect(exitCode).toBe(EXIT_CODE.configuration);
      expect(errors.join('\n')).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(await exists(dataDir)).toBe(false);
    });

    it('avisa quando a configuração pede uma integração que ainda não existe (Notion)', async () => {
      const { path, dataDir } = await offlineConfig('fake');
      const example = JSON.parse(
        await readFile(join(import.meta.dirname, '../../review.config.example.json'), 'utf8'),
      ) as { taskSource: unknown };
      const settings = JSON.parse(await readFile(path, 'utf8')) as object;
      await writeFile(path, JSON.stringify({ ...settings, taskSource: example.taskSource }));

      const exitCode = await runCli(['run', '--config', path], {
        ...io,
        env: { NOTION_TOKEN: 'notion-token-de-teste' },
      });

      expect(exitCode).toBe(EXIT_CODE.configuration);
      expect(errors[0]).toBe('Erro: Esta integração ainda não está disponível');
      expect(await exists(dataDir)).toBe(false);
    });

    it('termina sem fazer nada quando outra execução está em andamento', async () => {
      const { path, dataDir } = await offlineConfig('fake');
      await mkdir(dataDir, { recursive: true });
      // O processo pai do teste está vivo e não é este processo.
      await writeFile(
        join(dataDir, 'run.lock'),
        JSON.stringify({ pid: process.ppid, startedAt: '2026-10-12T05:55:00.000Z' }),
      );

      const exitCode = await runCli(['run', '--config', path], io);

      expect(exitCode).toBe(EXIT_CODE.ok);
      expect(lines).toEqual([
        `Outra execução já está em andamento (PID ${String(process.ppid)}). Nada a fazer.`,
      ]);
      expect(await exists(join(dataDir, 'runs'))).toBe(false);
      expect(await exists(join(dataDir, 'run.lock'))).toBe(true);
    });

    it.each([
      ['--limit', 'zero'],
      ['--limit', '0'],
      ['--provider', 'gpt'],
    ])('sai com 1 para %s %s', async (flag, value) => {
      expect(await runCli(['run', flag, value], io)).toBe(EXIT_CODE.configuration);
    });
  });

  describe('tasks', () => {
    it('lista as tarefas em revisão, sem revisar', async () => {
      const { path, dataDir } = await offlineConfig('fake');

      const exitCode = await runCli(['tasks', '--config', path], io);

      expect(exitCode).toBe(EXIT_CODE.ok);
      expect(lines).toEqual([
        'DEMO-1  Aplicar desconto por cupom no carrinho  http://local.nightly-review.test/demo/loja/-/merge_requests/1',
        'DEMO-2  Exportar o pedido em PDF  (sem link de MR)',
        '2 tarefa(s) em revisão',
      ]);
      expect(await exists(join(dataDir, 'runs'))).toBe(false);
    });
  });

  it('--help sai com 0 e lista os subcomandos', async () => {
    const exitCode = await runCli(['--help'], io);

    expect(exitCode).toBe(EXIT_CODE.ok);
    expect(lines.join('\n')).toMatch(/run[\s\S]*tasks[\s\S]*demo/);
  });
});

describe('exitCodeFor', () => {
  it('0 quando a execução chega ao fim, mesmo com tarefas que falharam', () => {
    expect(exitCodeFor({ aborted: null })).toBe(0);
  });

  it('1 quando um erro de configuração interrompe a execução', () => {
    expect(exitCodeFor({ aborted: new ConfigurationError('token recusado') })).toBe(1);
  });

  it('2 quando a execução é interrompida por outro motivo', () => {
    expect(exitCodeFor({ aborted: new RateLimitError('limite da assinatura') })).toBe(2);
  });
});

describe('createRunId', () => {
  it('gera um identificador ordenável, com o horário e um sufixo sorteado', () => {
    const now = new Date('2026-10-12T05:55:00.123Z');

    expect(createRunId(now, () => 0)).toBe('2026-10-12T05-55-00Z-0000');
    expect(createRunId(now, () => 0.999_999_9)).toBe('2026-10-12T05-55-00Z-zzzz');
    expect(createRunId(now, () => 0.5)).toMatch(/^2026-10-12T05-55-00Z-[0-9a-z]{4}$/);
  });
});
