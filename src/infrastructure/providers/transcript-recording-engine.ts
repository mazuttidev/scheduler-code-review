import { join } from 'node:path';

import type {
  EngineRequest,
  EngineResponse,
  FormattedPrompt,
  ReviewEngine,
} from '../../application/ports/review-provider.js';
import { toAppError } from '../../domain/errors.js';
import { toPathSegment, writeFileAtomic } from '../../shared/fs.js';
import type { Redactor } from '../logging/observers.js';

/**
 * Decorator (ConcreteDecorator): envolve qualquer `ReviewEngine` e grava o
 * prompt e a resposta, ou o erro, de cada tentativa. Funciona com o Claude,
 * com o motor falso ou com um provedor futuro.
 *
 * Se uma transcrição não puder ser gravada, a tentativa falha.
 */
export class TranscriptRecordingEngine implements ReviewEngine {
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly inner: ReviewEngine,
    /** Pasta `transcripts/` da execução. */
    private readonly directory: string,
    private readonly redact: Redactor,
  ) {}

  async review(request: EngineRequest): Promise<EngineResponse> {
    const { taskId } = request.correlation;
    const attempt = (this.attempts.get(taskId) ?? 0) + 1;
    this.attempts.set(taskId, attempt);
    const base = join(this.directory, toPathSegment(taskId), `attempt-${String(attempt)}`);

    // Antes de chamar o motor: sem transcrição do prompt, a IA não é consultada.
    await this.write(`${base}.prompt.md`, renderPrompt(request.prompt));

    let response: EngineResponse;
    try {
      response = await this.inner.review(request);
    } catch (thrown) {
      // A tentativa já falhou; um erro ao gravar não pode esconder o original.
      await this.write(`${base}.error.json`, toJson(toAppError(thrown).toJSON())).catch(
        () => undefined,
      );
      throw thrown;
    }
    await this.write(`${base}.response.json`, toJson(response));
    return response;
  }

  private write(filePath: string, content: string): Promise<void> {
    return writeFileAtomic(filePath, this.redact(content));
  }
}

function renderPrompt(prompt: FormattedPrompt): string {
  return `# System\n\n${prompt.system}\n\n# User\n\n${prompt.user}\n`;
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
