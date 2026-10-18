import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Início do `runId`: `2026-10-12T05-55-00Z-…`. */
const RUN_ID_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z-/;

export interface RunRetentionOptions {
  /** Execuções iniciadas há mais dias que isto são apagadas. */
  readonly days: number;
  readonly now: Date;
  /** Execução atual, que nunca é apagada. */
  readonly keep?: string;
}

/**
 * Apaga as pastas de execuções antigas em `runs/`. A idade vem do horário que
 * está no próprio `runId`, não da data do arquivo; pastas com outro nome não
 * são tocadas. Devolve os `runId` removidos.
 */
export async function pruneOldRuns(
  runsDirectory: string,
  options: RunRetentionOptions,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDirectory);
  } catch {
    return [];
  }

  const cutoff = options.now.getTime() - options.days * DAY_MS;
  const removed: string[] = [];
  for (const entry of entries.sort()) {
    if (entry === options.keep) continue;
    const startedAt = runStartedAt(entry);
    if (startedAt === null || startedAt >= cutoff) continue;
    await rm(join(runsDirectory, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

function runStartedAt(runId: string): number | null {
  const match = RUN_ID_TIMESTAMP.exec(runId);
  if (!match) return null;
  const [, date = '', hours = '', minutes = '', seconds = ''] = match;
  const time = Date.parse(`${date}T${hours}:${minutes}:${seconds}Z`);
  return Number.isNaN(time) ? null : time;
}
