import type { EventEnvelope } from '../../domain/events.js';

export type Listener<TPayload> = (payload: TPayload) => void;
export type Unsubscribe = () => void;

/** Lado de quem publica: o pipeline e os comandos só conhecem isto. */
export interface EventPublisher<TEvents extends object> {
  emit<K extends keyof TEvents>(type: K, payload: TEvents[K]): void;
}

/** Lado de quem observa. */
export interface EventSubscriber<TEvents extends object> {
  on<K extends keyof TEvents>(type: K, listener: Listener<TEvents[K]>): Unsubscribe;
  onAny(listener: Listener<EventEnvelope<TEvents>>): Unsubscribe;
}

export interface EventBusOptions<TEvents extends object> {
  /** Relógio injetável, para os testes não dependerem do tempo real. */
  readonly now?: () => Date;
  /** Chamado quando um observador lança. Sem ele, o erro é ignorado. */
  readonly onListenerError?: (error: unknown, type: keyof TEvents) => void;
}

/**
 * Observer (Subject): notifica os observadores sem conhecê-los. O mapa
 * `TEvents` liga cada tipo de evento ao seu payload, e um observador que
 * lança exceção não derruba quem publicou nem os demais observadores.
 */
export class EventBus<TEvents extends object>
  implements EventPublisher<TEvents>, EventSubscriber<TEvents>
{
  private readonly listeners = new Map<keyof TEvents, Set<Listener<never>>>();
  private readonly anyListeners = new Set<Listener<EventEnvelope<TEvents>>>();
  private readonly now: () => Date;
  private readonly onListenerError: (error: unknown, type: keyof TEvents) => void;

  constructor(options: EventBusOptions<TEvents> = {}) {
    this.now = options.now ?? (() => new Date());
    this.onListenerError = options.onListenerError ?? (() => undefined);
  }

  on<K extends keyof TEvents>(type: K, listener: Listener<TEvents[K]>): Unsubscribe {
    const set = this.listeners.get(type) ?? new Set<Listener<never>>();
    set.add(listener);
    this.listeners.set(type, set);
    return () => {
      set.delete(listener);
    };
  }

  onAny(listener: Listener<EventEnvelope<TEvents>>): Unsubscribe {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  emit<K extends keyof TEvents>(type: K, payload: TEvents[K]): void {
    // As cópias permitem que um observador cancele a assinatura durante a notificação.
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      this.safely(type, () => {
        // Só `on` grava neste conjunto, sempre com o payload do tipo K.
        (listener as Listener<TEvents[K]>)(payload);
      });
    }
    if (this.anyListeners.size === 0) return;
    const envelope = { type, at: this.now().toISOString(), payload } as EventEnvelope<TEvents>;
    for (const listener of [...this.anyListeners]) {
      this.safely(type, () => {
        listener(envelope);
      });
    }
  }

  private safely(type: keyof TEvents, notify: () => void): void {
    try {
      notify();
    } catch (error) {
      try {
        this.onListenerError(error, type);
      } catch {
        // Nem o tratador de erros pode interromper a publicação.
      }
    }
  }
}
