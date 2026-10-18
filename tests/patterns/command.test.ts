import { describe, expect, expectTypeOf, it } from 'vitest';

import { CommandInvoker } from '../../src/application/commands/command-invoker.js';
import type { Command, CommandDecoration } from '../../src/application/commands/command.js';
import { EventBus } from '../../src/application/events/event-bus.js';
import { ErrorKind } from '../../src/domain/enums.js';
import { NotFoundError } from '../../src/domain/errors.js';
import type { EventEnvelope, PipelineEvents } from '../../src/domain/events.js';

/**
 * Command no nightly-review.
 *
 * - Command: `Command<T>`, uma etapa do pipeline como objeto.
 * - ConcreteCommand: aqui, `StepCommand`; no sistema, as oito etapas de uma tarefa.
 * - Invoker: `CommandInvoker`, criado para cada tarefa.
 *
 * O invoker trata todas as etapas do mesmo jeito, guarda o histórico e desfaz
 * em ordem reversa o que já tinha sido feito quando uma etapa posterior falha.
 */

/** ConcreteCommand de teste: anota num diário o que fez e o que desfez. */
class StepCommand implements Command<string> {
  readonly taskId = 't1';

  constructor(
    readonly name: string,
    private readonly journal: string[],
    private readonly failures: { readonly execute?: Error; readonly undo?: Error } = {},
  ) {}

  execute(): Promise<string> {
    if (this.failures.execute) return Promise.reject(this.failures.execute);
    this.journal.push(`execute ${this.name}`);
    return Promise.resolve(`resultado de ${this.name}`);
  }

  undo(): Promise<void> {
    if (this.failures.undo) return Promise.reject(this.failures.undo);
    this.journal.push(`undo ${this.name}`);
    return Promise.resolve();
  }
}

const plain: CommandDecoration = (command) => command;

function setup(decorate: CommandDecoration = plain) {
  const bus = new EventBus<PipelineEvents>();
  const events: EventEnvelope<PipelineEvents>[] = [];
  bus.onAny((envelope) => events.push(envelope));
  const journal: string[] = [];
  return { journal, events, invoker: new CommandInvoker(decorate, bus) };
}

function undone(events: readonly EventEnvelope<PipelineEvents>[]) {
  return events.filter((event) => event.type === 'command.undone').map((event) => event.payload);
}

describe('Command: CommandInvoker', () => {
  it('executa o comando e devolve o resultado com o tipo dele', async () => {
    const { journal, invoker } = setup();

    const result = await invoker.run(new StepCommand('prepare-workspace', journal));

    expectTypeOf(result).toEqualTypeOf<string>();
    expect(result).toBe('resultado de prepare-workspace');
  });

  it('guarda em executed o histórico, na ordem de execução', async () => {
    const { journal, invoker } = setup();

    await invoker.run(new StepCommand('prepare-workspace', journal));
    await invoker.run(new StepCommand('write-reports', journal));

    expect(invoker.executed).toEqual(['prepare-workspace', 'write-reports']);
  });

  it('desfaz em ordem reversa e avisa cada comando desfeito', async () => {
    const { journal, events, invoker } = setup();
    await invoker.run(new StepCommand('prepare-workspace', journal));
    await invoker.run(new StepCommand('write-reports', journal));
    await invoker.run(new StepCommand('mark-reviewed', journal));

    await invoker.rollback();

    expect(journal.slice(3)).toEqual([
      'undo mark-reviewed',
      'undo write-reports',
      'undo prepare-workspace',
    ]);
    expect(undone(events)).toEqual([
      { command: 'mark-reviewed', taskId: 't1' },
      { command: 'write-reports', taskId: 't1' },
      { command: 'prepare-workspace', taskId: 't1' },
    ]);
    expect(invoker.executed).toEqual([]);
  });

  it('pula no rollback os comandos que não têm o que desfazer', async () => {
    const { journal, events, invoker } = setup();
    const readOnly: Command<number> = {
      name: 'fetch-changes',
      taskId: 't1',
      execute: () => Promise.resolve(42),
    };
    await invoker.run(new StepCommand('prepare-workspace', journal));
    await invoker.run(readOnly);

    await invoker.rollback();

    expect(undone(events)).toEqual([{ command: 'prepare-workspace', taskId: 't1' }]);
  });

  it('continua o rollback quando um undo falha e registra o erro', async () => {
    const { journal, events, invoker } = setup();
    await invoker.run(new StepCommand('prepare-workspace', journal));
    await invoker.run(
      new StepCommand('write-reports', journal, { undo: new Error('permissão negada') }),
    );
    await invoker.run(new StepCommand('mark-reviewed', journal));

    await expect(invoker.rollback()).resolves.toBeUndefined();

    expect(journal.slice(3)).toEqual(['undo mark-reviewed', 'undo prepare-workspace']);
    expect(undone(events)).toMatchObject([
      { command: 'mark-reviewed' },
      {
        command: 'write-reports',
        error: { kind: ErrorKind.Unknown, message: 'permissão negada' },
      },
      { command: 'prepare-workspace' },
    ]);
    expect(undone(events)[0]).not.toHaveProperty('error');
  });

  it('não põe no histórico o comando que falhou', async () => {
    const { journal, events, invoker } = setup();
    const failure = new NotFoundError('MR inexistente');
    await invoker.run(new StepCommand('prepare-workspace', journal));

    await expect(
      invoker.run(new StepCommand('run-review', journal, { execute: failure })),
    ).rejects.toBe(failure);
    await invoker.rollback();

    expect(invoker.executed).toEqual([]);
    expect(undone(events)).toEqual([{ command: 'prepare-workspace', taskId: 't1' }]);
  });

  it('aplica a mesma decoração a qualquer comando antes de executar', async () => {
    const decorated: string[] = [];
    const tracing: CommandDecoration = (command) => {
      decorated.push(command.name);
      return command;
    };
    const { journal, invoker } = setup(tracing);

    await invoker.run(new StepCommand('prepare-workspace', journal));
    await invoker.run({ name: 'fetch-changes', taskId: null, execute: () => Promise.resolve(42) });

    expect(decorated).toEqual(['prepare-workspace', 'fetch-changes']);
  });

  it('não faz nada num segundo rollback', async () => {
    const { journal, events, invoker } = setup();
    await invoker.run(new StepCommand('prepare-workspace', journal));

    await invoker.rollback();
    await invoker.rollback();

    expect(undone(events)).toHaveLength(1);
  });
});
