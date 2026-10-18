# nightly-review

Automação noturna de code review. Busca no Notion as tarefas em revisão, prepara um worktree do MR do GitLab e pede ao Claude (Agent SDK, assinatura) um review **somente leitura** contra os critérios da tarefa. Grava relatórios e logs em arquivos.

Também é um trabalho acadêmico: a aplicação precisa demonstrar, de forma fundamentada, padrões de projeto e recursos do TypeScript.

- Arquitetura e contratos: `docs/ARCHITECTURE.md`
- Justificativa de cada padrão: `docs/PATTERNS.md`
- Ordem de implementação, fase a fase: `docs/PLAN.md`

## Como trabalhar neste repositório

- Implemente **uma fase do `docs/PLAN.md` por vez**, lendo antes as seções indicadas na fase.
- Siga os contratos da ARCHITECTURE. Se precisar mudar um contrato, atualize no mesmo commit `docs/ARCHITECTURE.md` e, se for o caso, `docs/PATTERNS.md`.
- Ao terminar uma fase, rode `npm run typecheck && npm run lint && npm test` e confira o critério de "Pronto quando".
- Não implemente fases futuras por antecipação.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint com typescript-eslint em modo *type-checked* |
| `npm test` | Vitest: unit, patterns e integration, todos offline |
| `npm run test:patterns` | Só as demonstrações dos padrões |
| `npm run demo` | Execução completa offline (repositório git temporário + fakes) |
| `npm run review -- [--task ID] [--dry-run]` | Execução real (exige `.env` e `review.config.json`) |
| `npm run build` | Compila para `dist/` |

## Stack

- Node.js 22+, TypeScript estrito, ESM (`"type": "module"`, `NodeNext`). Os imports relativos levam a extensão `.js`.
- Em desenvolvimento, use `tsx`; para build, `tsc`. **Não use o type stripping nativo do Node**: ele não suporta `enum` nem *parameter properties*, que o projeto usa.
- Zod 4 (`import { z } from 'zod'`): use `z.enum(EnumNativo)`, `z.toJSONSchema(schema, { target: 'draft-7' })` e `.prefault({})` em objetos opcionais com padrões internos.
- `@anthropic-ai/claude-agent-sdk` com versão fixa; `@notionhq/client` v5+ (data sources); `commander`; Vitest.

## Arquitetura em uma tela

```text
src/domain          modelos, enums, erros, eventos (sem I/O; só importa zod)
src/shared          utilitários genéricos
src/application     portas (interfaces), pipeline, Command, Decorator, Strategy, Builder, Observer
src/infrastructure  adapters e implementações das portas
src/config          AppConfig (Singleton) e schemas da configuração
src/composition-root.ts, src/cli/   únicos lugares com classes concretas e AppConfig.load()
```

As dependências apontam para dentro: `infrastructure` → `application` → `domain`. Nenhuma classe de `domain` ou `application` importa `AppConfig` nem classes concretas de `infrastructure`.

## Padrões: onde estão e regras

| Padrão | Arquivo principal | Teste de demonstração |
|---|---|---|
| Abstract Factory | `infrastructure/providers/{claude,fake}/` + `application/ports/review-provider.ts` | `tests/patterns/abstract-factory.test.ts` |
| Factory Method | `infrastructure/reports/file-report-writers.ts` | `tests/patterns/factory-method.test.ts` |
| Builder | `application/prompt/review-prompt-builder.ts` | `tests/patterns/builder.test.ts` |
| Singleton | `config/app-config.ts` | `tests/patterns/singleton.test.ts` |
| Adapter | `infrastructure/task-sources/`, `infrastructure/code-hosts/` | `tests/patterns/adapter.test.ts` |
| Decorator | `application/decorators/command-decorators.ts`, `infrastructure/providers/transcript-recording-engine.ts` | `tests/patterns/decorator.test.ts` |
| Strategy | `application/retry/retry-policy.ts` | `tests/patterns/strategy.test.ts` |
| Observer | `application/events/event-bus.ts`, `infrastructure/logging/observers.ts` | `tests/patterns/observer.test.ts` |
| Command | `application/commands/` | `tests/patterns/command.test.ts` |

- Toda classe que cumpre um papel de padrão tem um comentário JSDoc curto dizendo o padrão e o papel GoF. Exemplo: `/** Decorator (ConcreteDecorator): acrescenta retentativa a qualquer Command. */`
- Não acrescente padrões fora dessa lista e não force padrão onde uma função simples resolve.
- Só a raiz de composição chama `AppConfig.load()`; o resto recebe a configuração por construtor.

## Convenções de código

- Identificadores, nomes de arquivo e tipos em inglês. Comentários, mensagens ao usuário, logs legíveis e documentação em português.
- Nada de `any`. Use `unknown` e estreite com type guards. Use `as` só onde o compilador não consegue provar algo que você provou.
- Use `readonly` por padrão, `import type` para importações só de tipo e `override` ao sobrescrever.
- Conjuntos fechados viram `enum` de string. Tabelas indexadas por enum viram `Record<Enum, …>`, para o compilador cobrar exaustividade. Todo `switch` sobre enum termina em `assertNever`.
- Toda entrada externa (Notion, GitLab, SDK, arquivos JSON, configuração) é validada com Zod na fronteira, dentro do adapter.
- Erros esperados são subclasses de `AppError` com o `ErrorKind` certo, porque é ele que decide a retentativa. Não lance `Error` genérico em código de domínio ou de aplicação.
- Gravações em disco passam por `writeFileAtomic`. Os logs passam pelo `redactor`.
- Dependências entram por construtor. Relógio, `sleep` e aleatoriedade são injetáveis, para os testes não dependerem de tempo real.

## Segurança (inegociável)

- O `ClaudeAgentEngine` usa exatamente a postura da ARCHITECTURE §12:
  - `tools` e `allowedTools` com `Read`, `Grep`, `Glob`;
  - `disallowedTools` com `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent`;
  - `permissionMode: 'dontAsk'`, `settingSources: []`, `strictMcpConfig: true` e `mcpServers: {}`;
  - hook `PreToolUse` com a guarda read-only;
  - `env` mínimo.

  Nunca use `bypassPermissions` nem `acceptEdits`, nunca carregue settings do worktree e nunca troque o hook por `canUseTool`, que é ignorado para ferramentas autoaprovadas.
- As instruções de review vêm de `prompts/` deste repositório, nunca do `CLAUDE.md` ou de `.claude/` do repositório revisado.
- Git só com `execFile` e lista de argumentos, nunca com uma string de shell. Valide nomes de branch com `git check-ref-format --branch`.
- Links de MR só são aceitos se a origem for o `codeHost.baseUrl` configurado. A URL de clone vem da configuração.
- Tokens só vêm do ambiente. Nunca aparecem em log, transcrição, mensagem de erro ou commit.
- O processo do Claude não recebe `GITLAB_TOKEN` nem `NOTION_TOKEN`.

## APIs externas: confira antes de usar

- **Agent SDK.** Ele muda rápido. Antes de mexer em `infrastructure/providers/claude/`, abra `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` e confirme `Options`, `SDKResultMessage`, `SDKAssistantMessageError`, `HookCallback` e `PreToolUseHookInput`. Não invente opções; se um nome mudou, ajuste o código e a ARCHITECTURE §12.
- **Notion.** Use `dataSources.query`, não o antigo `databases.query`. A paginação usa `collectPaginatedAPI` e `iteratePaginatedAPI`.
- **GitLab.** Use `GET /api/v4/projects/:id/merge_requests/:iid` com o header `PRIVATE-TOKEN`. O MR é buscado pela ref `refs/merge-requests/<iid>/head`, que também funciona para forks.

## Testes

- Todos rodam offline: nada de rede nem de credenciais. Use os fakes (`FakeProviderFactory`, `JsonFileTaskSource`, `LocalCodeHost`) e fixtures em `tests/fixtures/`.
- `tests/patterns/` tem um arquivo por padrão, escrito para demonstrar o papel do padrão no sistema (é material de avaliação).
- Testes de integração usam git real em pasta temporária (`mkdtemp`) e limpam ao final.
- O SDK do Claude é simulado com `vi.mock('@anthropic-ai/claude-agent-sdk')`.
