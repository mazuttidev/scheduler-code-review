import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { TaskSource } from '../../application/ports/task-source.js';
import { TaskSourceKind } from '../../domain/enums.js';
import { ConfigurationError } from '../../domain/errors.js';
import type { ReviewTask } from '../../domain/review-task.js';

const TaskSchema = z.strictObject({
  // O ID vira nome de pasta; só caracteres seguros, e nunca `.` ou `..`.
  id: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .refine((id) => !/^\.+$/.test(id)),
  title: z.string().min(1),
  url: z.string().min(1).optional(),
  description: z.string().default(''),
  businessRules: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  mergeRequestUrl: z.string().min(1).nullable().default(null),
});

const TaskFileSchema = z.array(TaskSchema);

/**
 * Adapter (Adapter): faz um arquivo JSON se comportar como um gerenciador de
 * tarefas. Todas as tarefas do arquivo contam como "em revisão". Serve à
 * demonstração, aos testes e a quem ainda não usa uma plataforma integrada.
 */
export class JsonFileTaskSource implements TaskSource {
  readonly kind = TaskSourceKind.JsonFile;

  constructor(private readonly filePath: string) {}

  async fetchPending(limit: number): Promise<readonly ReviewTask[]> {
    const entries = TaskFileSchema.safeParse(await this.readJson());
    if (!entries.success) {
      throw this.invalid('O arquivo de tarefas está fora do formato esperado', {
        issues: z.prettifyError(entries.error),
      });
    }

    const ids = entries.data.map((entry) => entry.id);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (repeated.length > 0) {
      throw this.invalid('O arquivo de tarefas tem IDs repetidos', {
        repeated: [...new Set(repeated)],
      });
    }

    const fileUrl = pathToFileURL(this.filePath).href;
    return entries.data.slice(0, limit).map((entry) => ({
      id: entry.id,
      source: this.kind,
      url: entry.url ?? `${fileUrl}#${entry.id}`,
      title: entry.title,
      description: entry.description,
      businessRules: entry.businessRules,
      acceptanceCriteria: entry.acceptanceCriteria,
      mergeRequestUrl: entry.mergeRequestUrl,
    }));
  }

  private async readJson(): Promise<unknown> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (cause) {
      throw this.invalid('Não foi possível ler o arquivo de tarefas', {}, { cause });
    }
    try {
      return JSON.parse(content) as unknown;
    } catch (cause) {
      throw this.invalid('O arquivo de tarefas não é um JSON válido', {}, { cause });
    }
  }

  private invalid(
    message: string,
    details: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ): ConfigurationError {
    return new ConfigurationError(message, { path: this.filePath, ...details }, options);
  }
}
