import { describe, expect, it } from 'vitest';

import { ErrorKind } from '../../../src/domain/enums.js';
import {
  AppError,
  ConfigurationError,
  RateLimitError,
  RunAbortedError,
  TransientError,
  UnknownError,
  createError,
  toAppError,
} from '../../../src/domain/errors.js';

describe('createError', () => {
  it.each(Object.values(ErrorKind))('cria um AppError do tipo %s', (kind) => {
    const error = createError(kind, 'falhou', { taskId: '1a2b' });

    expect(error).toBeInstanceOf(AppError);
    expect(error.kind).toBe(kind);
    expect(error.message).toBe('falhou');
    expect(error.details).toEqual({ taskId: '1a2b' });
  });

  it('usa a subclasse do tipo, com o nome dela', () => {
    const error = createError(ErrorKind.RateLimit, 'limite da assinatura');

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.name).toBe('RateLimitError');
  });
});

describe('AppError.toJSON', () => {
  it('serializa nome, tipo, mensagem, detalhes e causa', () => {
    const error = new ConfigurationError(
      'review.config.json inválido',
      { path: 'review.config.json' },
      { cause: new SyntaxError('JSON malformado') },
    );

    expect(error.toJSON()).toEqual({
      name: 'ConfigurationError',
      kind: ErrorKind.Configuration,
      message: 'review.config.json inválido',
      details: { path: 'review.config.json' },
      cause: { name: 'SyntaxError', message: 'JSON malformado' },
    });
  });

  it('omite detalhes vazios e não inclui stack em erros esperados', () => {
    const serialized = new RateLimitError('limite da assinatura').toJSON();

    expect(serialized).toEqual({
      name: 'RateLimitError',
      kind: ErrorKind.RateLimit,
      message: 'limite da assinatura',
    });
  });

  it('inclui o stack só em erros desconhecidos', () => {
    expect(new UnknownError('inesperado').toJSON().stack).toContain('UnknownError');
  });

  it('serializa uma causa que não é Error', () => {
    const error = new TransientError('rede', {}, { cause: { code: 'ECONNRESET' } });

    expect(error.toJSON().cause).toEqual({ name: 'NonError', message: '{"code":"ECONNRESET"}' });
  });
});

describe('TransientError', () => {
  it('guarda a espera pedida pelo serviço', () => {
    const error = new TransientError('429 do GitLab', {}, { retryAfterMs: 5_000 });

    expect(error.retryAfterMs).toBe(5_000);
    expect(error.kind).toBe(ErrorKind.Transient);
  });

  it('não cria a propriedade quando o serviço não pediu espera', () => {
    expect(Object.hasOwn(new TransientError('rede'), 'retryAfterMs')).toBe(false);
  });
});

describe('RunAbortedError', () => {
  it('não é um AppError e guarda o erro que interrompeu a execução', () => {
    const cause = new RateLimitError('limite da assinatura');
    const aborted = new RunAbortedError(cause);

    expect(aborted).not.toBeInstanceOf(AppError);
    expect(aborted.cause).toBe(cause);
    expect(aborted.message).toContain('limite da assinatura');
  });

  it('mantém cause não enumerável, como em qualquer Error', () => {
    const aborted = new RunAbortedError(new RateLimitError('limite da assinatura'));

    expect(Object.keys(aborted)).not.toContain('cause');
  });
});

describe('toAppError', () => {
  it('devolve o próprio AppError', () => {
    const error = new TransientError('rede');

    expect(toAppError(error)).toBe(error);
  });

  it('devolve a causa de um RunAbortedError', () => {
    const cause = new RateLimitError('limite da assinatura');

    expect(toAppError(new RunAbortedError(cause))).toBe(cause);
  });

  it('converte um Error genérico em UnknownError, preservando causa e stack', () => {
    const original = new TypeError('x is not a function');

    const error = toAppError(original);

    expect(error).toBeInstanceOf(UnknownError);
    expect(error.message).toBe('x is not a function');
    expect(error.details).toEqual({ originalName: 'TypeError' });
    expect(error.cause).toBe(original);
    expect(error.stack).toBe(original.stack);
  });

  it.each([
    ['uma string', 'falhou feio', 'falhou feio'],
    ['um objeto', { code: 42 }, '{"code":42}'],
    ['undefined', undefined, 'undefined'],
    ['uma string vazia', '', 'Erro desconhecido'],
    ['um bigint', 10n, '10'],
    ['um objeto cujo toJSON devolve undefined', { toJSON: () => undefined }, 'object'],
  ])('converte %s lançado em UnknownError', (_label, thrown, message) => {
    const error = toAppError(thrown);

    expect(error.kind).toBe(ErrorKind.Unknown);
    expect(error.message).toBe(message);
  });
});
