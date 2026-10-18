import type { ProviderKind } from '../../domain/enums.js';
import type { InvalidOutputError } from '../../domain/errors.js';
import type { ReviewOutput } from '../../domain/review-output.js';
import type { Result } from '../../shared/types.js';
import type { ReviewPrompt } from '../prompt/review-prompt.js';

/**
 * Abstract Factory (AbstractFactory): cria as três peças de um provedor de IA,
 * que precisam ser compatíveis entre si.
 */
export interface ReviewProviderFactory {
  readonly kind: ProviderKind;
  createPromptFormatter(): PromptFormatter;
  createEngine(): ReviewEngine;
  createResponseParser(): ResponseParser;
}

/** Prompt já no formato que o provedor entende melhor. */
export interface FormattedPrompt {
  readonly system: string;
  readonly user: string;
}

/** Abstract Factory (AbstractProduct): transforma o prompt neutro em texto. */
export interface PromptFormatter {
  format(prompt: ReviewPrompt): FormattedPrompt;
}

export interface EngineRequest {
  readonly prompt: FormattedPrompt;
  readonly workingDirectory: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly correlation: Readonly<{ runId: string; taskId: string }>;
  readonly signal?: AbortSignal;
}

export interface EngineResponse {
  readonly text: string;
  /** Saída estruturada, quando o provedor a entrega (Agent SDK: `structured_output`). */
  readonly structured?: unknown;
  readonly usage: {
    readonly durationMs: number;
    readonly turns?: number;
    readonly costUsd?: number;
  };
}

/** Abstract Factory (AbstractProduct): conversa com o provedor e executa o review. */
export interface ReviewEngine {
  review(request: EngineRequest): Promise<EngineResponse>;
}

/** Abstract Factory (AbstractProduct): interpreta a resposta daquele provedor. */
export interface ResponseParser {
  parse(response: EngineResponse): Result<ReviewOutput, InvalidOutputError>;
}
