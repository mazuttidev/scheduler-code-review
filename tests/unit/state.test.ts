import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReviewedEntry } from '../../src/application/ports/review-state-store.js';
import { Verdict } from '../../src/domain/enums.js';
import { ConfigurationError } from '../../src/domain/errors.js';
import { JsonFileStateStore } from '../../src/infrastructure/state/json-file-state-store.js';

const SHA_1 = 'a'.repeat(40);
const SHA_2 = 'b'.repeat(40);

function entry(overrides: Partial<ReviewedEntry> = {}): ReviewedEntry {
  return {
    taskId: 't1',
    headSha: SHA_1,
    runId: '2026-10-12T05-55-00Z-k3x9',
    reviewedAt: '2026-10-12T06:01:37.552Z',
    verdict: Verdict.ChangesRequested,
    ...overrides,
  };
}

describe('JsonFileStateStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nightly-review-state-'));
    filePath = join(directory, 'state', 'reviewed.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('trata o arquivo ausente como estado vazio', async () => {
    const store = new JsonFileStateStore(filePath);

    expect(await store.wasReviewed('t1', SHA_1)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  it('marca, consulta e desmarca um par tarefa + head_sha', async () => {
    const store = new JsonFileStateStore(filePath);

    await store.markReviewed(entry());
    expect(await store.wasReviewed('t1', SHA_1)).toBe(true);

    await store.unmark('t1', SHA_1);
    expect(await store.wasReviewed('t1', SHA_1)).toBe(false);
  });

  it('não considera revisado o mesmo taskId com outro head_sha, nem outra tarefa', async () => {
    const store = new JsonFileStateStore(filePath);

    await store.markReviewed(entry());

    expect(await store.wasReviewed('t1', SHA_2)).toBe(false);
    expect(await store.wasReviewed('t2', SHA_1)).toBe(false);
  });

  it('grava o mapa "<taskId>:<headSha>" -> entrada, sem deixar .tmp', async () => {
    const store = new JsonFileStateStore(filePath);

    await store.markReviewed(entry());
    await store.markReviewed(entry({ taskId: 't2', headSha: SHA_2, verdict: Verdict.Approve }));

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      [`t1:${SHA_1}`]: entry(),
      [`t2:${SHA_2}`]: entry({ taskId: 't2', headSha: SHA_2, verdict: Verdict.Approve }),
    });
    expect(await readdir(join(directory, 'state'))).toEqual(['reviewed.json']);
  });

  it('persiste o estado entre instâncias', async () => {
    await new JsonFileStateStore(filePath).markReviewed(entry());

    expect(await new JsonFileStateStore(filePath).wasReviewed('t1', SHA_1)).toBe(true);
  });

  it('desmarcar preserva as outras entradas', async () => {
    const store = new JsonFileStateStore(filePath);
    await store.markReviewed(entry());
    await store.markReviewed(entry({ headSha: SHA_2 }));

    await store.unmark('t1', SHA_1);

    expect(await store.wasReviewed('t1', SHA_1)).toBe(false);
    expect(await store.wasReviewed('t1', SHA_2)).toBe(true);
  });

  it('desmarcar um par que não está marcado não faz nada', async () => {
    const store = new JsonFileStateStore(filePath);

    await expect(store.unmark('t1', SHA_1)).resolves.toBeUndefined();

    expect(await readdir(directory)).toEqual([]);
  });

  it('marcar de novo o mesmo par atualiza a entrada', async () => {
    const store = new JsonFileStateStore(filePath);
    await store.markReviewed(entry());

    await store.markReviewed(entry({ verdict: Verdict.Approve }));

    const state = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, ReviewedEntry>;
    expect(Object.keys(state)).toHaveLength(1);
    expect(state[`t1:${SHA_1}`]?.verdict).toBe(Verdict.Approve);
  });

  it.each([
    ['não é JSON', '{ "t1:aaa": '],
    ['está vazio', ''],
    ['está fora do formato', JSON.stringify({ [`t1:${SHA_1}`]: { taskId: 't1' } })],
    ['não é um mapa', JSON.stringify(['t1'])],
  ])('lança ConfigurationError e não toca no arquivo quando ele %s', async (_label, content) => {
    await new JsonFileStateStore(filePath).markReviewed(entry());
    await writeFile(filePath, content);
    const store = new JsonFileStateStore(filePath);

    await expect(store.wasReviewed('t1', SHA_1)).rejects.toBeInstanceOf(ConfigurationError);
    await expect(store.markReviewed(entry())).rejects.toBeInstanceOf(ConfigurationError);
    await expect(store.unmark('t1', SHA_1)).rejects.toBeInstanceOf(ConfigurationError);

    expect(await readFile(filePath, 'utf8')).toBe(content);
  });
});
