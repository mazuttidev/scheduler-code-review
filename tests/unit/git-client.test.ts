import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ErrorKind } from '../../src/domain/enums.js';
import { ConfigurationError, TransientError } from '../../src/domain/errors.js';
import { isolatedGitClient } from '../../src/infrastructure/git/demo-repository.js';
import { GitClient } from '../../src/infrastructure/git/worktree-manager.js';

/** Usa o próprio Node como "binário", para inspecionar o que o processo filho recebe. */
function nodeClient(baseEnv: Record<string, string | undefined>, env?: Record<string, string>) {
  return new GitClient({ binary: process.execPath, baseEnv, env });
}

const PRINT_ENV = ['-e', 'process.stdout.write(JSON.stringify(process.env))'];
const PRINT_ARGS = ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'];

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Esperava uma rejeição');
}

describe('GitClient', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nightly-review-git-client-'));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('herda o ambiente, mas não entrega os tokens da aplicação ao git', async () => {
    const client = nodeClient({
      PATH: process.env.PATH,
      HTTPS_PROXY: 'http://proxy.example.com:3128',
      NOTION_TOKEN: 'notion-token-de-teste',
      GITLAB_TOKEN: 'gitlab-token-de-teste',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-de-teste',
    });

    const env = JSON.parse(await client.run(PRINT_ENV)) as Record<string, string>;

    expect(env.HTTPS_PROXY).toBe('http://proxy.example.com:3128');
    expect(env).not.toHaveProperty('NOTION_TOKEN');
    expect(env).not.toHaveProperty('GITLAB_TOKEN');
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('sempre desliga o pedido de senha e o download do LFS', async () => {
    const client = nodeClient(
      { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '1' },
      { GIT_LFS_SKIP_SMUDGE: '0', GIT_AUTHOR_NAME: 'demo' },
    );

    const env = JSON.parse(await client.run(PRINT_ENV)) as Record<string, string>;

    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe('1');
    expect(env.GIT_AUTHOR_NAME).toBe('demo');
  });

  it('passa os argumentos sem shell: nada é interpretado como comando', async () => {
    const hostile = ['$(touch invadido)', '; rm -rf /', '`id`', 'a b'];

    const received = JSON.parse(
      await nodeClient({ PATH: process.env.PATH }).run([...PRINT_ARGS, ...hostile], directory),
    ) as string[];

    expect(received).toEqual(hostile);
  });

  it('transforma a falha de um comando em TransientError, com a saída de erro', async () => {
    const error = await rejection(isolatedGitClient().run(['rev-parse', '--verify', 'HEAD'], directory));

    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({
      kind: ErrorKind.Transient,
      message: 'O comando git rev-parse falhou',
      details: { args: ['rev-parse', '--verify', 'HEAD'], exitCode: 128 },
    });
    expect(JSON.stringify((error as TransientError).details)).toContain('not a git repository');
  });

  it('transforma o binário ausente em ConfigurationError', async () => {
    const client = new GitClient({ binary: 'git-que-nao-existe' });

    await expect(client.run(['--version'])).rejects.toBeInstanceOf(ConfigurationError);
    await expect(client.check(['--version'])).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('check devolve true ou false conforme o código de saída', async () => {
    const client = isolatedGitClient();

    expect(await client.check(['check-ref-format', '--branch', 'feature/desconto'])).toBe(true);
    expect(await client.check(['check-ref-format', '--branch', 'main..outra'])).toBe(false);
  });
});
