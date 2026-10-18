import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type {
  ReviewStateStore,
  ReviewedEntry,
} from '../../application/ports/review-state-store.js';
import { Verdict } from '../../domain/enums.js';
import { ConfigurationError } from '../../domain/errors.js';
import { writeFileAtomic } from '../../shared/fs.js';

const EntrySchema = z.object({
  taskId: z.string().min(1),
  headSha: z.string().min(1),
  runId: z.string().min(1),
  reviewedAt: z.string().min(1),
  verdict: z.enum(Verdict),
});

/** `"<taskId>:<headSha>"` -> entrada. */
const StateSchema = z.record(z.string(), EntrySchema);
type State = Readonly<Record<string, ReviewedEntry>>;

/**
 * Estado de idempotência num arquivo JSON (`state/reviewed.json`).
 *
 * Arquivo ausente significa que nada foi revisado. Arquivo ilegível ou fora do
 * formato é erro de configuração: a execução para, em vez de revisar de novo,
 * sem aviso, tudo que já tinha sido revisado.
 */
export class JsonFileStateStore implements ReviewStateStore {
  constructor(private readonly filePath: string) {}

  async wasReviewed(taskId: string, headSha: string): Promise<boolean> {
    return Object.hasOwn(await this.read(), stateKey(taskId, headSha));
  }

  async markReviewed(entry: ReviewedEntry): Promise<void> {
    const state = await this.read();
    await this.write({ ...state, [stateKey(entry.taskId, entry.headSha)]: entry });
  }

  async unmark(taskId: string, headSha: string): Promise<void> {
    const state = await this.read();
    const key = stateKey(taskId, headSha);
    if (!Object.hasOwn(state, key)) return;
    await this.write(Object.fromEntries(Object.entries(state).filter(([other]) => other !== key)));
  }

  private async read(): Promise<State> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) return {};
      throw this.unreadable('Não foi possível ler o estado dos reviews', { cause });
    }

    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (cause) {
      throw this.unreadable('O estado dos reviews não é um JSON válido', { cause });
    }

    const result = StateSchema.safeParse(json);
    if (!result.success) {
      throw new ConfigurationError('O estado dos reviews está fora do formato esperado', {
        path: this.filePath,
        issues: z.prettifyError(result.error),
      });
    }
    return result.data;
  }

  private async write(state: State): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private unreadable(message: string, options: ErrorOptions): ConfigurationError {
    return new ConfigurationError(message, { path: this.filePath }, options);
  }
}

function stateKey(taskId: string, headSha: string): string {
  return `${taskId}:${headSha}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
