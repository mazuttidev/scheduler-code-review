import { setTimeout as delay } from 'node:timers/promises';

import type { ErrorKind } from '../../domain/enums.js';
import { RunAbortedError, toAppError } from '../../domain/errors.js';
import type { PipelineEvents } from '../../domain/events.js';
import type { Command } from '../commands/command.js';
import type { EventPublisher } from '../events/event-bus.js';
import type { RetryPolicy } from '../retry/retry-policy.js';

/**
 * Decorator (Decorator): envolve um comando e tem a mesma interface dele.
 * Por padrão só repassa as chamadas; cada subclasse acrescenta uma responsabilidade.
 */
export abstract class CommandDecorator<T> implements Command<T> {
  constructor(protected readonly inner: Command<T>) {}

  get name(): string {
    return this.inner.name;
  }

  get taskId(): string | null {
    return this.inner.taskId;
  }

  execute(): Promise<T> {
    return this.inner.execute();
  }

  async undo(): Promise<void> {
    await this.inner.undo?.();
  }
}

/** Decorator (ConcreteDecorator): acrescenta retentativa a qualquer Command. */
export class RetryingCommand<T> extends CommandDecorator<T> {
  constructor(
    inner: Command<T>,
    private readonly policy: RetryPolicy,
    private readonly events: EventPublisher<PipelineEvents>,
    private readonly sleep: (ms: number) => Promise<unknown> = (ms) => delay(ms),
  ) {
    super(inner);
  }

  override async execute(): Promise<T> {
    // Conta falhas por tipo: uma falha de rede não consome a cota de "saída inválida".
    const failuresByKind = new Map<ErrorKind, number>();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.inner.execute();
      } catch (thrown) {
        // Uma interrupção já decidida por uma camada interna não é reavaliada.
        if (thrown instanceof RunAbortedError) throw thrown;
        const error = toAppError(thrown);
        const failures = (failuresByKind.get(error.kind) ?? 0) + 1;
        failuresByKind.set(error.kind, failures);
        const decision = this.policy.decide(error, failures);
        if (decision.action === 'abort-run') throw new RunAbortedError(error);
        if (decision.action === 'fail') throw error;
        this.events.emit('retry.scheduled', {
          command: this.name,
          taskId: this.taskId,
          attempt,
          delayMs: decision.delayMs,
          errorKind: error.kind,
          message: error.message,
        });
        await this.sleep(decision.delayMs);
      }
    }
  }
}

/** Decorator (ConcreteDecorator): registra início, fim, duração e erro de qualquer Command. */
export class LoggingCommand<T> extends CommandDecorator<T> {
  constructor(
    inner: Command<T>,
    private readonly events: EventPublisher<PipelineEvents>,
    private readonly now: () => number = () => Date.now(),
  ) {
    super(inner);
  }

  override async execute(): Promise<T> {
    const ref = { command: this.name, taskId: this.taskId };
    const startedAt = this.now();
    this.events.emit('command.started', ref);
    try {
      const result = await this.inner.execute();
      this.events.emit('command.succeeded', { ...ref, durationMs: this.now() - startedAt });
      return result;
    } catch (thrown) {
      this.events.emit('command.failed', {
        ...ref,
        durationMs: this.now() - startedAt,
        error: toAppError(thrown).toJSON(),
      });
      throw thrown;
    }
  }
}
