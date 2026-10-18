import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  SDKAssistantMessageError,
  SDKResultError,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  EngineRequest,
  EngineResponse,
  ReviewEngine,
} from '../../../application/ports/review-provider.js';
import { ErrorKind } from '../../../domain/enums.js';
import { TimeoutError, createError } from '../../../domain/errors.js';

import { READ_ONLY_TOOLS, createReadOnlyGuard } from './read-only-guard.js';

/** Nomes sem escopo: removem a ferramenta do contexto, como defesa em profundidade. */
const DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
] as const;

/** Erro de API sinalizado na mensagem `assistant` -> tipo que decide a retentativa. */
const API_ERROR_KIND: Readonly<Record<SDKAssistantMessageError, ErrorKind>> = {
  rate_limit: ErrorKind.RateLimit,
  overloaded: ErrorKind.Transient,
  server_error: ErrorKind.Transient,
  authentication_failed: ErrorKind.Configuration,
  billing_error: ErrorKind.Configuration,
  oauth_org_not_allowed: ErrorKind.Configuration,
  account_on_hold: ErrorKind.Configuration,
  verification_required: ErrorKind.Configuration,
  cloud_credential_error: ErrorKind.Configuration,
  model_not_found: ErrorKind.Configuration,
  max_output_tokens: ErrorKind.InvalidOutput,
  invalid_request: ErrorKind.Unknown,
  unknown: ErrorKind.Unknown,
};

/** Falha do review no `subtype` da mensagem `result` -> tipo que decide a retentativa. */
const RESULT_ERROR_KIND: Readonly<Record<SDKResultError['subtype'], ErrorKind>> = {
  error_max_turns: ErrorKind.InvalidOutput,
  error_max_structured_output_retries: ErrorKind.InvalidOutput,
  error_max_budget_usd: ErrorKind.Configuration,
  // Sem um erro de API anterior, não há como saber o que houve.
  error_during_execution: ErrorKind.Unknown,
};

export interface ClaudeEngineSettings {
  readonly oauthToken: string;
  readonly maxTurns: number;
  /** Sem ele, vale o modelo padrão da CLI para a assinatura. */
  readonly model?: string;
  /** De onde vêm `PATH` e `HOME` do processo do Claude. Padrão: o ambiente do processo. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * Abstract Factory (ConcreteProduct) e Adapter (Adapter): adapta a função
 * `query()` do Claude Agent SDK para a porta `ReviewEngine`.
 *
 * As opções formam a postura de segurança da ARCHITECTURE §12: o modelo só lê,
 * só dentro do worktree, sem configuração vinda do repositório revisado e sem
 * os tokens do GitLab e do Notion.
 */
export class ClaudeAgentEngine implements ReviewEngine {
  constructor(private readonly settings: ClaudeEngineSettings) {}

  async review(request: EngineRequest): Promise<EngineResponse> {
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    if (request.signal?.aborted) abort();
    request.signal?.addEventListener('abort', abort, { once: true });

    let apiError: SDKAssistantMessageError | undefined;
    let result: SDKResultMessage | undefined;
    let thrown: unknown;
    try {
      const messages = query({
        prompt: request.prompt.user,
        options: this.options(request, controller),
      });
      for await (const message of messages) {
        if (message.type === 'assistant') {
          if (message.error) apiError = message.error;
        } else if (message.type === 'rate_limit_event') {
          // O limite da assinatura também chega como evento próprio.
          if (message.rate_limit_info.status === 'rejected') apiError = 'rate_limit';
        } else if (message.type === 'result') {
          result = message;
        }
      }
    } catch (error) {
      // `query()` lança depois de emitir um resultado de erro; a classificação
      // usa o resultado e o último erro de API vistos antes da exceção.
      thrown = error;
    } finally {
      request.signal?.removeEventListener('abort', abort);
    }

    if (controller.signal.aborted) {
      throw new TimeoutError(
        'O review passou do tempo limite',
        { taskId: request.correlation.taskId },
        { cause: thrown },
      );
    }
    return interpret(result, apiError, thrown);
  }

  private options(request: EngineRequest, abortController: AbortController): Options {
    const { oauthToken, maxTurns, model, baseEnv = process.env } = this.settings;
    return {
      cwd: request.workingDirectory,
      tools: [...READ_ONLY_TOOLS],
      allowedTools: [...READ_ONLY_TOOLS],
      disallowedTools: [...DISALLOWED_TOOLS],
      // Explícito: se omitido, o modo inicial pode ser `auto`.
      permissionMode: 'dontAsk',
      // Nada de CLAUDE.md, settings, hooks ou MCP do repositório revisado.
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      hooks: { PreToolUse: [{ hooks: [createReadOnlyGuard(request.workingDirectory)] }] },
      systemPrompt: request.prompt.system,
      outputFormat: { type: 'json_schema', schema: { ...request.outputSchema } },
      maxTurns,
      abortController,
      // Substitui o ambiente inteiro: os tokens do GitLab e do Notion não chegam ao Claude.
      env: { PATH: baseEnv.PATH, HOME: baseEnv.HOME, CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
      ...(model === undefined ? {} : { model }),
    };
  }
}

/** Só é sucesso com `subtype: success`, sem `is_error` e com `structured_output`. */
function interpret(
  result: SDKResultMessage | undefined,
  apiError: SDKAssistantMessageError | undefined,
  thrown: unknown,
): EngineResponse {
  if (result?.subtype === 'success' && !result.is_error && result.structured_output !== undefined) {
    return {
      text: result.result,
      structured: result.structured_output,
      usage: {
        durationMs: result.duration_ms,
        turns: result.num_turns,
        costUsd: result.total_cost_usd,
      },
    };
  }

  const fromApi = apiError === undefined ? ErrorKind.Unknown : API_ERROR_KIND[apiError];
  let kind: ErrorKind;
  let reason: string;
  if (result === undefined) {
    kind = fromApi;
    reason = apiError ?? 'a sessão terminou sem resultado';
  } else if (result.subtype !== 'success') {
    const useApiError = result.subtype === 'error_during_execution' && apiError !== undefined;
    kind = useApiError ? fromApi : RESULT_ERROR_KIND[result.subtype];
    reason = useApiError ? apiError : result.subtype;
  } else if (result.is_error) {
    kind = fromApi;
    reason = apiError ?? 'o turno terminou em erro de API';
  } else {
    kind = ErrorKind.InvalidOutput;
    reason = 'a resposta veio sem saída estruturada';
  }

  throw createError(
    kind,
    `O review com o Claude falhou: ${reason}`,
    {
      ...(apiError === undefined ? {} : { apiError }),
      ...(result === undefined ? {} : { subtype: result.subtype }),
      ...(result !== undefined && result.subtype !== 'success' && result.errors.length > 0
        ? { errors: result.errors }
        : {}),
    },
    thrown === undefined ? undefined : { cause: thrown },
  );
}
