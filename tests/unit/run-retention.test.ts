import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pruneOldRuns } from '../../src/infrastructure/retention/run-retention.js';

const NOW = new Date('2026-10-12T06:00:00.000Z');

describe('pruneOldRuns', () => {
  let root: string;
  let runs: string;

  async function createRuns(...names: string[]): Promise<void> {
    for (const name of names) {
      await mkdir(join(runs, name, 'reviews'), { recursive: true });
      await writeFile(join(runs, name, 'manifest.json'), '{}');
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nightly-review-retention-'));
    runs = join(root, 'runs');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('apaga as execuções mais antigas que o limite e devolve os runIds removidos', async () => {
    await createRuns(
      '2026-09-01T05-55-00Z-aaaa',
      '2026-10-05T05-59-59Z-bbbb',
      '2026-10-05T06-00-00Z-cccc',
      '2026-10-11T05-55-00Z-dddd',
    );

    const removed = await pruneOldRuns(runs, { days: 7, now: NOW });

    expect(removed).toEqual(['2026-09-01T05-55-00Z-aaaa', '2026-10-05T05-59-59Z-bbbb']);
    expect(await readdir(runs)).toEqual([
      '2026-10-05T06-00-00Z-cccc',
      '2026-10-11T05-55-00Z-dddd',
    ]);
  });

  it('nunca apaga a execução atual', async () => {
    await createRuns('2020-01-01T00-00-00Z-aaaa', '2020-01-02T00-00-00Z-bbbb');

    const removed = await pruneOldRuns(runs, {
      days: 1,
      now: NOW,
      keep: '2020-01-02T00-00-00Z-bbbb',
    });

    expect(removed).toEqual(['2020-01-01T00-00-00Z-aaaa']);
    expect(await readdir(runs)).toEqual(['2020-01-02T00-00-00Z-bbbb']);
  });

  it('não toca em pastas e arquivos que não têm nome de execução', async () => {
    await createRuns('anotacoes', '2026-13-45T99-99-99Z-xxxx', 'copia-de-2020-01-01T00-00-00Z-aaaa');
    await writeFile(join(runs, 'LEIA-ME.txt'), 'guardar');

    const removed = await pruneOldRuns(runs, { days: 1, now: NOW });

    expect(removed).toEqual([]);
    expect(await readdir(runs)).toHaveLength(4);
  });

  it('devolve uma lista vazia quando a pasta de execuções ainda não existe', async () => {
    expect(await pruneOldRuns(runs, { days: 30, now: NOW })).toEqual([]);
  });
});
