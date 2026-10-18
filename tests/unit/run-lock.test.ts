import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunLock } from '../../src/infrastructure/lock/run-lock.js';

const NOW = new Date('2026-10-12T05:55:00.000Z');

describe('RunLock', () => {
  let directory: string;
  let filePath: string;

  function lockOf(pid: number, alive: readonly number[] = []): RunLock {
    return new RunLock(filePath, { pid, now: () => NOW, isAlive: (other) => alive.includes(other) });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nightly-review-lock-'));
    filePath = join(directory, 'data', 'run.lock');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('assume o lock e grava o PID e o horário de início', () => {
    const lock = lockOf(100);

    expect(lock.acquire()).toBe(true);

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      pid: 100,
      startedAt: '2026-10-12T05:55:00.000Z',
    });
    expect(lock.holder()).toEqual({ pid: 100, startedAt: '2026-10-12T05:55:00.000Z' });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('recusa o lock enquanto outra execução está viva', () => {
    lockOf(100).acquire();

    expect(lockOf(200, [100]).acquire()).toBe(false);

    expect(lockOf(200).holder()?.pid).toBe(100);
  });

  it('substitui o lock de um processo que já morreu', () => {
    lockOf(100).acquire();

    expect(lockOf(200).acquire()).toBe(true);

    expect(lockOf(200).holder()?.pid).toBe(200);
  });

  it('substitui um lock ilegível', () => {
    lockOf(100).acquire();
    writeFileSync(filePath, 'isto não é JSON');

    expect(lockOf(200, [100]).acquire()).toBe(true);
  });

  it('aceita assumir de novo o próprio lock', () => {
    const lock = lockOf(100, [100]);
    lock.acquire();

    expect(lock.acquire()).toBe(true);
  });

  it('solta o lock removendo o arquivo', () => {
    const lock = lockOf(100);
    lock.acquire();

    lock.release();

    expect(readdirSync(join(directory, 'data'))).toEqual([]);
    expect(lock.holder()).toBeNull();
  });

  it('não solta o lock de outra execução', () => {
    lockOf(100).acquire();

    lockOf(200).release();

    expect(lockOf(200).holder()?.pid).toBe(100);
  });

  it('por padrão, reconhece um processo vivo e um que já terminou', () => {
    const finished = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(join(directory, 'vivo.lock'), JSON.stringify({ pid: process.pid, startedAt: 'x' }));
    writeFileSync(join(directory, 'morto.lock'), JSON.stringify({ pid: finished, startedAt: 'x' }));

    // PID próprio fictício, para o lock existente ser sempre "de outro processo".
    expect(new RunLock(join(directory, 'vivo.lock'), { pid: 1 }).acquire()).toBe(false);
    expect(new RunLock(join(directory, 'morto.lock'), { pid: 1 }).acquire()).toBe(true);
  });
});
