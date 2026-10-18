import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

const LockSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string().min(1) });
type LockContent = z.infer<typeof LockSchema>;

export interface RunLockOptions {
  readonly pid?: number;
  readonly now?: () => Date;
  /** Diz se o processo do PID ainda existe. Injetável para os testes. */
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * Impede duas execuções simultâneas. O arquivo guarda o PID e o horário de
 * início; um lock deixado por um processo que já morreu é substituído.
 *
 * As operações são síncronas para poderem rodar num tratador de sinal.
 */
export class RunLock {
  private readonly pid: number;
  private readonly now: () => Date;
  private readonly isAlive: (pid: number) => boolean;

  constructor(
    private readonly filePath: string,
    options: RunLockOptions = {},
  ) {
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.isAlive = options.isAlive ?? isProcessAlive;
  }

  /** Tenta assumir o lock. Devolve `false` se outra execução viva o detém. */
  acquire(): boolean {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    if (this.tryCreate()) return true;

    const holder = this.read();
    if (holder && holder.pid !== this.pid && this.isAlive(holder.pid)) return false;

    // Lock ilegível, nosso ou de um processo morto: substitui.
    rmSync(this.filePath, { force: true });
    return this.tryCreate();
  }

  /** Solta o lock, se ele for desta execução. */
  release(): void {
    if (this.read()?.pid === this.pid) rmSync(this.filePath, { force: true });
  }

  /** Quem detém o lock agora, ou `null`. */
  holder(): LockContent | null {
    return this.read();
  }

  private tryCreate(): boolean {
    const content: LockContent = { pid: this.pid, startedAt: this.now().toISOString() };
    try {
      // `wx` falha se o arquivo já existe: a criação é a disputa pelo lock.
      writeFileSync(this.filePath, `${JSON.stringify(content)}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (hasCode(error, 'EEXIST')) return false;
      throw error;
    }
  }

  private read(): LockContent | null {
    try {
      const parsed = LockSchema.safeParse(JSON.parse(readFileSync(this.filePath, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // O sinal 0 não mata nada: só testa se o processo existe.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: o processo existe, mas é de outro usuário.
    return hasCode(error, 'EPERM');
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
