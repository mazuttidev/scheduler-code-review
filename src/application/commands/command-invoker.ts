import { toAppError } from '../../domain/errors.js';
import type { PipelineEvents } from '../../domain/events.js';
import type { EventPublisher } from '../events/event-bus.js';

import type { Command, CommandDecoration } from './command.js';

/**
 * Command (Invoker): executa os comandos de uma tarefa, guarda o histórico do
 * que terminou com sucesso e sabe desfazê-lo em ordem reversa.
 */
export class CommandInvoker {
  private readonly history: Command<unknown>[] = [];

  constructor(
    private readonly decorate: CommandDecoration,
    private readonly events: EventPublisher<PipelineEvents>,
  ) {}

  /** Nomes dos comandos que terminaram com sucesso, na ordem de execução. */
  get executed(): readonly string[] {
    return this.history.map((command) => command.name);
  }

  async run<T>(command: Command<T>): Promise<T> {
    const result = await this.decorate(command).execute();
    this.history.push(command);
    return result;
  }

  /** Desfaz o histórico do mais recente para o mais antigo. Nunca lança. */
  async rollback(): Promise<void> {
    for (let command = this.history.pop(); command; command = this.history.pop()) {
      if (!command.undo) continue;
      const ref = { command: command.name, taskId: command.taskId };
      try {
        await command.undo();
        this.events.emit('command.undone', ref);
      } catch (thrown) {
        // Uma falha ao desfazer fica registrada e não impede os demais.
        this.events.emit('command.undone', { ...ref, error: toAppError(thrown).toJSON() });
      }
    }
  }
}
