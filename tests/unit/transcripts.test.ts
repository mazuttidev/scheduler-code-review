import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  EngineResponse,
  ReviewEngine,
} from '../../src/application/ports/review-provider.js';
import { ErrorKind } from '../../src/domain/enums.js';
import { ConfigurationError, TransientError } from '../../src/domain/errors.js';
import { createRedactor } from '../../src/infrastructure/logging/observers.js';
import { TranscriptRecordingEngine } from '../../src/infrastructure/providers/transcript-recording-engine.js';
import { sampleRequest } from '../helpers/samples.js';

const TOKEN = 'glpat-segredo-de-teste-123';
const RESPONSE: EngineResponse = {
  text: '{"summary":"ok"}',
  usage: { durationMs: 1_200, turns: 3 },
};

/** Motor de teste: devolve, em ordem, as respostas ou os erros combinados. */
class StubEngine implements ReviewEngine {
  calls = 0;

  constructor(private readonly outcomes: readonly (EngineResponse | Error)[] = []) {}

  review(): Promise<EngineResponse> {
    const outcome = this.outcomes[this.calls] ?? RESPONSE;
    this.calls += 1;
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}

function forTask(taskId: string) {
  return sampleRequest({ correlation: { runId: 'run-1', taskId } });
}

describe('TranscriptRecordingEngine', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nightly-review-transcripts-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function record(inner: ReviewEngine, secrets: string[] = []) {
    return new TranscriptRecordingEngine(inner, directory, createRedactor(secrets));
  }

  async function read(...segments: string[]): Promise<string> {
    return readFile(join(directory, ...segments), 'utf8');
  }

  it('grava o prompt e a resposta da tentativa e devolve a resposta do motor', async () => {
    const engine = record(new StubEngine());

    const response = await engine.review(sampleRequest());

    expect(response).toBe(RESPONSE);
    expect(await readdir(join(directory, 't1'))).toEqual([
      'attempt-1.prompt.md',
      'attempt-1.response.json',
    ]);
    expect(await read('t1', 'attempt-1.prompt.md')).toBe(
      '# System\n\nRegras do sistema.\n\n# User\n\nRevise o merge request.\n',
    );
    expect(JSON.parse(await read('t1', 'attempt-1.response.json'))).toEqual(RESPONSE);
  });

  it('grava o erro da tentativa que falhou e relança o mesmo erro', async () => {
    const failure = new TransientError('Falha de rede simulada');
    const engine = record(new StubEngine([failure]));

    await expect(engine.review(sampleRequest())).rejects.toBe(failure);
    await engine.review(sampleRequest());

    expect(await readdir(join(directory, 't1'))).toEqual([
      'attempt-1.error.json',
      'attempt-1.prompt.md',
      'attempt-2.prompt.md',
      'attempt-2.response.json',
    ]);
    expect(JSON.parse(await read('t1', 'attempt-1.error.json'))).toEqual({
      name: 'TransientError',
      kind: ErrorKind.Transient,
      message: 'Falha de rede simulada',
    });
  });

  it('numera as tentativas por tarefa', async () => {
    const engine = record(new StubEngine());

    await engine.review(forTask('t1'));
    await engine.review(forTask('t2'));
    await engine.review(forTask('t1'));

    expect(await readdir(join(directory, 't1'))).toEqual([
      'attempt-1.prompt.md',
      'attempt-1.response.json',
      'attempt-2.prompt.md',
      'attempt-2.response.json',
    ]);
    expect(await readdir(join(directory, 't2'))).toEqual([
      'attempt-1.prompt.md',
      'attempt-1.response.json',
    ]);
  });

  it('mascara os segredos no prompt, na resposta e no erro', async () => {
    const inner = new StubEngine([
      new ConfigurationError(`Token ${TOKEN} recusado`),
      { text: `eco: ${TOKEN}`, usage: { durationMs: 1 } },
    ]);
    const engine = record(inner, [TOKEN]);
    const request = sampleRequest({ prompt: { system: 'Regras.', user: `Diff com ${TOKEN}` } });

    await expect(engine.review(request)).rejects.toThrow();
    await engine.review(request);

    const files = await readdir(join(directory, 't1'));
    const contents = await Promise.all(files.map((file) => read('t1', file)));
    expect(files).toHaveLength(4);
    for (const content of contents) {
      expect(content).not.toContain(TOKEN);
      expect(content).toContain('[REDACTED]');
    }
  });

  it('não deixa o taskId sair da pasta de transcrições', async () => {
    const engine = record(new StubEngine());

    await engine.review(forTask('../../fora'));

    expect(await readdir(directory)).toEqual(['.._.._fora']);
  });

  it('não chama o motor quando o prompt não pode ser gravado', async () => {
    // Um arquivo no lugar da pasta da tarefa impede a gravação.
    await writeFile(join(directory, 't1'), 'ocupado');
    const inner = new StubEngine();

    await expect(record(inner).review(sampleRequest())).rejects.toThrow();

    expect(inner.calls).toBe(0);
  });

  it('falha a tentativa quando a resposta não pode ser gravada', async () => {
    await mkdir(join(directory, 't1', 'attempt-1.response.json'), { recursive: true });
    const inner = new StubEngine();

    await expect(record(inner).review(sampleRequest())).rejects.toThrow();

    expect(inner.calls).toBe(1);
  });

  it('relança o erro do motor mesmo quando o erro não pode ser gravado', async () => {
    await mkdir(join(directory, 't1', 'attempt-1.error.json'), { recursive: true });
    const failure = new TransientError('Falha de rede simulada');

    await expect(record(new StubEngine([failure])).review(sampleRequest())).rejects.toBe(failure);
  });
});
