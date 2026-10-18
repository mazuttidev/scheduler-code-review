import { describe, expect, expectTypeOf, it } from 'vitest';

import { assertNever, deepFreeze, err, ok } from '../../../src/shared/types.js';
import type { DeepReadonly, Result } from '../../../src/shared/types.js';

describe('deepFreeze', () => {
  it('congela o objeto e tudo que ele contém', () => {
    const settings = deepFreeze({
      limits: { maxTasksPerRun: 10 },
      outputs: ['json', { format: 'markdown' }],
    });

    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.limits)).toBe(true);
    expect(Object.isFrozen(settings.outputs)).toBe(true);
    expect(Object.isFrozen(settings.outputs[1])).toBe(true);
  });

  it('devolve o mesmo objeto e impede alterações', () => {
    const original = { nested: { value: 1 } };

    const frozen = deepFreeze(original);

    expect(frozen).toBe(original);
    expect(() => {
      original.nested.value = 2;
    }).toThrow(TypeError);
  });

  it('aceita primitivos e referências circulares', () => {
    const node: { self?: unknown } = {};
    node.self = node;

    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze(null)).toBeNull();
    expect(Object.isFrozen(deepFreeze(node))).toBe(true);
  });

  it('desce em objeto que já estava congelado só no primeiro nível', () => {
    const shallow = Object.freeze({ nested: { value: 1 } });

    deepFreeze(shallow);

    expect(Object.isFrozen(shallow.nested)).toBe(true);
  });

  it('não toca em objetos que não são dados simples', () => {
    const settings = deepFreeze({
      bytes: new Uint8Array([1]),
      index: new Map([['a', { value: 1 }]]),
      at: new Date(0),
    });

    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.bytes)).toBe(false);
    expect(Object.isFrozen(settings.index)).toBe(false);
    expect(Object.isFrozen(settings.at)).toBe(false);
  });
});

describe('DeepReadonly', () => {
  it('torna somente leitura os níveis aninhados', () => {
    const frozen = deepFreeze({ limits: { values: [1, 2] } });

    expectTypeOf(frozen.limits).toEqualTypeOf<{ readonly values: readonly number[] }>();
  });

  it('preserva tuplas', () => {
    expectTypeOf<DeepReadonly<[number, { a: string }]>>().toEqualTypeOf<
      readonly [number, { readonly a: string }]
    >();
  });

  it('troca Map e Set pelas versões somente leitura e mantém Date e funções', () => {
    expectTypeOf<DeepReadonly<Map<string, { a: number }>>>().toEqualTypeOf<
      ReadonlyMap<string, { readonly a: number }>
    >();
    expectTypeOf<DeepReadonly<Set<number[]>>>().toEqualTypeOf<ReadonlySet<readonly number[]>>();
    expectTypeOf<DeepReadonly<Date>>().toEqualTypeOf<Date>();
    expectTypeOf<DeepReadonly<() => void>>().toEqualTypeOf<() => void>();
  });
});

describe('Result', () => {
  it('ok carrega o valor', () => {
    const result: Result<number, string> = ok(7);

    expect(result).toEqual({ ok: true, value: 7 });
  });

  it('err carrega o erro, e o campo ok estreita o tipo', () => {
    const result: Result<number, string> = err('saída inválida');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('saída inválida');
  });
});

describe('assertNever', () => {
  it('lança com o valor que escapou do switch', () => {
    const escaped = 'novo_valor' as never;

    expect(() => assertNever(escaped, 'Severidade sem tratamento')).toThrow(
      'Severidade sem tratamento: "novo_valor"',
    );
  });
});
