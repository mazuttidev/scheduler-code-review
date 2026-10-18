import { z } from 'zod';

import type {
  EngineResponse,
  PromptFormatter,
  ResponseParser,
  ReviewEngine,
  ReviewProviderFactory,
} from '../../../application/ports/review-provider.js';
import { ProviderKind } from '../../../domain/enums.js';
import { InvalidOutputError } from '../../../domain/errors.js';
import { ReviewOutputSchema } from '../../../domain/review-output.js';
import type { ReviewOutput } from '../../../domain/review-output.js';
import { err, ok } from '../../../shared/types.js';
import type { Result } from '../../../shared/types.js';

import { ClaudeAgentEngine } from './claude-agent-engine.js';
import type { ClaudeEngineSettings } from './claude-agent-engine.js';
import { XmlSectionsPromptFormatter } from './xml-sections-prompt-formatter.js';

/**
 * Abstract Factory (ConcreteFactory): a família do Claude. O formatador usa
 * seções em XML, o motor fala com o Agent SDK e o parser lê o campo
 * `structured_output` que esse motor entrega.
 */
export class ClaudeProviderFactory implements ReviewProviderFactory {
  readonly kind = ProviderKind.Claude;

  constructor(private readonly settings: ClaudeEngineSettings) {}

  createPromptFormatter(): PromptFormatter {
    return new XmlSectionsPromptFormatter();
  }

  createEngine(): ReviewEngine {
    return new ClaudeAgentEngine(this.settings);
  }

  createResponseParser(): ResponseParser {
    return new StructuredOutputParser();
  }
}

/**
 * Abstract Factory (ConcreteProduct): lê o review da saída estruturada. O SDK
 * já valida o JSON Schema; aqui o Zod valida de novo, com as regras completas.
 */
export class StructuredOutputParser implements ResponseParser {
  parse(response: EngineResponse): Result<ReviewOutput, InvalidOutputError> {
    if (response.structured === undefined) {
      return err(new InvalidOutputError('A resposta não trouxe a saída estruturada'));
    }
    const result = ReviewOutputSchema.safeParse(response.structured);
    if (!result.success) {
      return err(
        new InvalidOutputError('A saída estruturada não segue o schema', {
          issues: z.prettifyError(result.error),
        }),
      );
    }
    return ok(result.data);
  }
}
