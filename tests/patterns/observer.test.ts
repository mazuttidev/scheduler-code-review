import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { EventBus } from '../../src/application/events/event-bus.js';
import type { EventPublisher, EventSubscriber } from '../../src/application/events/event-bus.js';
import { ErrorKind, SkipReason } from '../../src/domain/enums.js';
import type { SerializedError } from '../../src/domain/errors.js';
import type { EventEnvelope, PipelineEvents } from '../../src/domain/events.js';

/**
 * Observer no nightly-review.
 *
 * - Subject: `EventBus<PipelineEvents>`.
 * - Quem publica (pipeline, comandos) enxerga só `EventPublisher`.
 * - Quem observa (log em arquivo, terminal, manifesto) enxerga só `EventSubscriber`.
 *
 * O pipeline avisa o que aconteceu sem saber quem registra.
 */

const NOW = new Date('2026-10-12T05:55:04.120Z');

function createBus(onListenerError?: (error: unknown, type: keyof PipelineEvents) => void) {
  return new EventBus<PipelineEvents>({ now: () => NOW, onListenerError });
}

const skipped: PipelineEvents['task.skipped'] = {
  taskId: '1a2b',
  reason: SkipReason.AlreadyReviewed,
};

describe('Observer: EventBus', () => {
  it('entrega a um observador só o tipo de evento que ele assinou', () => {
    const bus = createBus();
    const onSkipped = vi.fn<(payload: PipelineEvents['task.skipped']) => void>();
    bus.on('task.skipped', onSkipped);

    bus.emit('task.started', { taskId: '1a2b', title: 'Aplicar desconto' });
    bus.emit('task.skipped', skipped);

    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalledWith(skipped);
  });

  it('dá ao observador o payload do tipo assinado, conferido pelo compilador', () => {
    const bus = createBus();
    const kinds: ErrorKind[] = [];

    bus.on('task.failed', ({ error }) => {
      expectTypeOf(error).toEqualTypeOf<SerializedError>();
      kinds.push(error.kind);
    });
    bus.emit('task.failed', {
      taskId: '1a2b',
      error: { name: 'NotFoundError', kind: ErrorKind.NotFound, message: 'MR inexistente' },
    });

    expect(kinds).toEqual([ErrorKind.NotFound]);
  });

  it('notifica vários observadores do mesmo evento, sem que quem publica os conheça', () => {
    const bus = createBus();
    const publisher: EventPublisher<PipelineEvents> = bus;
    const subscriber: EventSubscriber<PipelineEvents> = bus;
    const received: string[] = [];
    subscriber.on('task.skipped', () => received.push('arquivo'));
    subscriber.on('task.skipped', () => received.push('terminal'));
    subscriber.on('task.skipped', () => received.push('manifesto'));

    publisher.emit('task.skipped', skipped);

    expect(received).toEqual(['arquivo', 'terminal', 'manifesto']);
  });

  it('onAny recebe todos os eventos num envelope com tipo e horário', () => {
    const bus = createBus();
    const envelopes: EventEnvelope<PipelineEvents>[] = [];
    bus.onAny((envelope) => envelopes.push(envelope));

    bus.emit('task.started', { taskId: '1a2b', title: 'Aplicar desconto' });
    bus.emit('task.skipped', skipped);

    expect(envelopes).toEqual([
      {
        type: 'task.started',
        at: '2026-10-12T05:55:04.120Z',
        payload: { taskId: '1a2b', title: 'Aplicar desconto' },
      },
      { type: 'task.skipped', at: '2026-10-12T05:55:04.120Z', payload: skipped },
    ]);
  });

  it('para de notificar quem cancelou a assinatura', () => {
    const bus = createBus();
    const onSkipped = vi.fn();
    const onAny = vi.fn();
    const unsubscribe = bus.on('task.skipped', onSkipped);
    const unsubscribeAny = bus.onAny(onAny);

    bus.emit('task.skipped', skipped);
    unsubscribe();
    unsubscribeAny();
    bus.emit('task.skipped', skipped);

    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(onAny).toHaveBeenCalledTimes(1);
  });

  it('isola um observador que lança: os demais são notificados e quem publica não falha', () => {
    const failure = new Error('disco cheio');
    const onListenerError = vi.fn();
    const bus = createBus(onListenerError);
    const after = vi.fn();
    const any = vi.fn();
    bus.on('task.skipped', () => {
      throw failure;
    });
    bus.on('task.skipped', after);
    bus.onAny(any);

    expect(() => {
      bus.emit('task.skipped', skipped);
    }).not.toThrow();

    expect(after).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(1);
    expect(onListenerError).toHaveBeenCalledWith(failure, 'task.skipped');
  });

  it('ignora o erro do observador quando ninguém pediu para ser avisado', () => {
    const bus = createBus();
    bus.onAny(() => {
      throw new Error('falhou');
    });

    expect(() => {
      bus.emit('task.skipped', skipped);
    }).not.toThrow();
  });
});
