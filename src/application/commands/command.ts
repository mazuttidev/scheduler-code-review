/**
 * Command (Command): uma etapa do pipeline como objeto. Isso permite tratar
 * todas as etapas do mesmo jeito: decorar, registrar no histórico e desfazer.
 */
export interface Command<T> {
  readonly name: string;
  /** `null` nas etapas da execução, que não pertencem a uma tarefa. */
  readonly taskId: string | null;
  execute(): Promise<T>;
  /**
   * Desfaz o efeito de um `execute` que terminou com sucesso. Um comando que
   * falha no meio limpa o próprio efeito parcial antes de relançar o erro.
   */
  undo?(): Promise<void>;
}

/** Função que envolve qualquer comando, preservando o tipo do resultado. */
export type CommandDecoration = <T>(command: Command<T>) => Command<T>;
