import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Transforma um identificador externo num nome seguro de pasta ou arquivo:
 * sem separadores de caminho e nunca `.` ou `..`.
 */
export function toPathSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return /^\.*$/.test(cleaned) ? '_' : cleaned;
}

export interface WriteFileAtomicOptions {
  /** Modo do arquivo. Padrão: 600. */
  readonly mode?: number;
  /** Modo dos diretórios criados. Padrão: 700. */
  readonly directoryMode?: number;
}

/**
 * Grava o arquivo sem deixar conteúdo parcial: escreve num temporário do mesmo
 * diretório e renomeia. Quem lê vê o arquivo antigo ou o novo, nunca a metade.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const { mode = 0o600, directoryMode = 0o700 } = options;
  await mkdir(dirname(filePath), { recursive: true, mode: directoryMode });

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, 'wx', mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    // Uma falha na limpeza não pode esconder o erro da gravação.
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Versão síncrona de `writeFileAtomic`, com as mesmas garantias. Serve a quem
 * grava dentro de um observador de eventos, onde a notificação é síncrona.
 */
export function writeFileAtomicSync(
  filePath: string,
  content: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): void {
  const { mode = 0o600, directoryMode = 0o700 } = options;
  mkdirSync(dirname(filePath), { recursive: true, mode: directoryMode });

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporaryPath, 'wx', mode);
    try {
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Uma falha na limpeza não pode esconder o erro da gravação.
    }
    throw error;
  }
}
