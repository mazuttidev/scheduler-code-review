import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CodeHost } from '../../src/application/ports/code-host.js';
import type { TaskSource } from '../../src/application/ports/task-source.js';
import { CodeHostKind, TaskSourceKind } from '../../src/domain/enums.js';
import { InvalidInputError } from '../../src/domain/errors.js';
import type { MergeRequestRef } from '../../src/domain/merge-request.js';
import type { ReviewTask } from '../../src/domain/review-task.js';
import { LocalCodeHost } from '../../src/infrastructure/code-hosts/local-code-host.js';
import {
  createDemoRepository,
  isolatedGitClient,
} from '../../src/infrastructure/git/demo-repository.js';
import type { DemoRepository } from '../../src/infrastructure/git/demo-repository.js';
import { JsonFileTaskSource } from '../../src/infrastructure/task-sources/json-file-task-source.js';

/**
 * Adapter no nightly-review.
 *
 * - Target: `TaskSource` e `CodeHost`, as portas que o pipeline conhece.
 * - Adapter: aqui, `JsonFileTaskSource` e `LocalCodeHost`; na Fase 8 entram
 *   `NotionTaskSource` e `GitLabCodeHost`, atrás das mesmas portas.
 * - Adaptee: um arquivo JSON de tarefas e um repositório git local.
 *
 * Cada fonte externa fala a sua língua. O adapter converte o formato de fora
 * para o modelo interno e é a fronteira onde a entrada é validada.
 */

const MERGE_REQUEST_URL = 'http://local.nightly-review.test/demo/loja/-/merge_requests/1';

describe('Adapter: fontes externas atrás das portas', () => {
  let root: string;
  let tasksPath: string;
  let demo: DemoRepository;
  // O cliente só enxerga os Targets.
  let taskSource: TaskSource;
  let codeHost: CodeHost;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nightly-review-adapter-'));
    tasksPath = join(root, 'tasks.json');
    // Adaptee 1: o formato do arquivo, com campos opcionais ausentes.
    await writeFile(
      tasksPath,
      JSON.stringify([
        {
          id: 'DEMO-1',
          title: 'Aplicar desconto por cupom',
          url: 'https://tarefas.example.com/DEMO-1',
          description: 'O total deve considerar o cupom.',
          businessRules: ['O desconto nunca passa de 50%.'],
          acceptanceCriteria: ['Cupom válido reduz o total.'],
          mergeRequestUrl: MERGE_REQUEST_URL,
        },
        { id: 'DEMO-2', title: 'Exportar o pedido em PDF' },
      ]),
    );
    // Adaptee 2: um repositório git, com o MR numa ref.
    const git = isolatedGitClient();
    demo = await createDemoRepository(join(root, 'origin'), git);

    taskSource = new JsonFileTaskSource(tasksPath);
    codeHost = new LocalCodeHost(git, {
      repositoryPath: demo.path,
      projectPath: 'demo/loja',
      targetBranch: 'main',
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('o JsonFileTaskSource converte o arquivo de tarefas em ReviewTask[]', async () => {
    const tasks = await taskSource.fetchPending(10);

    const expected: ReviewTask[] = [
      {
        id: 'DEMO-1',
        source: TaskSourceKind.JsonFile,
        url: 'https://tarefas.example.com/DEMO-1',
        title: 'Aplicar desconto por cupom',
        description: 'O total deve considerar o cupom.',
        businessRules: ['O desconto nunca passa de 50%.'],
        acceptanceCriteria: ['Cupom válido reduz o total.'],
        mergeRequestUrl: MERGE_REQUEST_URL,
      },
      {
        id: 'DEMO-2',
        source: TaskSourceKind.JsonFile,
        url: `${pathToFileURL(tasksPath).href}#DEMO-2`,
        title: 'Exportar o pedido em PDF',
        description: '',
        businessRules: [],
        acceptanceCriteria: [],
        mergeRequestUrl: null,
      },
    ];
    expect(taskSource.kind).toBe(TaskSourceKind.JsonFile);
    expect(tasks).toEqual(expected);
  });

  it('o LocalCodeHost resolve o MR do repositório de demonstração em MergeRequestRef', async () => {
    const mr = await codeHost.resolveMergeRequest(MERGE_REQUEST_URL);

    const expected: MergeRequestRef = {
      host: CodeHostKind.Local,
      projectId: 1,
      projectPath: 'demo/loja',
      iid: 1,
      title: 'Desconto por cupom',
      description: 'Aplica o cupom ao total do carrinho, limitado a 50%.',
      webUrl: MERGE_REQUEST_URL,
      state: 'opened',
      sourceBranch: 'feature/desconto',
      targetBranch: 'main',
      diffRefs: { baseSha: demo.baseSha, startSha: demo.baseSha, headSha: demo.headSha },
    };
    expect(codeHost.kind).toBe(CodeHostKind.Local);
    expect(mr).toEqual(expected);
  });

  it('o link que uma tarefa traz é o que o outro adapter resolve', async () => {
    const [task] = await taskSource.fetchPending(1);

    const mr = await codeHost.resolveMergeRequest(task?.mergeRequestUrl ?? '');

    expect(mr.diffRefs.headSha).toBe(demo.headSha);
  });

  it('o adapter é a fronteira de confiança: recusa um link de MR de outro host', async () => {
    await expect(
      codeHost.resolveMergeRequest('https://gitlab.com/demo/loja/-/merge_requests/1'),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});
