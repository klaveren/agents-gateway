#!/bin/bash
# Leva o gateway da estação para um servidor Debian e roda o setup lá. O servidor não precisa de acesso ao GitHub:
# o código vai pelo SSH, como `git archive` de um commit (por padrão o `origin/main`, já mesclado).
#
#   GATEWAY_USER=infoccus GATEWAY_DATA=/data/agents-gateway GATEWAY_HOST=10.10.0.4 GATEWAY_PORT=3100 \
#     infra/debian/deploy.sh 10.10.0.4 [ref]
#
# As variáveis GATEWAY_*, NODE_BIN e SKIP_APT seguem para o `setup.sh` (ver o cabeçalho dele).
set -euo pipefail

HOST="${1:?uso: infra/debian/deploy.sh <host ssh> [ref]}"
REF="${2:-origin/main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

git fetch -q origin
REVISION="$(git rev-parse --short "$REF")"
echo "🚀 $REF ($REVISION) → $HOST"

# Só as variáveis do setup atravessam, entre aspas simples (o valor não é interpretado pelo shell remoto).
forward=""
for name in GATEWAY_USER GATEWAY_HOME GATEWAY_DATA GATEWAY_HOST GATEWAY_PORT GATEWAY_ENV NODE_BIN SKIP_APT; do
  if [[ -n "${!name:-}" ]]; then forward+=" $name='${!name//\'/}'"; fi
done

git archive --format=tar "$REF" | ssh -o BatchMode=yes "$HOST" "set -e
  src=\$(mktemp -d /tmp/agents-gateway.XXXXXX)
  trap 'rm -rf \"\$src\"' EXIT
  tar -x -C \"\$src\"
  sudo env$forward bash \"\$src/infra/debian/setup.sh\""
