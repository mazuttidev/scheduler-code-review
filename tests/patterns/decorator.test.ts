import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { Command, CommandDecoration } from '../../src/application/commands/command.js';
import {
  CommandDecorator,
  LoggingCommand,
  RetryingCommand,
} from '../../src/application/decorators/command-decorators.js';
import { EventBus } from '../../src/application/events/event-bus.js';
import { AbortRun, FixedDelayRetry, NoRetry } from '../../src/application/retry/retry-policy.js';
import type { RetryPolicy } from '../../src/application/retry/retry-policy.js';
import { ErrorKind } from '../../src/domain/enums.js';
import {
  InvalidInputError,
  InvalidOutputError,
  RateLimitError,
  RunAbortedError,
  TransientError,
  UnknownError,
} from '../../src/domain/errors.js';
import type { EventEnvelope, PipelineEvents } from '../../src/domain/events.js';

/**
 * Decorator no nightly-review.
 *
 * - Component: `Command<T>`.
 * - ConcreteComponent: aqui, `FlakyCommand`; no sistema, as oito etapas.
 * - Decorator: `CommandDecorator<T>`.
 * - ConcreteDecorator: `RetryingCommand<T>` e `LoggingCommand<T>`.
 *
 * Retentativa e log valem para qualquer etapa, sem duplicar código em cada
 * comando, e as camadas se combinam: `LoggingCommand(RetryingCommand(comando))`.
 */

interface Review {
  readonly verdict: string;
}

/** ConcreteComponent de teste: falha com os erros dados, em ordem, e depois funciona. */
class FlakyCommand<T> implements Command<T> {
  readonly name = 'run-review';
  readonly taskId = 't1';
  executions = 0;
  undone = 0;

  constructor(
    private readonly failures: readonly Error[],
    private readonly result: T,
  ) {}

  execute(): Promise<T> {
    const failure = this.failures[this.executions];
    this.executions += 1;
    return failure ? Promise.reject(failure) : Promise.resolve(this.result);
  }

  undo(): Promise<void> {
    this.undone += 1;
    return Promise.resolve();
  }
}

function harness(policy: RetryPolicy, ticks: number[] = []) {
  const bus = new EventBus<PipelineEvents>();
  const events: EventEnvelope<PipelineEvents>[] = [];
  bus.onAny((envelope) => events.push(envelope));

  // Espera e relógio injetados: o teste não dorme nem lê a hora real.
  const sleeps: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  const now = (): number => ticks.shift() ?? 0;

  const retrying = <T>(command: Command<T>) => new RetryingCommand(command, policy, bus, sleep);
  const logging = <T>(command: Command<T>) => new LoggingCommand(command, bus, now);
  // A ordem que a raiz de composição fixa.
  const decorate: CommandDecoration = (command) => logging(retrying(command));

  return { bus, events, sleeps, retrying, logging, decorate };
}

function types(events: readonly EventEnvelope<PipelineEvents>[]): string[] {
  return events.map((event) => event.type);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Esperava uma rejeição');
}

describe('Decorator: LoggingCommand(RetryingCommand(comando))', () => {
  it('retenta duas falhas transitórias e loga a etapa uma única vez', async () => {
    const { events, sleeps, decorate } = harness(new FixedDelayRetry(3, 500), [1_000, 1_750]);
    const command = new FlakyCommand<Review>(
      [new TransientError('rede indisponível'), new TransientError('rede indisponível')],
      { verdict: 'approve' },
    );

    const result = await decorate(command).execute();

    expect(result).toEqual({ verdict: 'approve' });
    expect(command.executions).toBe(3);
    expect(types(events)).toEqual([
      'command.started',
      'retry.scheduled',
      'retry.scheduled',
      'command.succeeded',
    ]);
    expect(events.map((event) => event.payload)).toEqual([
      { command: 'run-review', taskId: 't1' },
      {
        command: 'run-review',
        taskId: 't1',
        attempt: 1,
        delayMs: 500,
        errorKind: ErrorKind.Transient,
        message: 'rede indisponível',
      },
      {
        command: 'run-review',
        taskId: 't1',
        attempt: 2,
        delayMs: 500,
        errorKind: ErrorKind.Transient,
        message: 'rede indisponível',
      },
      { command: 'run-review', taskId: 't1', durationMs: 750 },
    ]);
    expect(sleeps).toEqual([500, 500]);
  });

  it('preserva o tipo do resultado através das duas camadas', () => {
    const { decorate } = harness(new NoRetry());
    const command = new FlakyCommand<Review>([], { verdict: 'approve' });

    expectTypeOf(decorate(command)).toEqualTypeOf<Command<Review>>();
    expectTypeOf(decorate(command).execute()).resolves.toEqualTypeOf<Review>();
  });

  it('transforma a decisão abort-run em RunAbortedError, sem retentar', async () => {
    const { events, sleeps, decorate } = harness(new AbortRun());
    const limit = new RateLimitError('Limite da assinatura atingido');
    const command = new FlakyCommand<Review>([limit], { verdict: 'approve' });

    const error = await rejection(decorate(command).execute());

    expect(error).toBeInstanceOf(RunAbortedError);
    expect((error as RunAbortedError).cause).toBe(limit);
    expect(command.executions).toBe(1);
    expect(sleeps).toEqual([]);
    expect(types(events)).toEqual(['command.started', 'command.failed']);
    expect(events[1]?.payload).toMatchObject({
      command: 'run-review',
      error: { kind: ErrorKind.RateLimit, message: 'Limite da assinatura atingido' },
    });
  });

  it('relança o erro original quando a política manda falhar', async () => {
    const { events, decorate } = harness(new NoRetry());
    const invalid = new InvalidInputError('Link de MR de outro host');
    const command = new FlakyCommand<Review>([invalid], { verdict: 'approve' });

    await expect(decorate(command).execute()).rejects.toBe(invalid);

    expect(types(events)).toEqual(['command.started', 'command.failed']);
  });

  it('desiste quando as tentativas se esgotam', async () => {
    const { events, decorate } = harness(new FixedDelayRetry(2, 0));
    const second = new InvalidOutputError('Saída fora do schema, de novo');
    const command = new FlakyCommand<Review>(
      [new InvalidOutputError('Saída fora do schema'), second],
      { verdict: 'approve' },
    );

    await expect(decorate(command).execute()).rejects.toBe(second);

    expect(command.executions).toBe(2);
    expect(types(events)).toEqual(['command.started', 'retry.scheduled', 'command.failed']);
  });

  it('normaliza um erro qualquer para AppError antes de consultar a política', async () => {
    const decide = vi.fn<RetryPolicy['decide']>(() => ({ action: 'fail' }));
    const { decorate } = harness({ decide });
    const command = new FlakyCommand<Review>([new TypeError('x is not a function')], {
      verdict: 'approve',
    });

    const error = await rejection(decorate(command).execute());

    expect(error).toBeInstanceOf(UnknownError);
    expect(decide).toHaveBeenCalledWith(error, 1);
  });

  it('deixa passar uma interrupção já decidida, sem consultar a política', async () => {
    const decide = vi.fn<RetryPolicy['decide']>(() => ({ action: 'retry', delayMs: 0 }));
    const { decorate } = harness({ decide });
    const aborted = new RunAbortedError(new RateLimitError('Limite da assinatura atingido'));
    const command = new FlakyCommand<Review>([aborted], { verdict: 'approve' });

    await expect(decorate(command).execute()).rejects.toBe(aborted);

    expect(decide).not.toHaveBeenCalled();
    expect(command.executions).toBe(1);
  });
});

describe('Decorator: a ordem das camadas importa', () => {
  it('na ordem inversa, o log sai uma vez por tentativa', async () => {
    const { events, retrying, logging } = harness(new FixedDelayRetry(2, 0));
    const command = new FlakyCommand<Review>([new TransientError('rede indisponível')], {
      verdict: 'approve',
    });

    await retrying(logging(command)).execute();

    expect(types(events)).toEqual([
      'command.started',
      'command.failed',
      'retry.scheduled',
      'command.started',
      'command.succeeded',
    ]);
  });
});

describe('Decorator: CommandDecorator', () => {
  it('tem a mesma interface do comando e repassa nome, tarefa e undo', async () => {
    const { decorate } = harness(new NoRetry());
    const command = new FlakyCommand<Review>([], { verdict: 'approve' });

    const decorated = decorate(command);
    await decorated.undo?.();

    expect(decorated).toBeInstanceOf(CommandDecorator);
    expect(decorated.name).toBe('run-review');
    expect(decorated.taskId).toBe('t1');
    expect(command.undone).toBe(1);
  });

  it('aceita um comando sem undo', async () => {
    const { decorate } = harness(new NoRetry());
    const readOnly: Command<number> = {
      name: 'fetch-changes',
      taskId: null,
      execute: () => Promise.resolve(42),
    };

    const decorated = decorate(readOnly);

    await expect(decorated.undo?.()).resolves.toBeUndefined();
    await expect(decorated.execute()).resolves.toBe(42);
  });
});
