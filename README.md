# nightly-review

Automação noturna de code review. Toda noite, a aplicação busca as tarefas em revisão, prepara um worktree do merge request de cada uma e pede a uma IA um review **somente leitura** contra o que a tarefa pedia. De manhã, você lê os relatórios e decide o que vira comentário no MR.

O projeto também é um trabalho acadêmico: ele aplica, de forma fundamentada, os 9 padrões de projeto do material e os recursos do TypeScript.

## Estado atual

| Parte | Situação |
|---|---|
| Domínio, pipeline, logs, relatórios, git e CLI | Prontos e testados (fases 0 a 7 do [plano](docs/PLAN.md)). |
| Demonstração offline (`npm run demo`) | Funciona sem rede e sem credenciais. |
| Provedor Claude (Agent SDK) | Implementado e testado com o SDK simulado (fase 8c). Ainda **não foi validado com uma assinatura real**. |
| Notion e GitLab | **Ainda não implementados** (fases 8a e 8b). Com eles configurados, `npm run review` termina com "Esta integração ainda não está disponível". |
| Agendamento (`scripts/nightly.sh`, cron, systemd, launchd) | Script e modelos prontos (fase 9). O disparo pelo agendador precisa ser conferido na sua máquina. |

## Pré-requisitos

- Node.js 22 ou superior
- npm
- git 2.30 ou superior

## Instalação

```bash
npm install
npm test
npm run demo
```

## Demonstração

`npm run demo` executa o fluxo completo sem credenciais. Ele cria, numa pasta temporária, um repositório git com um merge request de exemplo (que tem um bug proposital de divisão por zero) e um arquivo com duas tarefas. O review é feito por um provedor falso.

```bash
npm run demo
npm run demo -- --simulate transient,invalid-output   # mostra as retentativas
npm run demo -- --simulate rate-limit                 # mostra a execução sendo interrompida
```

O terminal mostra cada etapa, as retentativas, o veredito e o caminho dos arquivos gerados:

```text
▶ DEMO-1: Aplicar desconto por cupom no carrinho
  ✓ resolve-merge-request (99 ms)
  ✓ fetch-changes (206 ms)
  ✓ prepare-workspace (50 ms)
  ↻ run-review: tentativa 1 falhou (transient: Falha de rede simulada); nova tentativa em 1.1 s
  ↻ run-review: tentativa 2 falhou (invalid_output: A resposta não é um JSON válido); nova tentativa em 0 ms
  ✓ run-review (1.2 s)
  ✓ write-reports (11 ms)
  ✓ mark-reviewed (4 ms)
  ✓ cleanup-workspace (68 ms)
  veredito: changes_requested | blocker 0, major 1, minor 1, nit 0
  → …/reviews/DEMO-1/review.md
▶ DEMO-2: Exportar o pedido em PDF
  pulada: a tarefa não tem link de MR
```

A pasta temporária não é apagada ao final, para você abrir o `review.md`, o `events.jsonl` e o `manifest.json`.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint com typescript-eslint em modo *type-checked* |
| `npm test` | Vitest: unit, patterns e integration, todos offline |
| `npm run test:patterns` | Só as demonstrações dos padrões |
| `npm run demo` | Execução completa offline |
| `npm run review -- [--task ID] [--dry-run] [--limit N] [--provider claude\|fake]` | Execução real (exige `.env` e `review.config.json`) |
| `npm run dev -- tasks` | Lista as tarefas em revisão, sem revisar |
| `npm run build` | Compila para `dist/` |

`run` e `tasks` aceitam `--config <caminho>`; o padrão é `review.config.json` no diretório atual.

Códigos de saída da CLI:

| Código | Quando |
|---|---|
| 0 | A execução chegou ao fim, mesmo que tarefas tenham falhado; ou outra execução já estava em andamento. |
| 1 | Erro de configuração ou de uso. |
| 2 | Execução interrompida, por exemplo pelo limite da assinatura. |

## Como funciona

Cada tarefa passa por estas etapas. Cada etapa é um comando, com log, retentativa e, quando deixa efeito, um jeito de desfazer.

| # | Etapa | O que faz |
|---|---|---|
| 0 | `fetch-pending-tasks` | Busca as tarefas em revisão (uma vez por execução). |
| 1 | `resolve-merge-request` | Resolve o link do MR na plataforma de código. |
| 2 | `fetch-changes` | Atualiza o clone base e calcula o diff, sem checkout. |
| 3 | `prepare-workspace` | Cria um worktree isolado no `head_sha` do MR. |
| 4 | `run-review` | Pede o review à IA e valida a resposta. |
| 5 | `write-reports` | Grava `review.json` e `review.md`. |
| 6 | `mark-reviewed` | Marca o par tarefa + `head_sha` como revisado. |
| 7 | `cleanup-workspace` | Remove o worktree. |

Uma tarefa é pulada, sem chamar a IA, quando não tem link de MR, quando o MR não está aberto, quando aquele `head_sha` já foi revisado ou quando o diff passa do limite configurado.

Se uma etapa falha, o que já tinha sido feito para aquela tarefa é desfeito e a execução segue para a próxima. Se o limite da assinatura estoura, a execução para e as tarefas restantes ficam para a noite seguinte.

## Configuração

Copie os exemplos e preencha:

```bash
cp review.config.example.json review.config.json
cp .env.example .env
```

O `review.config.json` não tem segredos, mas fica fora do git, porque guarda caminhos e IDs da sua máquina. Os tokens vêm só do ambiente:

| Variável | Exigida quando |
|---|---|
| `NOTION_TOKEN` | `taskSource.kind` é `notion` |
| `GITLAB_TOKEN` | `codeHost.kind` é `gitlab` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `provider.kind` é `claude` |

Além das variantes `notion`, `gitlab` e `claude`, a configuração aceita três variantes locais, que já funcionam hoje e não pedem token:

```json
{
  "dataDir": "~/.nightly-review",
  "taskSource": { "kind": "json-file", "jsonFile": { "path": "~/tarefas.json" } },
  "codeHost": { "kind": "local", "repositoryPath": "~/projetos/loja" },
  "provider": { "kind": "fake" }
}
```

O formato completo, com todos os campos e padrões, está na [seção 11 da arquitetura](docs/ARCHITECTURE.md#11-configuração).

## Agendamento

O agendador chama `scripts/nightly.sh`, que define o ambiente, carrega o `.env`, roda o que está em `dist/` e escreve tudo em `~/.nightly-review/logs/cron.log`.

```bash
npm run build          # antes de agendar e depois de cada atualização
scripts/nightly.sh     # teste manual; depois, leia o cron.log
```

O script confere se há Node.js 22 ou superior no PATH e se o build existe; se algo faltar, o motivo fica no `cron.log`. Se o seu Node 22 não estiver em `/opt/homebrew/bin` nem em `/usr/local/bin`, informe o caminho em `NIGHTLY_REVIEW_PATH`. As demais variáveis estão no cabeçalho do script.

Os modelos em [`scripts/examples/`](scripts/examples/) rodam de segunda a sexta, às 02:55. Em todos, troque `/CAMINHO/PARA/nightly-review` pelo caminho do projeto.

**Linux, cron** ([modelo](scripts/examples/nightly-review.cron)). O cron não executa a rodada perdida se a máquina estava desligada.

```bash
crontab -e
# 55 2 * * 1-5 /CAMINHO/PARA/nightly-review/scripts/nightly.sh
```

**Linux, timer do systemd** (modelos [`.service`](scripts/examples/nightly-review.service) e [`.timer`](scripts/examples/nightly-review.timer)). Com `Persistent=true`, a execução acontece ao ligar a máquina, se o horário passou.

```bash
mkdir -p ~/.config/systemd/user
cp scripts/examples/nightly-review.service scripts/examples/nightly-review.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now nightly-review.timer
systemctl --user list-timers nightly-review.timer
```

**macOS, launchd** ([modelo](scripts/examples/com.nightly-review.plist)). Se o Mac estava dormindo, a execução acontece ao acordar.

```bash
cp scripts/examples/com.nightly-review.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nightly-review.plist
launchctl kickstart gui/$(id -u)/com.nightly-review    # dispara agora, para testar
launchctl bootout gui/$(id -u)/com.nightly-review      # remove
```

Duas execuções nunca rodam ao mesmo tempo: se uma já estiver em andamento, a segunda termina sem fazer nada.

Para apagar execuções antigas automaticamente, acrescente `"retention": { "days": 30 }` ao `review.config.json`. Sem isso, nada é apagado.

## Arquivos gerados

Tudo fica em `dataDir` (por padrão, `~/.nightly-review`), com diretórios em modo 700 e arquivos em modo 600.

```text
~/.nightly-review/
├── runs/<runId>/
│   ├── events.jsonl                    # um evento por linha
│   ├── manifest.json                   # resumo e resultado de cada tarefa
│   ├── reviews/<taskId>/review.json    # relatório completo
│   ├── reviews/<taskId>/review.md      # relatório legível
│   ├── transcripts/<taskId>/           # prompt e resposta de cada tentativa
│   └── prompts/<taskId>.md             # só com --dry-run
├── state/reviewed.json                 # o que já foi revisado
├── repos/                              # clones base, reaproveitados
├── worktrees/<runId>/                  # temporários
└── run.lock                            # impede duas execuções simultâneas
```

## Padrões de projeto

A justificativa de cada padrão, com participantes e diagramas, está em [`docs/PATTERNS.md`](docs/PATTERNS.md). Cada um tem um teste escrito para demonstrar o papel dele no sistema.

| Padrão | Categoria | Onde | Demonstração |
|---|---|---|---|
| Abstract Factory | Criacional | `src/infrastructure/providers/`, `src/application/ports/review-provider.ts` | `tests/patterns/abstract-factory.test.ts` |
| Factory Method | Criacional | `src/infrastructure/reports/file-report-writers.ts` | `tests/patterns/factory-method.test.ts` |
| Builder | Criacional | `src/application/prompt/review-prompt-builder.ts` | `tests/patterns/builder.test.ts` |
| Singleton | Criacional | `src/config/app-config.ts` | `tests/patterns/singleton.test.ts` |
| Adapter | Estrutural | `src/infrastructure/task-sources/`, `src/infrastructure/code-hosts/` | `tests/patterns/adapter.test.ts` |
| Decorator | Estrutural | `src/application/decorators/command-decorators.ts`, `src/infrastructure/providers/transcript-recording-engine.ts` | `tests/patterns/decorator.test.ts` |
| Strategy | Comportamental | `src/application/retry/retry-policy.ts` | `tests/patterns/strategy.test.ts` |
| Observer | Comportamental | `src/application/events/event-bus.ts`, `src/infrastructure/logging/observers.ts` | `tests/patterns/observer.test.ts` |
| Command | Comportamental | `src/application/commands/` | `tests/patterns/command.test.ts` |

Para ver os nove funcionando juntos, rode `npm run demo`; para ver cada um isolado, `npm run test:patterns`.

## Estrutura

```text
src/
├── domain/             modelos, enums, erros e eventos (sem I/O; só importa zod)
├── shared/             utilitários genéricos
├── application/        portas, pipeline, comandos, decorators, políticas, builder, eventos
├── infrastructure/     adapters e implementações das portas
├── config/             AppConfig e schemas da configuração
├── composition-root.ts único lugar com classes concretas e AppConfig.load()
└── cli/                run, tasks e demo
tests/
├── patterns/           um arquivo por padrão
├── unit/
├── integration/        pipeline offline e git real em pasta temporária
└── helpers/            dados de exemplo
```

As dependências apontam para dentro: `infrastructure` → `application` → `domain`.

## Segurança

O revisor só lê. As decisões estão na [seção 13 da arquitetura](docs/ARCHITECTURE.md#13-segurança); as principais:

- O conteúdo da tarefa, do MR e do diff vem de terceiros e vai para o prompt delimitado e declarado como dado.
- As instruções de review vêm de `prompts/` deste repositório, nunca do repositório revisado.
- O git roda com lista de argumentos, sem shell, e não recebe os tokens da aplicação.
- Links de MR só são aceitos se forem do host configurado.
- Tudo que vai para disco passa por um mascaramento que troca os tokens por `[REDACTED]`.

## Documentação

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): arquitetura, contratos e decisões.
- [`docs/PATTERNS.md`](docs/PATTERNS.md): justificativa de cada padrão.
- [`docs/PLAN.md`](docs/PLAN.md): ordem de implementação, fase a fase.
