/** Torna somente leitura o tipo inteiro, inclusive objetos e listas aninhados. */
export type DeepReadonly<T> = T extends ((...args: never[]) => unknown) | Date
  ? T
  : T extends ReadonlyMap<infer Key, infer Value>
    ? ReadonlyMap<DeepReadonly<Key>, DeepReadonly<Value>>
    : T extends ReadonlySet<infer Item>
      ? ReadonlySet<DeepReadonly<Item>>
      : T extends object
        ? // Tipo mapeado homomórfico: preserva listas e tuplas, agora `readonly`.
          { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

/** Resultado de uma operação que pode falhar sem lançar exceção. */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Fecha um `switch` exaustivo: o compilador acusa o caso esquecido. */
export function assertNever(value: never, message = 'Valor inesperado'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

/**
 * Congela o valor e tudo que ele contém. Devolve o mesmo objeto.
 *
 * Feito para dados no formato JSON: desce em listas e objetos simples. Outros
 * objetos (`Map`, `Set`, `Date`, `Buffer`, instâncias de classe) ficam como
 * estão, porque `Object.freeze` não impede a mutação interna deles.
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  freezeNested(value, new WeakSet());
  // O compilador não acompanha o efeito de Object.freeze nos níveis aninhados.
  return value as DeepReadonly<T>;
}

function freezeNested(value: unknown, visited: WeakSet<object>): void {
  if (!isPlainData(value) || visited.has(value)) return;
  visited.add(value);
  Object.freeze(value);
  for (const nested of Object.values(value)) freezeNested(nested, visited);
}

function isPlainData(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
