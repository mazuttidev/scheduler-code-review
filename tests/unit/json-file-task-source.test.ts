import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigurationError } from '../../src/domain/errors.js';
import { JsonFileTaskSource } from '../../src/infrastructure/task-sources/json-file-task-source.js';

describe('JsonFileTaskSource', () => {
  let directory: string;
  let filePath: string;

  async function sourceWith(content: unknown): Promise<JsonFileTaskSource> {
    await writeFile(filePath, typeof content === 'string' ? content : JSON.stringify(content));
    return new JsonFileTaskSource(filePath);
  }

  async function failure(source: JsonFileTaskSource): Promise<ConfigurationError> {
    try {
      await source.fetchPending(10);
    } catch (error) {
      if (error instanceof ConfigurationError) return error;
      throw error;
    }
    throw new Error('Esperava um ConfigurationError');
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nightly-review-tasks-'));
    filePath = join(directory, 'tasks.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('respeita o limite pedido', async () => {
    const source = await sourceWith([
      { id: 'T-1', title: 'Primeira' },
      { id: 'T-2', title: 'Segunda' },
      { id: 'T-3', title: 'Terceira' },
    ]);

    expect((await source.fetchPending(2)).map((task) => task.id)).toEqual(['T-1', 'T-2']);
  });

  it('aceita um arquivo sem tarefas', async () => {
    expect(await (await sourceWith([])).fetchPending(10)).toEqual([]);
  });

  it('lança ConfigurationError quando o arquivo não existe', async () => {
    const error = await failure(new JsonFileTaskSource(filePath));

    expect(error.message).toBe('Não foi possível ler o arquivo de tarefas');
    expect(error.details).toEqual({ path: filePath });
  });

  it('lança ConfigurationError quando o arquivo não é JSON', async () => {
    const error = await failure(await sourceWith('[ { "id": '));

    expect(error.message).toBe('O arquivo de tarefas não é um JSON válido');
  });

  it.each([
    ['não é uma lista', { tasks: [] }],
    ['tem uma tarefa sem título', [{ id: 'T-1' }]],
    ['tem um campo desconhecido', [{ id: 'T-1', title: 'x', prioridade: 'alta' }]],
    ['tem um ID com barra', [{ id: 'a/b', title: 'x' }]],
    ['tem um ID que é só pontos', [{ id: '..', title: 'x' }]],
    ['tem um ID vazio', [{ id: '', title: 'x' }]],
  ])('lança ConfigurationError quando o arquivo %s', async (_label, content) => {
    const error = await failure(await sourceWith(content));

    expect(error.message).toBe('O arquivo de tarefas está fora do formato esperado');
  });

  it('recusa IDs repetidos, que cairiam na mesma pasta de relatórios', async () => {
    const error = await failure(
      await sourceWith([
        { id: 'T-1', title: 'Primeira' },
        { id: 'T-2', title: 'Segunda' },
        { id: 'T-1', title: 'Repetida' },
      ]),
    );

    expect(error.details).toEqual({ path: filePath, repeated: ['T-1'] });
  });
});
