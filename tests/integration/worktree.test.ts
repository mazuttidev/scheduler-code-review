import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InvalidInputError } from '../../src/domain/errors.js';
import type { MergeRequestRef } from '../../src/domain/merge-request.js';
import { LocalCodeHost } from '../../src/infrastructure/code-hosts/local-code-host.js';
import {
  createDemoRepository,
  isolatedGitClient,
} from '../../src/infrastructure/git/demo-repository.js';
import type { DemoRepository } from '../../src/infrastructure/git/demo-repository.js';
import { WorktreeManager } from '../../src/infrastructure/git/worktree-manager.js';

/** Git real numa pasta temporária: clone parcial, diff e worktree do MR de demonstração. */
describe('WorktreeManager', () => {
  const git = isolatedGitClient();
  let root: string;
  let demo: DemoRepository;
  let codeHost: LocalCodeHost;
  let mr: MergeRequestRef;
  let reposDirectory: string;
  let worktreesRoot: string;

  function managerFor(runId: string): WorktreeManager {
    return new WorktreeManager(git, codeHost, { reposDirectory, worktreesRoot, runId });
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  /** Simula um push no MR depois de a API já ter sido consultada. */
  async function pushToMergeRequest(): Promise<string> {
    await git.run(['checkout', demo.sourceBranch], demo.path);
    await writeFile(join(demo.path, 'src', 'coupon.ts'), 'export const COUPON = 5;\n');
    await git.run(['add', '--all'], demo.path);
    await git.run(['commit', '--no-gpg-sign', '--no-verify', '--message', 'Cupom fixo'], demo.path);
    await git.run(['update-ref', 'refs/merge-requests/1/head', 'HEAD'], demo.path);
    await git.run(['checkout', demo.targetBranch], demo.path);
    return (await git.run(['rev-parse', 'refs/merge-requests/1/head'], demo.path)).trim();
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nightly-review-git-'));
    demo = await createDemoRepository(join(root, 'origin'), git);
    codeHost = new LocalCodeHost(git, {
      repositoryPath: demo.path,
      projectPath: 'demo/loja',
      targetBranch: demo.targetBranch,
    });
    mr = await codeHost.resolveMergeRequest(codeHost.mergeRequestUrl(demo.mergeRequestIid));
    reposDirectory = join(root, 'data', 'repos');
    worktreesRoot = join(root, 'data', 'worktrees');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('fetchChanges', () => {
    it('devolve o diff com os arquivos, os status e as contagens do MR', async () => {
      const diff = await managerFor('run-1').fetchChanges(mr);

      expect(diff.files).toEqual([
        { path: 'src/cart.ts', status: 'modified', additions: 5, deletions: 3 },
        { path: 'src/discount.ts', status: 'added', additions: 3, deletions: 0 },
        { path: 'src/price-table.ts', status: 'renamed', additions: 0, deletions: 0 },
      ]);
      expect(diff.patch).toContain('+  return Math.min(coupon / total, 0.5);');
      expect(diff.patch).toContain('rename from src/pricing.ts');
      expect(diff.bytes).toBe(Buffer.byteLength(diff.patch));
      expect(diff.baseSha).toBe(demo.baseSha);
      expect(diff.headSha).toBe(demo.headSha);
    });

    it('usa um clone base sem checkout, em repos/<grupo__projeto>', async () => {
      await managerFor('run-1').fetchChanges(mr);

      const repository = join(reposDirectory, 'demo__loja');
      expect(await readdir(reposDirectory)).toEqual(['demo__loja']);
      expect(await exists(join(repository, 'HEAD'))).toBe(true);
      expect(await exists(join(repository, 'src'))).toBe(false);
      expect(await exists(worktreesRoot)).toBe(false);
    });

    it('reaproveita o clone na chamada seguinte', async () => {
      const manager = managerFor('run-1');
      await manager.fetchChanges(mr);
      const marker = join(reposDirectory, 'demo__loja', 'marcador-do-teste');
      await writeFile(marker, 'continua aqui');

      await manager.fetchChanges(mr);

      expect(await readFile(marker, 'utf8')).toBe('continua aqui');
    });

    it('revisa o head novo quando o MR recebeu um push depois da consulta', async () => {
      const newHead = await pushToMergeRequest();

      const diff = await managerFor('run-1').fetchChanges(mr);

      expect(newHead).not.toBe(mr.diffRefs.headSha);
      expect(diff.headSha).toBe(newHead);
      expect(diff.baseSha).toBe(demo.baseSha);
      expect(diff.files.map((file) => file.path)).toContain('src/coupon.ts');
    });

    it.each(['main..outra', 'com espaço', '-x', 'ponto.lock', ''])(
      'recusa a branch alvo %j antes de qualquer comando de rede',
      async (targetBranch) => {
        const manager = managerFor('run-1');

        await expect(manager.fetchChanges({ ...mr, targetBranch })).rejects.toBeInstanceOf(
          InvalidInputError,
        );

        expect(await exists(reposDirectory)).toBe(false);
      },
    );

    it.each(['HEAD', 'abc123', `${'a'.repeat(39)}g`, '--upload-pack=x'])(
      'recusa o SHA %j',
      async (headSha) => {
        const invalid = { ...mr, diffRefs: { ...mr.diffRefs, headSha } };

        await expect(managerFor('run-1').fetchChanges(invalid)).rejects.toBeInstanceOf(
          InvalidInputError,
        );
      },
    );
  });

  describe('prepare e dispose', () => {
    it('cria o worktree no head_sha, na pasta da execução', async () => {
      const manager = managerFor('run-1');
      await manager.fetchChanges(mr);

      const workspace = await manager.prepare(mr);

      expect(workspace).toEqual({
        path: join(worktreesRoot, 'run-1', 'demo__loja__mr-1'),
        headSha: demo.headSha,
        repositoryPath: join(reposDirectory, 'demo__loja'),
      });
      expect((await git.run(['rev-parse', 'HEAD'], workspace.path)).trim()).toBe(demo.headSha);
      expect(await readdir(join(workspace.path, 'src'))).toEqual([
        'cart.ts',
        'discount.ts',
        'price-table.ts',
      ]);
    });

    it('remove o worktree e o registro dele no dispose', async () => {
      const manager = managerFor('run-1');
      await manager.fetchChanges(mr);
      const workspace = await manager.prepare(mr);

      await manager.dispose(workspace);

      expect(await exists(workspace.path)).toBe(false);
      const registered = await git.run(['worktree', 'list'], workspace.repositoryPath);
      expect(registered.trim().split('\n')).toHaveLength(1);
    });

    it('o dispose não falha se o worktree já não existe', async () => {
      const manager = managerFor('run-1');
      await manager.fetchChanges(mr);
      const workspace = await manager.prepare(mr);
      await rm(workspace.path, { recursive: true, force: true });

      await expect(manager.dispose(workspace)).resolves.toBeUndefined();
      await expect(manager.dispose(workspace)).resolves.toBeUndefined();
    });

    it('preparar de novo o mesmo MR substitui o worktree anterior', async () => {
      const manager = managerFor('run-1');
      await manager.fetchChanges(mr);
      const first = await manager.prepare(mr);
      await writeFile(join(first.path, 'resto-da-tentativa-anterior'), 'x');

      const second = await manager.prepare(mr);

      expect(second.path).toBe(first.path);
      expect(await exists(join(second.path, 'resto-da-tentativa-anterior'))).toBe(false);
    });

    it('cria o worktree no head novo que o fetchChanges informou', async () => {
      const newHead = await pushToMergeRequest();
      const manager = managerFor('run-1');
      const diff = await manager.fetchChanges(mr);

      const workspace = await manager.prepare({
        ...mr,
        diffRefs: { ...mr.diffRefs, baseSha: diff.baseSha, headSha: diff.headSha },
      });

      expect(workspace.headSha).toBe(newHead);
      expect(await exists(join(workspace.path, 'src', 'coupon.ts'))).toBe(true);
    });
  });

  describe('pruneOrphans', () => {
    async function leaveOrphan(): Promise<string> {
      const crashed = managerFor('run-0');
      await crashed.fetchChanges(mr);
      return (await crashed.prepare(mr)).path;
    }

    it('apaga os worktrees de execuções anteriores e os registros deles', async () => {
      const orphan = await leaveOrphan();
      const manager = managerFor('run-1');
      const current = await manager.prepare(mr);

      await manager.pruneOrphans();

      expect(await readdir(worktreesRoot)).toEqual(['run-1']);
      expect(await exists(orphan)).toBe(false);
      expect(await exists(current.path)).toBe(true);
      const registered = await git.run(['worktree', 'list'], current.repositoryPath);
      expect(registered).not.toContain('run-0');
    });

    it('preserva as pastas quando a limpeza está desligada (keepWorkspaces)', async () => {
      const orphan = await leaveOrphan();

      await managerFor('run-1').pruneOrphans({ removeStaleDirectories: false });

      expect(await exists(orphan)).toBe(true);
    });

    it('não falha quando ainda não existe nenhuma pasta de dados', async () => {
      await expect(managerFor('run-1').pruneOrphans()).resolves.toBeUndefined();
    });

    it('apaga também pastas soltas que não são worktrees', async () => {
      await mkdir(join(worktreesRoot, 'run-antiga', 'lixo'), { recursive: true });

      await managerFor('run-1').pruneOrphans();

      expect(await readdir(worktreesRoot)).toEqual([]);
    });
  });
});

describe('createDemoRepository', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nightly-review-demo-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('gera sempre os mesmos commits, com main, a branch de feature e a ref do MR', async () => {
    const git = isolatedGitClient();

    const first = await createDemoRepository(join(root, 'a'), git);
    const second = await createDemoRepository(join(root, 'b'), git);

    expect(second.headSha).toBe(first.headSha);
    expect(second.baseSha).toBe(first.baseSha);
    expect(first.headSha).not.toBe(first.baseSha);
    const refs = await git.run(['for-each-ref', '--format=%(refname)'], first.path);
    expect(refs.trim().split('\n')).toEqual([
      'refs/heads/feature/desconto',
      'refs/heads/main',
      'refs/merge-requests/1/head',
    ]);
    expect((await git.run(['branch', '--show-current'], first.path)).trim()).toBe('main');
  });
});
