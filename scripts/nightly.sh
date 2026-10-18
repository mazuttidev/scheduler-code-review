#!/usr/bin/env bash
#
# Chamado pelo agendador (cron, systemd ou launchd) para rodar o nightly-review.
#
# Os agendadores não carregam o seu shell, então o ambiente é definido aqui.
# O script roda o que está em dist/: execute `npm run build` antes de agendar
# e depois de cada atualização do projeto.
#
# Variáveis opcionais:
#   NIGHTLY_REVIEW_PATH      PATH usado na execução; precisa conter o Node.js 22+ e o git.
#   NIGHTLY_REVIEW_CONFIG    arquivo de configuração (padrão: review.config.json).
#   NIGHTLY_REVIEW_ENV_FILE  arquivo com os tokens (padrão: .env).
#   NIGHTLY_REVIEW_LOG_DIR   pasta do cron.log (padrão: ~/.nightly-review/logs).

set -euo pipefail
umask 077

export PATH="${NIGHTLY_REVIEW_PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin}"
export NIGHTLY_REVIEW_ENV_FILE="${NIGHTLY_REVIEW_ENV_FILE:-.env}"
CONFIG="${NIGHTLY_REVIEW_CONFIG:-review.config.json}"
LOG_DIR="${NIGHTLY_REVIEW_LOG_DIR:-$HOME/.nightly-review/logs}"

cd "$(dirname "$0")/.."

# Daqui em diante, tudo que o script e a aplicação escrevem vai para o log.
mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/cron.log" 2>&1

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] nightly-review: início"

fail() {
  echo "nightly-review: $1"
  exit 1
}

command -v node > /dev/null 2>&1 || fail "node não encontrado no PATH ($PATH)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "é preciso Node.js 22 ou superior (encontrado: $(node --version))"

[ -f dist/cli/index.js ] || fail "dist/cli/index.js não existe; rode npm run build"

# NOTION_TOKEN, GITLAB_TOKEN e CLAUDE_CODE_OAUTH_TOKEN. As variantes locais não precisam deles.
if [ -f "$NIGHTLY_REVIEW_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$NIGHTLY_REVIEW_ENV_FILE"
  set +a
fi

exec node dist/cli/index.js run --config "$CONFIG"
