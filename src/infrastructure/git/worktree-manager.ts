import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodeHost } from '../../application/ports/code-host.js';
import type { Workspace, WorkspaceManager } from '../../application/ports/workspace-manager.js';
import { ConfigurationError, InvalidInputError, TransientError } from '../../domain/errors.js';
import type { AppError } from '../../domain/errors.js';
import type {
  ChangedFile,
  ChangedFileStatus,
  DiffContext,
  MergeRequestRef,
} from '../../domain/merge-request.js';
import { toPathSegment } from '../../shared/fs.js';

/** O git usa as credenciais de clone do usuário, mas nunca os tokens da aplicação. */
const APPLICATION_SECRETS = ['NOTION_TOKEN', 'GITLAB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** Sem pedido de senha interativo e sem baixar arquivos do LFS no checkout. */
const FORCED_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;

export interface GitClientOptions {
  readonly binary?: string;
  /** Ambiente herdado. Padrão: o do processo. */
  readonly baseEnv?: Environment;
  /** Variáveis acrescentadas ao ambiente herdado. */
  readonly env?: Readonly<Record<string, string>>;
}

interface GitResult {
  readonly error: ExecFileException | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Executa o git com `execFile` e lista de argumentos, sem shell: nenhum nome
 * de branch ou caminho é interpretado como comando.
 */
export class GitClient {
  private readonly binary: string;
  private readonly env: Environment;

  constructor(options: GitClientOptions = {}) {
    this.binary = options.binary ?? 'git';
    const inherited = Object.entries(options.baseEnv ?? process.env).filter(
      ([name]) => !APPLICATION_SECRETS.includes(name),
    );
    this.env = { ...Object.fromEntries(inherited), ...options.env, ...FORCED_ENV };
  }

  /** Roda o comando e devolve a saída. Lança se o git sair com erro. */
  async run(args: readonly string[], cwd?: string): Promise<string> {
    const result = await this.execute(args, cwd);
    if (result.error) throw this.failure(args, cwd, result);
    return result.stdout;
  }

  /** Para comandos cuja saída com erro é uma resposta: `true` se o git saiu com 0. */
  async check(args: readonly string[], cwd?: string): Promise<boolean> {
    const result = await this.execute(args, cwd);
    if (!result.error) return true;
    if (typeof result.error.code === 'number') return false;
    throw this.failure(args, cwd, result);
  }

  private execute(args: readonly string[], cwd?: string): Promise<GitResult> {
    return new Promise((resolve) => {
      execFile(
        this.binary,
        [...args],
        { cwd, env: this.env, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (error, stdout, stderr) => {
          resolve({ error, stdout, stderr });
        },
      );
    });
  }

  private failure(args: readonly string[], cwd: string | undefined, result: GitResult): AppError {
    const { error, stderr } = result;
    if (error?.code === 'ENOENT') {
      return new ConfigurationError(
        'Não foi possível executar o git: o binário ou o diretório não existe',
        { binary: this.binary, cwd },
        { cause: error },
      );
    }
    // Clone, fetch, diff e checkout num clone parcial podem todos tocar a rede.
    return new TransientError(
      `O comando git ${args[0] ?? ''} falhou`,
      { args, exitCode: error?.code ?? null, stderr: stderr.trim().slice(-2_000) },
      { cause: error },
    );
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames'];

export interface WorktreeManagerOptions {
  /** Onde ficam os clones base, reaproveitados entre execuções. */
  readonly reposDirectory: string;
  /** Raiz dos worktrees; cada execução usa uma subpasta com o seu `runId`. */
  readonly worktreesRoot: string;
  readonly runId: string;
}

/**
 * Mantém um clone parcial por projeto e cria um worktree por MR. O clone base
 * nunca tem checkout, e submódulos não são inicializados.
 */
export class WorktreeManager implements WorkspaceManager {
  constructor(
    private readonly git: GitClient,
    private readonly codeHost: Pick<CodeHost, 'cloneUrl' | 'mergeRequestRef'>,
    private readonly options: WorktreeManagerOptions,
  ) {}

  async fetchChanges(mr: MergeRequestRef): Promise<DiffContext> {
    assertMergeRequestId(mr.iid);
    assertSha(mr.diffRefs.baseSha, 'baseSha');
    assertSha(mr.diffRefs.headSha, 'headSha');
    await this.assertBranch(mr.targetBranch);
    const repository = await this.ensureRepository(mr.projectPath);

    const headRef = `refs/nightly-review/mr-${String(mr.iid)}/head`;
    const targetRef = `refs/nightly-review/mr-${String(mr.iid)}/target`;
    await this.git.run(
      [
        'fetch',
        '--no-tags',
        '--force',
        'origin',
        `+${this.codeHost.mergeRequestRef(mr.iid)}:${headRef}`,
        `+refs/heads/${mr.targetBranch}:${targetRef}`,
      ],
      repository,
    );

    // Se o MR recebeu um push depois da consulta à API, vale o head que veio no fetch.
    const headSha = await this.revision(`${headRef}^{commit}`, repository);
    const baseSha =
      headSha === mr.diffRefs.headSha
        ? mr.diffRefs.baseSha
        : (await this.git.run(['merge-base', targetRef, headSha], repository)).trim();

    const range = [baseSha, headSha, '--'];
    const patch = await this.git.run([...DIFF, ...range], repository);
    const nameStatus = await this.git.run([...DIFF, '--name-status', '-z', ...range], repository);
    const numstat = await this.git.run([...DIFF, '--numstat', '-z', ...range], repository);

    return {
      patch,
      files: parseChangedFiles(nameStatus, numstat),
      bytes: Buffer.byteLength(patch),
      baseSha,
      headSha,
    };
  }

  async prepare(mr: MergeRequestRef): Promise<Workspace> {
    assertMergeRequestId(mr.iid);
    assertSha(mr.diffRefs.headSha, 'headSha');
    const repository = await this.ensureRepository(mr.projectPath);
    const path = join(
      this.options.worktreesRoot,
      toPathSegment(this.options.runId),
      `${repositoryName(mr.projectPath)}__mr-${String(mr.iid)}`,
    );

    // Restos de uma tentativa anterior da mesma etapa.
    await this.removeWorktree(repository, path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.git.run(['worktree', 'add', '--detach', path, mr.diffRefs.headSha], repository);
    return { path, headSha: mr.diffRefs.headSha, repositoryPath: repository };
  }

  async dispose(workspace: Workspace): Promise<void> {
    await this.removeWorktree(workspace.repositoryPath, workspace.path);
  }

  /**
   * Roda no início da execução. Apaga os worktrees de execuções anteriores,
   * que só sobram quando uma execução cai no meio, e limpa os registros do git.
   */
  async pruneOrphans(options: { readonly removeStaleDirectories?: boolean } = {}): Promise<void> {
    const { reposDirectory, worktreesRoot, runId } = this.options;
    if (options.removeStaleDirectories ?? true) {
      for (const entry of await list(worktreesRoot)) {
        if (entry === toPathSegment(runId)) continue;
        await rm(join(worktreesRoot, entry), { recursive: true, force: true });
      }
    }
    for (const entry of await list(reposDirectory)) {
      await this.git.check(['worktree', 'prune'], join(reposDirectory, entry));
    }
  }

  private async ensureRepository(projectPath: string): Promise<string> {
    const repository = join(this.options.reposDirectory, repositoryName(projectPath));
    if (await exists(join(repository, 'HEAD'))) return repository;

    // Sem HEAD, o que houver na pasta é resto de um clone interrompido.
    await rm(repository, { recursive: true, force: true });
    await mkdir(this.options.reposDirectory, { recursive: true, mode: 0o700 });
    await this.git.run([
      'clone',
      '--bare',
      '--no-tags',
      '--filter=blob:none',
      '--',
      this.codeHost.cloneUrl(projectPath),
      repository,
    ]);
    return repository;
  }

  private async removeWorktree(repository: string, path: string): Promise<void> {
    if (await exists(path)) {
      const removed = await this.git.check(['worktree', 'remove', '--force', path], repository);
      if (!removed) await rm(path, { recursive: true, force: true });
    }
    await this.git.run(['worktree', 'prune'], repository);
  }

  private async assertBranch(branch: string): Promise<void> {
    const valid =
      !branch.startsWith('-') && (await this.git.check(['check-ref-format', '--branch', branch]));
    if (!valid) throw new InvalidInputError('Nome de branch inválido', { branch });
  }

  private async revision(name: string, repository: string): Promise<string> {
    return (await this.git.run(['rev-parse', '--verify', name], repository)).trim();
  }
}

function repositoryName(projectPath: string): string {
  return toPathSegment(projectPath.replaceAll('/', '__'));
}

function assertSha(value: string, field: string): void {
  if (!SHA_PATTERN.test(value)) {
    throw new InvalidInputError('SHA de commit inválido', { field, value });
  }
}

function assertMergeRequestId(iid: number): void {
  if (!Number.isSafeInteger(iid) || iid <= 0) {
    throw new InvalidInputError('Número de MR inválido', { iid });
  }
}

/** Junta as saídas de `--name-status -z` e `--numstat -z` numa lista de arquivos. */
function parseChangedFiles(nameStatus: string, numstat: string): ChangedFile[] {
  const counts = new Map<string, { additions: number; deletions: number }>();
  const stats = numstat.split('\0');
  for (let index = 0; index < stats.length; index += 1) {
    const [added, deleted, ...rest] = (stats[index] ?? '').split('\t');
    if (added === undefined || deleted === undefined || rest.length === 0) continue;
    let path = rest.join('\t');
    if (path === '') {
      // Renomeação: o caminho vem vazio, seguido do antigo e do novo.
      path = stats[index + 2] ?? '';
      index += 2;
    }
    counts.set(path, { additions: toCount(added), deletions: toCount(deleted) });
  }

  const files: ChangedFile[] = [];
  const entries = nameStatus.split('\0');
  for (let index = 0; index < entries.length; index += 1) {
    const code = entries[index];
    if (!code) continue;
    // Renomeação e cópia trazem dois caminhos; interessa o novo.
    if (code.startsWith('R') || code.startsWith('C')) index += 1;
    index += 1;
    const path = entries[index];
    if (!path) continue;
    files.push({
      path,
      status: toStatus(code),
      ...(counts.get(path) ?? { additions: 0, deletions: 0 }),
    });
  }
  return files;
}

/** Arquivos binários aparecem como `-` no numstat. */
function toCount(value: string): number {
  const count = Number.parseInt(value, 10);
  return Number.isNaN(count) ? 0 : count;
}

function toStatus(code: string): ChangedFileStatus {
  if (code.startsWith('A') || code.startsWith('C')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  return 'modified';
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function list(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}
