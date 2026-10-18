import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { CodeHostKind, OutputFormat, ProviderKind, TaskSourceKind } from '../domain/enums.js';
import { ConfigurationError } from '../domain/errors.js';
import { deepFreeze } from '../shared/types.js';
import type { DeepReadonly } from '../shared/types.js';

const name = z.string().min(1);

const AcceptanceCriteriaSchema = z.discriminatedUnion('from', [
  z.strictObject({ from: z.literal('property'), property: name }),
  z.strictObject({ from: z.literal('heading'), heading: name }),
]);

const NotionTaskSourceSchema = z.strictObject({
  kind: z.literal(TaskSourceKind.Notion),
  notion: z.strictObject({
    dataSourceId: name,
    statusProperty: name,
    statusPropertyType: z.enum(['status', 'select']),
    reviewStatus: name,
    titleProperty: name,
    mergeRequestUrlProperty: name,
    businessRulesProperty: name,
    acceptanceCriteria: AcceptanceCriteriaSchema,
  }),
});

/** Arquivo JSON com as tarefas: a demonstração, os testes e o uso sem plataforma integrada. */
const JsonFileTaskSourceSchema = z.strictObject({
  kind: z.literal(TaskSourceKind.JsonFile),
  jsonFile: z.strictObject({ path: name.transform(expandHome) }),
});

const GitLabCodeHostSchema = z.strictObject({
  kind: z.literal(CodeHostKind.GitLab),
  baseUrl: z.url({ protocol: /^https?$/ }),
  cloneProtocol: z.enum(['ssh', 'https']).default('ssh'),
});

/** Repositório git local no papel de servidor: a demonstração e os testes. */
const LocalCodeHostSchema = z.strictObject({
  kind: z.literal(CodeHostKind.Local),
  repositoryPath: name.transform(expandHome),
  projectPath: name.default('demo/loja'),
  targetBranch: name.default('main'),
});

const ProviderSchema = z.strictObject({
  kind: z.enum(ProviderKind).default(ProviderKind.Claude),
  /** Sem ele, vale o modelo padrão do provedor. */
  model: name.optional(),
  maxTurns: z.number().int().positive().default(30),
  timeoutMs: z.number().int().positive().default(900_000),
});

const LimitsSchema = z.strictObject({
  maxTasksPerRun: z.number().int().positive().default(10),
  maxDiffBytes: z.number().int().positive().default(300_000),
});

const RetentionSchema = z.strictObject({
  /** Apaga as execuções de `runs/` mais antigas que isto. Sem o campo, nada é apagado. */
  days: z.number().int().positive().optional(),
});

const PromptsSchema = z.strictObject({
  systemPath: name.default('prompts/system.md'),
  instructionsPath: name.default('prompts/review-instructions.md'),
});

/**
 * Formato do `review.config.json`. Chaves desconhecidas são rejeitadas, para
 * um erro de digitação não virar um padrão aplicado em silêncio.
 */
export const SettingsSchema = z.strictObject({
  dataDir: name.default('~/.nightly-review').transform(expandHome),
  taskSource: z.discriminatedUnion('kind', [NotionTaskSourceSchema, JsonFileTaskSourceSchema]),
  codeHost: z.discriminatedUnion('kind', [GitLabCodeHostSchema, LocalCodeHostSchema]),
  // `.prefault({})` aplica os padrões internos; `.default({})` não aplicaria.
  provider: ProviderSchema.prefault({}),
  outputs: z
    .array(z.enum(OutputFormat))
    .min(1)
    .default([OutputFormat.Json, OutputFormat.Markdown]),
  limits: LimitsSchema.prefault({}),
  prompts: PromptsSchema.prefault({}),
  retention: RetentionSchema.prefault({}),
  keepWorkspaces: z.boolean().default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Sobrescritas vindas das flags da CLI, como `--limit` e `--provider`. */
export interface SettingsOverrides {
  readonly limits?: Partial<Settings['limits']>;
  readonly provider?: Partial<Settings['provider']>;
}

// Um token vazio, como no `.env.example`, conta como ausente.
const token = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === '' ? undefined : value));

/** Segredos lidos do ambiente. Nunca vêm do arquivo de configuração. */
export const SecretsSchema = z
  .object({ NOTION_TOKEN: token, GITLAB_TOKEN: token, CLAUDE_CODE_OAUTH_TOKEN: token })
  .transform((env) => ({
    notionToken: env.NOTION_TOKEN,
    gitlabToken: env.GITLAB_TOKEN,
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
  }));
export type Secrets = z.infer<typeof SecretsSchema>;

const SECRET_ENV_NAME: Readonly<Record<keyof Secrets, string>> = {
  notionToken: 'NOTION_TOKEN',
  gitlabToken: 'GITLAB_TOKEN',
  claudeOauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
};

// Segredo que cada escolha da configuração exige. `null` = funciona sem credencial.
const TASK_SOURCE_SECRET: Readonly<Record<TaskSourceKind, keyof Secrets | null>> = {
  [TaskSourceKind.Notion]: 'notionToken',
  [TaskSourceKind.JsonFile]: null,
};
const CODE_HOST_SECRET: Readonly<Record<CodeHostKind, keyof Secrets | null>> = {
  [CodeHostKind.GitLab]: 'gitlabToken',
  [CodeHostKind.Local]: null,
};
const PROVIDER_SECRET: Readonly<Record<ProviderKind, keyof Secrets | null>> = {
  [ProviderKind.Claude]: 'claudeOauthToken',
  [ProviderKind.Fake]: null,
};

/** De onde a configuração vem. Os testes usam uma fonte em memória. */
export interface ConfigSource {
  readSettings(): unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function fileConfigSource(
  path = 'review.config.json',
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigSource {
  return {
    env,
    readSettings(): unknown {
      let content: string;
      try {
        content = readFileSync(path, 'utf8');
      } catch (cause) {
        throw new ConfigurationError(
          'Não foi possível ler o arquivo de configuração',
          { path },
          { cause },
        );
      }
      try {
        return JSON.parse(content) as unknown;
      } catch (cause) {
        throw new ConfigurationError(
          'O arquivo de configuração não é um JSON válido',
          { path },
          { cause },
        );
      }
    },
  };
}

/**
 * Singleton: a configuração do processo, lida e validada uma única vez e
 * congelada. Só a raiz de composição chama `load()`; as demais classes
 * recebem por construtor o trecho de que precisam.
 */
export class AppConfig {
  private static instance: AppConfig | undefined;

  private constructor(
    readonly settings: DeepReadonly<Settings>,
    readonly secrets: Readonly<Secrets>,
  ) {}

  /** Carrega na primeira chamada; nas seguintes, devolve a mesma instância. */
  static load(
    source: ConfigSource = fileConfigSource(),
    overrides: SettingsOverrides = {},
  ): AppConfig {
    if (AppConfig.instance) return AppConfig.instance;
    const settings = applyOverrides(parseSettings(source.readSettings()), overrides);
    const secrets = parseSecrets(source.env, settings);
    AppConfig.instance = new AppConfig(deepFreeze(settings), Object.freeze(secrets));
    return AppConfig.instance;
  }

  /** A instância já carregada. */
  static get current(): AppConfig {
    if (!AppConfig.instance) {
      throw new ConfigurationError('A configuração ainda não foi carregada');
    }
    return AppConfig.instance;
  }

  /** Só para os testes do próprio Singleton. */
  static resetForTesting(): void {
    AppConfig.instance = undefined;
  }
}

function parseSettings(raw: unknown): Settings {
  const result = SettingsSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigurationError('review.config.json inválido', {
      issues: z.prettifyError(result.error),
    });
  }
  return result.data;
}

function applyOverrides(settings: Settings, overrides: SettingsOverrides): Settings {
  if (!overrides.limits && !overrides.provider) return settings;
  // Valida de novo: uma flag da CLI obedece às mesmas regras do arquivo.
  return parseSettings({
    ...settings,
    limits: { ...settings.limits, ...definedOnly(overrides.limits) },
    provider: { ...settings.provider, ...definedOnly(overrides.provider) },
  });
}

function definedOnly<T extends object>(partial: T | undefined): Partial<T> {
  const entries = Object.entries(partial ?? {}).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<T>;
}

function parseSecrets(
  env: Readonly<Record<string, string | undefined>>,
  settings: Settings,
): Secrets {
  const secrets = SecretsSchema.parse(env);
  const required = [
    TASK_SOURCE_SECRET[settings.taskSource.kind],
    CODE_HOST_SECRET[settings.codeHost.kind],
    PROVIDER_SECRET[settings.provider.kind],
  ];
  const missing = required
    .filter((key) => key !== null)
    .filter((key) => secrets[key] === undefined)
    .map((key) => SECRET_ENV_NAME[key]);
  if (missing.length > 0) {
    throw new ConfigurationError('Variáveis de ambiente obrigatórias ausentes', { missing });
  }
  return secrets;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
