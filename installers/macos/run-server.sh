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
# O build deste app (`<versão>+<commit>`), para o "Sobre" da tela dizer qual instalador está rodando.
export GATEWAY_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${RES:h}/Info.plist" 2>/dev/null)"
# O código do primeiro admin, o mesmo que o app põe no endereço do setup (sem ele, o servidor sortearia um a cada início).
[ -n "${SETUP_CODE:-}" ] && export SETUP_CODE
# 🧰 O kit do app primeiro (node, npm, npx, corepack, micromamba, agy): o terminal dos agentes e a guia Pacotes não dependem do
# que a máquina tem. Depois, o que a máquina tem (os CLIs de assinatura, o git do sistema).
export PATH="$RES/runtime/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$RES/app"
exec "$RES/runtime/bin/node" "$RES/app/dist/main.js"
