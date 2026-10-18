import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppConfig, SettingsSchema, fileConfigSource } from '../../../src/config/app-config.js';
import type { ConfigSource } from '../../../src/config/app-config.js';
import { OutputFormat, ProviderKind } from '../../../src/domain/enums.js';
import { ConfigurationError } from '../../../src/domain/errors.js';

const EXAMPLE_PATH = join(import.meta.dirname, '../../../review.config.example.json');

const ENV = {
  NOTION_TOKEN: 'notion-token-de-teste',
  GITLAB_TOKEN: 'gitlab-token-de-teste',
  CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-de-teste',
};

function example(): Record<string, unknown> {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as Record<string, unknown>;
}

/** Só os blocos obrigatórios do exemplo. */
function minimal(): Record<string, unknown> {
  const { taskSource, codeHost } = example();
  return { taskSource, codeHost };
}

function source(raw: unknown, env: ConfigSource['env'] = ENV): ConfigSource {
  return { env, readSettings: () => raw };
}

function loadError(load: () => unknown): ConfigurationError {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error('Esperava um ConfigurationError');
}

describe('SettingsSchema', () => {
  it('aceita o review.config.example.json', () => {
    const result = SettingsSchema.safeParse(example());

    expect(result.success).toBe(true);
  });

  it('aplica os padrões dos blocos opcionais ausentes', () => {
    const settings = SettingsSchema.parse(minimal());

    expect(settings.provider).toEqual({
      kind: ProviderKind.Claude,
      maxTurns: 30,
      timeoutMs: 900_000,
    });
    expect(settings.limits).toEqual({ maxTasksPerRun: 10, maxDiffBytes: 300_000 });
    expect(settings.prompts).toEqual({
      systemPath: 'prompts/system.md',
      instructionsPath: 'prompts/review-instructions.md',
    });
    expect(settings.outputs).toEqual([OutputFormat.Json, OutputFormat.Markdown]);
    expect(settings.keepWorkspaces).toBe(false);
  });

  it('completa com os padrões um bloco opcional preenchido pela metade', () => {
    const settings = SettingsSchema.parse({ ...minimal(), limits: { maxTasksPerRun: 3 } });

    expect(settings.limits).toEqual({ maxTasksPerRun: 3, maxDiffBytes: 300_000 });
  });

  it.each([
    ['~/.nightly-review', join(homedir(), '.nightly-review')],
    ['~', homedir()],
    ['/var/lib/nightly-review', '/var/lib/nightly-review'],
  ])('resolve dataDir %s', (dataDir, expected) => {
    expect(SettingsSchema.parse({ ...minimal(), dataDir }).dataDir).toBe(expected);
  });

  it('usa ~/.nightly-review quando dataDir não é informado', () => {
    expect(SettingsSchema.parse(minimal()).dataDir).toBe(join(homedir(), '.nightly-review'));
  });

  it('aceita os critérios de aceite vindos de um campo', () => {
    const raw = example() as { taskSource: { notion: Record<string, unknown> } };
    raw.taskSource.notion.acceptanceCriteria = { from: 'property', property: 'Critérios' };

    expect(SettingsSchema.safeParse(raw).success).toBe(true);
  });

  it.each([
    ['uma chave desconhecida na raiz', { maxTaskPerRun: 5 }],
    ['uma chave desconhecida em limits', { limits: { maxTaskPerRun: 5 } }],
    ['um limite que não é inteiro positivo', { limits: { maxTasksPerRun: 0 } }],
    ['uma lista de saídas vazia', { outputs: [] }],
    ['um formato de saída inexistente', { outputs: ['pdf'] }],
    ['um baseUrl que não é http(s)', { codeHost: { kind: 'gitlab', baseUrl: 'ftp://gitlab' } }],
    ['um codeHost de tipo desconhecido', { codeHost: { kind: 'github', baseUrl: 'https://x.io' } }],
  ])('rejeita %s', (_label, change) => {
    expect(SettingsSchema.safeParse({ ...minimal(), ...change }).success).toBe(false);
  });
});

describe('AppConfig.load', () => {
  beforeEach(() => {
    AppConfig.resetForTesting();
  });

  afterEach(() => {
    AppConfig.resetForTesting();
  });

  it('lança ConfigurationError citando a chave inválida', () => {
    const error = loadError(() =>
      AppConfig.load(source({ ...minimal(), limits: { maxTaskPerRun: 5 } })),
    );

    expect(error.message).toBe('review.config.json inválido');
    expect(JSON.stringify(error.details)).toContain('maxTaskPerRun');
  });

  it('lê os tokens do ambiente', () => {
    const { secrets } = AppConfig.load(source(example()));

    expect(secrets).toEqual({
      notionToken: 'notion-token-de-teste',
      gitlabToken: 'gitlab-token-de-teste',
      claudeOauthToken: 'claude-token-de-teste',
    });
  });

  it('exige os tokens dos kinds configurados e lista os que faltam', () => {
    const env = { NOTION_TOKEN: 'notion-token-de-teste', GITLAB_TOKEN: '' };

    const error = loadError(() => AppConfig.load(source(example(), env)));

    expect(error.details).toEqual({ missing: ['GITLAB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] });
    expect(JSON.stringify(error.toJSON())).not.toContain('notion-token-de-teste');
  });

  it('não exige o token do Claude quando o provedor é o falso', () => {
    const env = { NOTION_TOKEN: 'notion-token-de-teste', GITLAB_TOKEN: 'gitlab-token-de-teste' };

    const config = AppConfig.load(source(example(), env), {
      provider: { kind: ProviderKind.Fake },
    });

    expect(config.settings.provider.kind).toBe(ProviderKind.Fake);
    expect(config.secrets.claudeOauthToken).toBeUndefined();
  });

  it('aplica as sobrescritas da CLI sem perder os demais valores', () => {
    const config = AppConfig.load(source(example()), {
      limits: { maxTasksPerRun: 2, maxDiffBytes: undefined },
    });

    expect(config.settings.limits).toEqual({ maxTasksPerRun: 2, maxDiffBytes: 300_000 });
  });

  it('valida as sobrescritas da CLI', () => {
    expect(() =>
      AppConfig.load(source(example()), { limits: { maxTasksPerRun: -1 } }),
    ).toThrow(ConfigurationError);
  });
});

describe('taskSource json-file', () => {
  beforeEach(() => {
    AppConfig.resetForTesting();
  });

  afterEach(() => {
    AppConfig.resetForTesting();
  });

  it('aceita o arquivo de tarefas, com ~ expandido no caminho', () => {
    const settings = SettingsSchema.parse({
      ...minimal(),
      taskSource: { kind: 'json-file', jsonFile: { path: '~/tarefas.json' } },
    });

    expect(settings.taskSource).toEqual({
      kind: 'json-file',
      jsonFile: { path: join(homedir(), 'tarefas.json') },
    });
  });

  it('roda sem nenhum token quando tudo é local: é a configuração da demonstração', () => {
    const raw = {
      taskSource: { kind: 'json-file', jsonFile: { path: '/tmp/tarefas.json' } },
      codeHost: { kind: 'local', repositoryPath: '/tmp/demo-loja' },
      provider: { kind: 'fake' },
    };

    const config = AppConfig.load(source(raw, {}));

    expect(config.secrets).toEqual({
      notionToken: undefined,
      gitlabToken: undefined,
      claudeOauthToken: undefined,
    });
  });
});

describe('codeHost local', () => {
  beforeEach(() => {
    AppConfig.resetForTesting();
  });

  afterEach(() => {
    AppConfig.resetForTesting();
  });

  it('aceita o repositório local, com os padrões de projeto e de branch alvo', () => {
    const settings = SettingsSchema.parse({
      ...minimal(),
      codeHost: { kind: 'local', repositoryPath: '~/demo-loja' },
    });

    expect(settings.codeHost).toEqual({
      kind: 'local',
      repositoryPath: join(homedir(), 'demo-loja'),
      projectPath: 'demo/loja',
      targetBranch: 'main',
    });
  });

  it('não exige o token do GitLab', () => {
    const env = {
      NOTION_TOKEN: 'notion-token-de-teste',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-de-teste',
    };
    const raw = { ...example(), codeHost: { kind: 'local', repositoryPath: '/tmp/demo-loja' } };

    const config = AppConfig.load(source(raw, env));

    expect(config.settings.codeHost.kind).toBe('local');
    expect(config.secrets.gitlabToken).toBeUndefined();
  });
});

describe('fileConfigSource', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nightly-review-config-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('lê o JSON do arquivo e expõe o ambiente recebido', () => {
    const fileSource = fileConfigSource(EXAMPLE_PATH, ENV);

    expect(fileSource.readSettings()).toEqual(example());
    expect(fileSource.env).toBe(ENV);
  });

  it('lança ConfigurationError quando o arquivo não existe', () => {
    const path = join(directory, 'review.config.json');

    const error = loadError(() => fileConfigSource(path, ENV).readSettings());

    expect(error.details).toEqual({ path });
  });

  it('lança ConfigurationError quando o arquivo não é JSON', () => {
    const path = join(directory, 'review.config.json');
    writeFileSync(path, '{ "dataDir": ');

    expect(() => fileConfigSource(path, ENV).readSettings()).toThrow(ConfigurationError);
  });
});
