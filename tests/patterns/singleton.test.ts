import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppConfig } from '../../src/config/app-config.js';
import type { ConfigSource } from '../../src/config/app-config.js';
import { ConfigurationError } from '../../src/domain/errors.js';

/**
 * Singleton no nightly-review.
 *
 * `AppConfig` lê, valida e congela a configuração uma única vez por processo.
 * O construtor é privado: a única porta de entrada é `AppConfig.load()`, que
 * só a raiz de composição chama. O estado global é imutável.
 */

const ENV = {
  NOTION_TOKEN: 'notion-token-de-teste',
  GITLAB_TOKEN: 'gitlab-token-de-teste',
  CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-de-teste',
};

function settings(maxTasksPerRun = 10): Record<string, unknown> {
  return {
    taskSource: {
      kind: 'notion',
      notion: {
        dataSourceId: '00000000-0000-0000-0000-000000000000',
        statusProperty: 'Status',
        statusPropertyType: 'status',
        reviewStatus: 'Em revisão',
        titleProperty: 'Nome',
        mergeRequestUrlProperty: 'MR',
        businessRulesProperty: 'Regras de negócio',
        acceptanceCriteria: { from: 'heading', heading: 'Critérios de aceite' },
      },
    },
    codeHost: { kind: 'gitlab', baseUrl: 'https://gitlab.example.com' },
    limits: { maxTasksPerRun },
  };
}

/** Fonte em memória que conta quantas vezes a configuração foi lida. */
function memorySource(raw = settings()): ConfigSource & { reads: number } {
  return {
    env: ENV,
    reads: 0,
    readSettings() {
      this.reads += 1;
      return raw;
    },
  };
}

describe('Singleton: AppConfig', () => {
  beforeEach(() => {
    AppConfig.resetForTesting();
  });

  afterEach(() => {
    AppConfig.resetForTesting();
  });

  it('devolve a mesma instância em duas chamadas e lê a configuração uma única vez', () => {
    const source = memorySource();

    const first = AppConfig.load(source);
    const second = AppConfig.load(source);

    expect(second).toBe(first);
    expect(source.reads).toBe(1);
  });

  it('ignora uma fonte diferente depois de carregado', () => {
    const first = AppConfig.load(memorySource(settings(10)));
    const other = memorySource(settings(3));

    const second = AppConfig.load(other);

    expect(second).toBe(first);
    expect(second.settings.limits.maxTasksPerRun).toBe(10);
    expect(other.reads).toBe(0);
  });

  it('current aponta para a instância carregada', () => {
    const loaded = AppConfig.load(memorySource());

    expect(AppConfig.current).toBe(loaded);
  });

  it('current lança ConfigurationError antes do carregamento', () => {
    expect(() => AppConfig.current).toThrow(ConfigurationError);
  });

  it('congela a configuração, inclusive os objetos aninhados', () => {
    const { settings: loaded, secrets } = AppConfig.load(memorySource());

    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.limits)).toBe(true);
    expect(Object.isFrozen(loaded.outputs)).toBe(true);
    expect(Object.isFrozen(loaded.codeHost)).toBe(true);
    expect(Object.isFrozen(loaded.taskSource)).toBe(true);
    expect(Object.isFrozen(secrets)).toBe(true);
  });

  it('impede alterações na compilação e em tempo de execução', () => {
    const config = AppConfig.load(memorySource());

    expect(() => {
      // @ts-expect-error DeepReadonly: a propriedade é somente leitura.
      config.settings.limits.maxTasksPerRun = 99;
    }).toThrow(TypeError);
    expect(config.settings.limits.maxTasksPerRun).toBe(10);
  });

  it('resetForTesting permite carregar uma nova instância', () => {
    const first = AppConfig.load(memorySource(settings(10)));

    AppConfig.resetForTesting();
    const second = AppConfig.load(memorySource(settings(3)));

    expect(second).not.toBe(first);
    expect(second.settings.limits.maxTasksPerRun).toBe(3);
  });

  it('não guarda instância quando a configuração é inválida', () => {
    expect(() => AppConfig.load(memorySource({ dataDir: 42 }))).toThrow(ConfigurationError);

    expect(() => AppConfig.current).toThrow(ConfigurationError);
  });
});
