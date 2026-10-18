import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CodeHostKind } from '../../src/domain/enums.js';
import { InvalidInputError, NotFoundError } from '../../src/domain/errors.js';
import {
  LOCAL_CODE_HOST_ORIGIN,
  LocalCodeHost,
} from '../../src/infrastructure/code-hosts/local-code-host.js';
import {
  createDemoRepository,
  isolatedGitClient,
} from '../../src/infrastructure/git/demo-repository.js';
import type { DemoRepository } from '../../src/infrastructure/git/demo-repository.js';

describe('LocalCodeHost', () => {
  const git = isolatedGitClient();
  let root: string;
  let demo: DemoRepository;
  let codeHost: LocalCodeHost;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nightly-review-local-host-'));
    demo = await createDemoRepository(join(root, 'origin'), git);
    codeHost = new LocalCodeHost(git, {
      repositoryPath: demo.path,
      projectPath: 'demo/loja',
      targetBranch: 'main',
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('converte o MR do repositório local para o modelo interno', async () => {
    const url = `${LOCAL_CODE_HOST_ORIGIN}/demo/loja/-/merge_requests/1`;

    const mr = await codeHost.resolveMergeRequest(url);

    expect(mr).toEqual({
      host: CodeHostKind.Local,
      projectId: 1,
      projectPath: 'demo/loja',
      iid: 1,
      title: 'Desconto por cupom',
      description: 'Aplica o cupom ao total do carrinho, limitado a 50%.',
      webUrl: url,
      state: 'opened',
      sourceBranch: 'feature/desconto',
      targetBranch: 'main',
      diffRefs: { baseSha: demo.baseSha, startSha: demo.baseSha, headSha: demo.headSha },
    });
  });

  it('monta o link, a URL de clone e a ref do MR a partir da configuração', () => {
    expect(codeHost.kind).toBe(CodeHostKind.Local);
    expect(codeHost.mergeRequestUrl(7)).toBe(
      'http://local.nightly-review.test/demo/loja/-/merge_requests/7',
    );
    expect(codeHost.cloneUrl('demo/loja')).toBe(demo.path);
    expect(codeHost.mergeRequestRef(7)).toBe('refs/merge-requests/7/head');
  });

  it.each([
    ['de outro host', 'https://gitlab.com/demo/loja/-/merge_requests/1'],
    ['de outro projeto', `${LOCAL_CODE_HOST_ORIGIN}/outro/projeto/-/merge_requests/1`],
    ['sem número de MR', `${LOCAL_CODE_HOST_ORIGIN}/demo/loja/-/merge_requests/`],
    ['com número inválido', `${LOCAL_CODE_HOST_ORIGIN}/demo/loja/-/merge_requests/1;rm`],
    ['com número zero', `${LOCAL_CODE_HOST_ORIGIN}/demo/loja/-/merge_requests/0`],
    ['que não é URL', 'merge request 1'],
  ])('recusa um link %s', async (_label, url) => {
    await expect(codeHost.resolveMergeRequest(url)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('lança NotFoundError para um MR que não existe', async () => {
    await expect(
      codeHost.resolveMergeRequest(codeHost.mergeRequestUrl(99)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('não entrega a URL de clone de um projeto que não é o configurado', () => {
    expect(() => codeHost.cloneUrl('outro/projeto')).toThrow(InvalidInputError);
  });
});
