import { describe, expect, it, vi } from 'vitest';

import type { Command } from '../../src/application/commands/command.js';
import { RetryingCommand } from '../../src/application/decorators/command-decorators.js';
import { EventBus } from '../../src/application/events/event-bus.js';
import {
  AbortRun,
  ErrorKindRetryPolicy,
  ExponentialBackoffRetry,
  FixedDelayRetry,
  NoRetry,
  defaultRetryPolicies,
} from '../../src/application/retry/retry-policy.js';
import type { RetryDecision, RetryPolicy } from '../../src/application/retry/retry-policy.js';
import { ErrorKind } from '../../src/domain/enums.js';
import {
  InvalidOutputError,
  NotFoundError,
  TransientError,
  createError,
} from '../../src/domain/errors.js';
import type { PipelineEvents } from '../../src/domain/events.js';

/**
 * Strategy no nightly-review.
 *
 * - Strategy: `RetryPolicy`.
 * - ConcreteStrategy: `NoRetry`, `AbortRun`, `FixedDelayRetry`,
 *   `ExponentialBackoffRetry` e `ErrorKindRetryPolicy`.
 * - Context: `RetryingCommand`, que só pergunta `policy.decide(erro, falhas)`.
 *
 * Cada tipo de falha pede uma reação diferente, e a reação é trocada sem
 * tocar em quem executa a etapa.
 */

const FAIL: RetryDecision = { action: 'fail' };
const transient = new TransientError('rede indisponível');

describe('Strategy: políticas simples', () => {
  const cases: [string, RetryPolicy, number, RetryDecision][] = [
    ['NoRetry reprova na primeira falha', new NoRetry(), 1, FAIL],
    ['AbortRun interrompe a execução', new AbortRun(), 1, { action: 'abort-run' }],
    [
      'FixedDelayRetry(2) tenta de novo na primeira falha',
      new FixedDelayRetry(2, 10_000),
      1,
      { action: 'retry', delayMs: 10_000 },
    ],
    ['FixedDelayRetry(2) reprova na segunda falha', new FixedDelayRetry(2, 10_000), 2, FAIL],
    [
      'FixedDelayRetry aceita espera zero',
      new FixedDelayRetry(2, 0),
      1,
      { action: 'retry', delayMs: 0 },
    ],
    ['FixedDelayRetry(1) nunca retenta', new FixedDelayRetry(1, 10_000), 1, FAIL],
  ];

  it.each(cases)('%s', (_label, policy, failures, expected) => {
    expect(policy.decide(transient, failures)).toEqual(expected);
  });
});

describe('Strategy: ExponentialBackoffRetry', () => {
  const options = { maxAttempts: 4, baseDelayMs: 2_000, maxDelayMs: 30_000 };

  it.each([
    [1, { action: 'retry', delayMs: 2_000 }],
    [2, { action: 'retry', delayMs: 4_000 }],
    [3, { action: 'retry', delayMs: 8_000 }],
    [4, FAIL],
  ] satisfies [number, RetryDecision][])(
    'na falha %i de 4 tentativas, dobra a espera ou para no limite',
    (failures, expected) => {
      expect(new ExponentialBackoffRetry(options).decide(transient, failures)).toEqual(expected);
    },
  );

  it.each([5, 9])('limita a espera calculada ao teto na falha %i', (failures) => {
    const policy = new ExponentialBackoffRetry({ ...options, maxAttempts: 10 });

    expect(policy.decide(transient, failures)).toEqual({ action: 'retry', delayMs: 30_000 });
  });

  it.each([
    [0, 1_000],
    [0.5, 1_500],
    [0.999_999, 2_000],
  ])('com jitter e sorteio %f, espera entre 50%% e 100%% do calculado', (random, delayMs) => {
    const policy = new ExponentialBackoffRetry({ ...options, jitter: true, random: () => random });

    expect(policy.decide(transient, 1)).toEqual({ action: 'retry', delayMs });
  });

  it('espera o Retry-After inteiro, mesmo acima do teto', () => {
    const throttled = new TransientError('429 do GitLab', {}, { retryAfterMs: 45_000 });

    expect(new ExponentialBackoffRetry(options).decide(throttled, 1)).toEqual({
      action: 'retry',
      delayMs: 45_000,
    });
  });

  it('não espera menos que o backoff quando o Retry-After é curto', () => {
    const throttled = new TransientError('429 do GitLab', {}, { retryAfterMs: 500 });

    expect(new ExponentialBackoffRetry(options).decide(throttled, 2)).toEqual({
      action: 'retry',
      delayMs: 4_000,
    });
  });

  it('para no limite de tentativas mesmo com Retry-After', () => {
    const throttled = new TransientError('429 do GitLab', {}, { retryAfterMs: 1_000 });

    expect(new ExponentialBackoffRetry(options).decide(throttled, 4)).toEqual(FAIL);
  });
});

describe('Strategy: ErrorKindRetryPolicy', () => {
  it('escolhe a estratégia pelo tipo do erro e repassa a contagem de falhas', () => {
    const forNotFound = vi.fn<RetryPolicy['decide']>(() => FAIL);
    const forOthers = vi.fn<RetryPolicy['decide']>(() => ({ action: 'retry', delayMs: 1 }));
    const others: RetryPolicy = { decide: forOthers };
    const policy = new ErrorKindRetryPolicy({
      ...defaultRetryPolicies(),
      [ErrorKind.NotFound]: { decide: forNotFound },
      [ErrorKind.Transient]: others,
    });
    const missing = new NotFoundError('MR inexistente');

    expect(policy.decide(missing, 1)).toEqual(FAIL);
    expect(policy.decide(transient, 3)).toEqual({ action: 'retry', delayMs: 1 });

    expect(forNotFound).toHaveBeenCalledWith(missing, 1);
    expect(forOthers).toHaveBeenCalledWith(transient, 3);
  });

  // O Record<ErrorKind, …> obriga o compilador a cobrar uma linha por tipo.
  const firstFailure: Record<ErrorKind, RetryDecision> = {
    [ErrorKind.RateLimit]: { action: 'abort-run' },
    [ErrorKind.Configuration]: { action: 'abort-run' },
    [ErrorKind.Transient]: { action: 'retry', delayMs: 1_000 },
    [ErrorKind.Timeout]: { action: 'retry', delayMs: 10_000 },
    [ErrorKind.InvalidOutput]: { action: 'retry', delayMs: 0 },
    [ErrorKind.InvalidInput]: FAIL,
    [ErrorKind.NotFound]: FAIL,
    [ErrorKind.Unknown]: FAIL,
  };

  it.each(Object.values(ErrorKind))('as políticas padrão cobrem %s', (kind) => {
    const policy = new ErrorKindRetryPolicy(defaultRetryPolicies({ random: () => 0 }));

    expect(policy.decide(createError(kind, 'falhou'), 1)).toEqual(firstFailure[kind]);
  });

  it.each([
    [ErrorKind.Transient, 4],
    [ErrorKind.Timeout, 2],
    [ErrorKind.InvalidOutput, 2],
  ])('as políticas padrão param de retentar %s na falha %i', (kind, failures) => {
    const policy = new ErrorKindRetryPolicy(defaultRetryPolicies());

    expect(policy.decide(createError(kind, 'falhou'), failures - 1).action).toBe('retry');
    expect(policy.decide(createError(kind, 'falhou'), failures)).toEqual(FAIL);
  });
});

describe('Strategy: RetryingCommand como contexto', () => {
  function scripted(failures: readonly Error[]) {
    const state = { executions: 0 };
    const command: Command<string> = {
      name: 'run-review',
      taskId: 't1',
      execute() {
        const failure = failures[state.executions];
        state.executions += 1;
        return failure ? Promise.reject(failure) : Promise.resolve('ok');
      },
    };
    return { command, state };
  }

  function run(command: Command<string>, policy: RetryPolicy) {
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const retrying = new RetryingCommand(command, policy, new EventBus<PipelineEvents>(), sleep);
    return { sleeps, result: retrying.execute() };
  }

  const defaults = () => new ErrorKindRetryPolicy(defaultRetryPolicies({ random: () => 0 }));

  it('uma falha transitória seguida de saída inválida não esgota a cota de invalid_output', async () => {
    const { command, state } = scripted([
      new TransientError('rede indisponível'),
      new InvalidOutputError('Saída fora do schema'),
    ]);

    const { sleeps, result } = run(command, defaults());

    await expect(result).resolves.toBe('ok');
    expect(state.executions).toBe(3);
    expect(sleeps).toEqual([1_000, 0]);
  });

  it('a cota de invalid_output se esgota na segunda saída inválida', async () => {
    const second = new InvalidOutputError('Saída fora do schema, de novo');
    const { command, state } = scripted([
      new TransientError('rede indisponível'),
      new InvalidOutputError('Saída fora do schema'),
      second,
    ]);

    const { result } = run(command, defaults());

    await expect(result).rejects.toBe(second);
    expect(state.executions).toBe(3);
  });

  it('trocar a estratégia muda a reação sem alterar o contexto', async () => {
    const failure = new TransientError('rede indisponível');
    const { command, state } = scripted([failure]);

    const { sleeps, result } = run(command, new NoRetry());

    await expect(result).rejects.toBe(failure);
    expect(state.executions).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
