#!/bin/zsh
# O servidor do Agents Gateway no Mac: o que o LaunchAgent (com.agents-gateway.server) roda no login.
#
# ⚖️ O processo roda de dentro do app (como o `WorkingDirectory` do Debian), não da pasta de trabalho: o cerco dos
# agentes nega ler a pasta do processo, e os projetos moram na de trabalho.
set -u
RES="${0:A:h}"
CONFIG="$HOME/Library/Application Support/Agents Gateway/config.env"
[ -f "$CONFIG" ] || { echo "sem $CONFIG: abra o Agents Gateway em /Applications para escolher a pasta de trabalho" >&2; exit 78; }
source "$CONFIG"
[ -n "${GATEWAY_DATA:-}" ] || { echo "GATEWAY_DATA vazio em $CONFIG" >&2; exit 78; }
mkdir -p "$GATEWAY_DATA"

export CONVERSATIONS_DB="$GATEWAY_DATA/gateway.db"
export PORT="${PORT:-3210}"
export HOST=127.0.0.1
export NODE_ENV=production
# O código do primeiro admin, o mesmo que o app põe no endereço do setup (sem ele, o servidor sortearia um a cada início).
[ -n "${SETUP_CODE:-}" ] && export SETUP_CODE
# O Node do app primeiro; depois o que os CLIs de assinatura (Claude, Codex), o git e os MCPs por `npx` precisam.
NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
export PATH="$RES:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin${NVM_BIN:+:$NVM_BIN}:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$RES/app"
exec "$RES/node" "$RES/app/dist/main.js"
