import { ErrorKind } from './enums.js';

export type ErrorDetails = Readonly<Record<string, unknown>>;

/** Forma serializável de um erro, usada em eventos, manifesto e transcrições. */
export interface SerializedError {
  readonly name: string;
  readonly kind: ErrorKind;
  readonly message: string;
  readonly details?: ErrorDetails;
  readonly cause?: { readonly name: string; readonly message: string };
  /** Só em `ErrorKind.Unknown`, onde ajuda a investigar a falha. */
  readonly stack?: string;
}

/**
 * Base dos erros esperados da aplicação. Cada subclasse fixa o seu `kind`,
 * que decide a política de retentativa.
 */
export abstract class AppError extends Error {
  abstract readonly kind: ErrorKind;
  readonly details: ErrorDetails;

  constructor(message: string, details: ErrorDetails = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.details = details;
  }

  toJSON(): SerializedError {
    const cause = serializeCause(this.cause);
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
      ...(cause ? { cause } : {}),
      ...(this.kind === ErrorKind.Unknown && this.stack ? { stack: this.stack } : {}),
    };
  }
}

export class RateLimitError extends AppError {
  readonly kind = ErrorKind.RateLimit;
}

export class TransientError extends AppError {
  readonly kind = ErrorKind.Transient;
  /** Espera pedida pelo serviço (`Retry-After`), quando houver. */
  declare readonly retryAfterMs?: number;

  constructor(
    message: string,
    details: ErrorDetails = {},
    options: ErrorOptions & { readonly retryAfterMs?: number } = {},
  ) {
    super(message, details, options);
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export class TimeoutError extends AppError {
  readonly kind = ErrorKind.Timeout;
}

export class InvalidOutputError extends AppError {
  readonly kind = ErrorKind.InvalidOutput;
}

export class InvalidInputError extends AppError {
  readonly kind = ErrorKind.InvalidInput;
}

export class NotFoundError extends AppError {
  readonly kind = ErrorKind.NotFound;
}

export class ConfigurationError extends AppError {
  readonly kind = ErrorKind.Configuration;
}

export class UnknownError extends AppError {
  readonly kind = ErrorKind.Unknown;
}

/**
 * Sinal de controle: interrompe a execução inteira. Não é um `AppError`
 * porque não tem tipo próprio; o erro que causou a interrupção fica em `cause`.
 */
export class RunAbortedError extends Error {
  // `declare` só estreita o tipo: quem define `cause` é o construtor de Error,
  // que o mantém não enumerável, como em qualquer erro.
  declare readonly cause: AppError;

  constructor(cause: AppError) {
    super(`Execução interrompida: ${cause.message}`, { cause });
    this.name = 'RunAbortedError';
  }
}

type AppErrorConstructor = new (
  message: string,
  details?: ErrorDetails,
  options?: ErrorOptions,
) => AppError;

const ERROR_CLASSES: Readonly<Record<ErrorKind, AppErrorConstructor>> = {
  [ErrorKind.RateLimit]: RateLimitError,
  [ErrorKind.Transient]: TransientError,
  [ErrorKind.Timeout]: TimeoutError,
  [ErrorKind.InvalidOutput]: InvalidOutputError,
  [ErrorKind.InvalidInput]: InvalidInputError,
  [ErrorKind.NotFound]: NotFoundError,
  [ErrorKind.Configuration]: ConfigurationError,
  [ErrorKind.Unknown]: UnknownError,
};

/** Cria o erro da classe correspondente ao tipo. */
export function createError(
  kind: ErrorKind,
  message: string,
  details?: ErrorDetails,
  options?: ErrorOptions,
): AppError {
  return new ERROR_CLASSES[kind](message, details, options);
}

/**
 * Normaliza qualquer valor lançado. Classificar erros de rede ou de API é
 * papel dos adapters; aqui, o que não for `AppError` vira `UnknownError`.
 */
export function toAppError(thrown: unknown): AppError {
  if (thrown instanceof AppError) return thrown;
  if (thrown instanceof RunAbortedError) return thrown.cause;
  if (thrown instanceof Error) {
    const error = new UnknownError(
      thrown.message || 'Erro desconhecido',
      { originalName: thrown.name },
      { cause: thrown },
    );
    // O stack útil é o do erro original, não o desta conversão.
    if (thrown.stack) error.stack = thrown.stack;
    return error;
  }
  return new UnknownError(describeThrown(thrown));
}

function serializeCause(cause: unknown): SerializedError['cause'] {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return { name: 'NonError', message: describeThrown(cause) };
}

function describeThrown(value: unknown): string {
  if (typeof value === 'string') return value || 'Erro desconhecido';
  if (typeof value === 'bigint') return value.toString();
  try {
    // Apesar do tipo declarado, o resultado é undefined para undefined,
    // funções, símbolos e objetos cujo toJSON devolve undefined.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? typeof value;
  } catch {
    return typeof value;
  }
}
