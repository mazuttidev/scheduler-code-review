import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPathSegment, writeFileAtomic, writeFileAtomicSync } from '../../../src/shared/fs.js';

describe('writeFileAtomic', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nightly-review-fs-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('grava o conteúdo e não deixa arquivo .tmp para trás', async () => {
    const filePath = join(directory, 'review.json');

    await writeFileAtomic(filePath, '{"ok":true}');

    expect(await readFile(filePath, 'utf8')).toBe('{"ok":true}');
    expect(await readdir(directory)).toEqual(['review.json']);
  });

  it('sobrescreve um arquivo existente', async () => {
    const filePath = join(directory, 'state.json');
    await writeFile(filePath, 'antigo');

    await writeFileAtomic(filePath, 'novo');

    expect(await readFile(filePath, 'utf8')).toBe('novo');
    expect(await readdir(directory)).toEqual(['state.json']);
  });

  it('cria os diretórios que faltam, com 700, e o arquivo com 600', async () => {
    const filePath = join(directory, 'runs', 'r1', 'manifest.json');

    await writeFileAtomic(filePath, '{}');

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'runs', 'r1'))).mode & 0o777).toBe(0o700);
  });

  it('não deixa temporário quando a gravação falha', async () => {
    // O destino é um diretório: o rename final falha.
    const filePath = join(directory, 'ocupado');
    await writeFileAtomic(join(filePath, 'filho.txt'), 'x');

    await expect(writeFileAtomic(filePath, 'conteúdo')).rejects.toThrow();

    expect(await readdir(directory)).toEqual(['ocupado']);
  });
});

describe('toPathSegment', () => {
  it.each([
    ['1a2b-3c4d', '1a2b-3c4d'],
    ['tarefa 42', 'tarefa_42'],
    ['a/b\\c', 'a_b_c'],
    ['../../etc/passwd', '.._.._etc_passwd'],
    ['..', '_'],
    ['.', '_'],
    ['', '_'],
  ])('transforma %j em %j', (value, expected) => {
    expect(toPathSegment(value)).toBe(expected);
  });
});

describe('writeFileAtomicSync', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nightly-review-fs-sync-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('grava antes de retornar, sem deixar .tmp, com os mesmos modos', async () => {
    const filePath = join(directory, 'runs', 'r1', 'manifest.json');

    writeFileAtomicSync(filePath, '{"ok":true}');

    expect(await readFile(filePath, 'utf8')).toBe('{"ok":true}');
    expect(await readdir(join(directory, 'runs', 'r1'))).toEqual(['manifest.json']);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'runs', 'r1'))).mode & 0o777).toBe(0o700);
  });

  it('sobrescreve um arquivo existente', async () => {
    const filePath = join(directory, 'manifest.json');
    writeFileAtomicSync(filePath, 'antigo');

    writeFileAtomicSync(filePath, 'novo');

    expect(await readFile(filePath, 'utf8')).toBe('novo');
  });

  it('não deixa temporário quando a gravação falha', async () => {
    // O destino é um diretório: o rename final falha.
    const filePath = join(directory, 'ocupado');
    writeFileAtomicSync(join(filePath, 'filho.txt'), 'x');

    expect(() => {
      writeFileAtomicSync(filePath, 'conteúdo');
    }).toThrow();

    expect(await readdir(directory)).toEqual(['ocupado']);
  });
});
