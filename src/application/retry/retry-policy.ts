import { ErrorKind } from '../../domain/enums.js';
import { TransientError } from '../../domain/errors.js';
import type { AppError } from '../../domain/errors.js';

export type RetryDecision =
  | { readonly action: 'retry'; readonly delayMs: number }
  | { readonly action: 'fail' }
  | { readonly action: 'abort-run' };

/**
 * Strategy (Strategy): decide o que fazer depois de uma falha.
 *
 * `failures` é o número de falhas daquele tipo de erro, contando a atual.
 */
export interface RetryPolicy {
  decide(error: AppError, failures: number): RetryDecision;
}

const FAIL: RetryDecision = { action: 'fail' };

/** Strategy (ConcreteStrategy): reprova a tarefa na primeira falha. */
export class NoRetry implements RetryPolicy {
  decide(): RetryDecision {
    return FAIL;
  }
}

/** Strategy (ConcreteStrategy): interrompe a execução inteira. */
export class AbortRun implements RetryPolicy {
  decide(): RetryDecision {
    return { action: 'abort-run' };
  }
}

/**
 * Strategy (ConcreteStrategy): tenta de novo com espera fixa.
 * `maxAttempts` conta as execuções totais, incluindo a primeira.
 */
export class FixedDelayRetry implements RetryPolicy {
  constructor(
    private readonly maxAttempts: number,
    private readonly delayMs: number,
  ) {}

  decide(_error: AppError, failures: number): RetryDecision {
    return failures < this.maxAttempts ? { action: 'retry', delayMs: this.delayMs } : FAIL;
  }
}

export interface ExponentialBackoffOptions {
  /** Execuções totais, incluindo a primeira. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  /** Teto da espera calculada. Não limita o `Retry-After` do serviço. */
  readonly maxDelayMs: number;
  /** Sorteia a espera entre 50% e 100% do valor calculado. */
  readonly jitter?: boolean;
  /** Fonte de aleatoriedade injetável, em [0, 1). */
  readonly random?: () => number;
}

/**
 * Strategy (ConcreteStrategy): dobra a espera a cada falha, até um teto.
 * Quando o serviço pede uma espera (`Retry-After`), ela é sempre respeitada.
 */
export class ExponentialBackoffRetry implements RetryPolicy {
  private readonly random: () => number;

  constructor(private readonly options: ExponentialBackoffOptions) {
    this.random = options.random ?? (() => Math.random());
  }

  decide(error: AppError, failures: number): RetryDecision {
    const { maxAttempts, baseDelayMs, maxDelayMs, jitter = false } = this.options;
    if (failures >= maxAttempts) return FAIL;

    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (failures - 1));
    const backoff = jitter ? Math.round(exponential * (0.5 + this.random() * 0.5)) : exponential;
    const requested = error instanceof TransientError ? (error.retryAfterMs ?? 0) : 0;
    return { action: 'retry', delayMs: Math.max(backoff, requested) };
  }
}

/**
 * Strategy (ConcreteStrategy): escolhe a estratégia pelo tipo do erro. O
 * `Record` obriga a definir uma política para cada `ErrorKind`.
 */
export class ErrorKindRetryPolicy implements RetryPolicy {
  constructor(private readonly byKind: Readonly<Record<ErrorKind, RetryPolicy>>) {}

  decide(error: AppError, failures: number): RetryDecision {
    return this.byKind[error.kind].decide(error, failures);
  }
}

/** Políticas padrão da ARCHITECTURE §9. */
export function defaultRetryPolicies(
  options: { readonly random?: () => number } = {},
): Record<ErrorKind, RetryPolicy> {
  return {
    [ErrorKind.RateLimit]: new AbortRun(),
    [ErrorKind.Configuration]: new AbortRun(),
    [ErrorKind.Transient]: new ExponentialBackoffRetry({
      maxAttempts: 4,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
      jitter: true,
      random: options.random,
    }),
    [ErrorKind.Timeout]: new FixedDelayRetry(2, 10_000),
    [ErrorKind.InvalidOutput]: new FixedDelayRetry(2, 0),
    [ErrorKind.InvalidInput]: new NoRetry(),
    [ErrorKind.NotFound]: new NoRetry(),
    [ErrorKind.Unknown]: new NoRetry(),
  };
}
