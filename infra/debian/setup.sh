#!/bin/bash
# Instala (ou atualiza) o gateway direto num Debian/Ubuntu, como serviço do systemd — sem contêiner.
# Idempotente: rodar de novo converge (dependências, build, unit, restart). Roda como root, a partir do código-fonte
# (um clone, ou o `git archive` que o `deploy.sh` manda).
#
#   sudo infra/debian/setup.sh
#
# Variáveis (com o padrão):
#   GATEWAY_USER=gateway                     quem roda o serviço (criado sem login se não existir; pode ser um usuário
#                                            de verdade, ex. `infoccus`, quando os projetos são dele)
#   GATEWAY_HOME=/opt/agents-gateway         onde o código fica e é compilado
#   GATEWAY_DATA=/var/lib/agents-gateway     os dados: banco, logins, `projects/<id>/` (pasta do CONVERSATIONS_DB)
#   GATEWAY_HOST=127.0.0.1  GATEWAY_PORT=3000
#   GATEWAY_ENV=/etc/agents-gateway/gateway.env   AUTH_SECRET e SECRETS_KEY (0600). Criado com valores novos se não
#                                            existir — numa migração, ponha nele os valores da instalação antiga ANTES
#   NODE_BIN=                                o node (≥ 22.13; 24 recomendado). Vazio: o do PATH, ou instala o 24 oficial
#   SKIP_APT=1                               não mexe nos pacotes do sistema
set -euo pipefail

GATEWAY_USER="${GATEWAY_USER:-gateway}"
GATEWAY_HOME="${GATEWAY_HOME:-/opt/agents-gateway}"
GATEWAY_DATA="${GATEWAY_DATA:-/var/lib/agents-gateway}"
GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}"
GATEWAY_PORT="${GATEWAY_PORT:-3000}"
GATEWAY_ENV="${GATEWAY_ENV:-/etc/agents-gateway/gateway.env}"
NODE_BIN="${NODE_BIN:-}"
SERVICE=agents-gateway

# As mesmas versões e checksums do Dockerfile: mudou lá, muda aqui.
NODE_VERSION=24.12.0
AGY_VERSION=1.4.9
AGY_SHA_AMD64=3d84e3a461b9cbf9ffc9deede155a01921380e964f51a82c0bc505db80ae8525
AGY_SHA_ARM64=0e75190d5aa48b0f7623b201cfef542cd36a1279b3d28afa7fa099983a073493
MICROMAMBA_VERSION=2.9.0-0
MAMBA_SHA_AMD64=366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3
MAMBA_SHA_ARM64=9f93b974adcb4d166996af969b6cd371287d1a3e52733704727884d9b74cb7a7

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log() { printf '\033[1;36m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠️  %s\033[0m\n' "$*"; }
die() {
  printf '\033[1;31m❌ %s\033[0m\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || die "Rode como root (sudo)."
[[ -f "$SOURCE/package.json" && -d "$SOURCE/src" ]] || die "Não achei o código do gateway em $SOURCE."
# ⛔ O `rsync --delete` abaixo apaga o que não é do código em GATEWAY_HOME: os dados nunca podem morar lá dentro.
case "$GATEWAY_HOME" in / | /usr | /usr/* | /etc | /etc/* | /var | /home | /root) die "GATEWAY_HOME perigoso: $GATEWAY_HOME" ;; esac
case "$GATEWAY_DATA/" in "$GATEWAY_HOME"/*) die "GATEWAY_DATA ($GATEWAY_DATA) não pode ficar dentro de GATEWAY_HOME ($GATEWAY_HOME)." ;; esac

case "$(dpkg --print-architecture)" in
  amd64) NODE_ARCH=x64 AGY_ARCH=x64 AGY_SHA=$AGY_SHA_AMD64 MAMBA_ARCH=64 MAMBA_SHA=$MAMBA_SHA_AMD64 ;;
  arm64) NODE_ARCH=arm64 AGY_ARCH=arm64 AGY_SHA=$AGY_SHA_ARM64 MAMBA_ARCH=aarch64 MAMBA_SHA=$MAMBA_SHA_ARM64 ;;
  *) die "Arquitetura não suportada: $(dpkg --print-architecture)" ;;
esac

# --- 1. Pacotes do sistema: o cerco (bubblewrap, socat), o navegador do agente, git e ssh das contas ---
if [[ "${SKIP_APT:-}" != 1 ]]; then
  log "Pacotes do sistema"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    ca-certificates curl rsync git openssh-client bubblewrap socat ripgrep chromium fonts-liberation >/dev/null
fi

# --- 2. Binários fora do apt, verificados por checksum ---
fetch() { # url sha destino
  local tmp
  tmp="$(mktemp)"
  curl -fsSL "$1" -o "$tmp"
  echo "$2  $tmp" | sha256sum -c --quiet - || die "checksum não confere: $1"
  mv "$tmp" "$3"
}
if [[ "$(/usr/local/bin/agy --version 2>/dev/null || true)" != *"$AGY_VERSION"* ]]; then
  log "agy $AGY_VERSION"
  fetch "https://github.com/google-antigravity/antigravity-cli/releases/download/${AGY_VERSION}/agy_cli_linux_${AGY_ARCH}.tar.gz" "$AGY_SHA" /tmp/agy.tar.gz
  mkdir -p /tmp/agy && tar -xzf /tmp/agy.tar.gz -C /tmp/agy && install -m 0755 /tmp/agy/antigravity /usr/local/bin/agy && rm -rf /tmp/agy /tmp/agy.tar.gz
fi
if [[ "$(/usr/local/bin/micromamba --version 2>/dev/null || true)" != "${MICROMAMBA_VERSION%-*}" ]]; then
  log "micromamba $MICROMAMBA_VERSION"
  fetch "https://github.com/mamba-org/micromamba-releases/releases/download/${MICROMAMBA_VERSION}/micromamba-linux-${MAMBA_ARCH}" "$MAMBA_SHA" /tmp/micromamba
  install -m 0755 /tmp/micromamba /usr/local/bin/micromamba && rm -f /tmp/micromamba
fi

# --- 3. O usuário e as pastas ---
if ! id "$GATEWAY_USER" >/dev/null 2>&1; then
  log "Usuário $GATEWAY_USER"
  useradd --system --create-home --home-dir "/home/$GATEWAY_USER" --shell /usr/sbin/nologin "$GATEWAY_USER"
fi
USER_HOME="$(getent passwd "$GATEWAY_USER" | cut -d: -f6)"
mkdir -p "$GATEWAY_HOME" "$GATEWAY_DATA"
# A pasta dos dados é só do dono: banco, logins dos CLIs e as pastas dos projetos.
chown "$GATEWAY_USER:$GATEWAY_USER" "$GATEWAY_DATA" && chmod 700 "$GATEWAY_DATA"

# --- 4. Node: o pedido, o do PATH, ou o 24 oficial (verificado pelo SHASUMS256 do nodejs.org) ---
node_ok() { [[ -x "$1" ]] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
if [[ -z "$NODE_BIN" ]]; then NODE_BIN="$(command -v node || true)"; fi
if ! node_ok "${NODE_BIN:-/nonexistent}"; then
  NODE_DIR_OFFICIAL="/opt/node-v$NODE_VERSION-linux-$NODE_ARCH"
  if ! node_ok "$NODE_DIR_OFFICIAL/bin/node"; then
    log "Node $NODE_VERSION (oficial)"
    base="https://nodejs.org/dist/v$NODE_VERSION"
    file="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
    sha="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$file" '$2==f{print $1}')"
    [[ -n "$sha" ]] || die "Sem checksum do Node para $file"
    fetch "$base/$file" "$sha" "/tmp/$file"
    tar -xJf "/tmp/$file" -C /opt && rm -f "/tmp/$file"
  fi
  NODE_BIN="$NODE_DIR_OFFICIAL/bin/node"
fi
NODE_DIR="$(dirname "$NODE_BIN")"
log "Node: $NODE_BIN ($("$NODE_BIN" --version))"

# --- 5. O código e o build (como o dono do serviço: o build não roda como root) ---
log "Código em $GATEWAY_HOME"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude web/node_modules --exclude web/dist \
  --exclude data --exclude .git --exclude .env --exclude 'docs/integration' \
  "$SOURCE/" "$GATEWAY_HOME/"
chown -R "$GATEWAY_USER:$GATEWAY_USER" "$GATEWAY_HOME"
as_user() { sudo -u "$GATEWAY_USER" -H env PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 "$@"; }
log "Build (backend e tela)"
as_user bash -c "cd '$GATEWAY_HOME' && corepack pnpm install --frozen-lockfile --reporter=silent && corepack pnpm run build >/dev/null"
as_user bash -c "cd '$GATEWAY_HOME/web' && corepack pnpm install --frozen-lockfile --reporter=silent && corepack pnpm build >/dev/null"

# --- 6. As chaves do serviço: criadas uma vez, nunca sobrescritas ---
if [[ ! -f "$GATEWAY_ENV" ]]; then
  log "Chaves novas em $GATEWAY_ENV"
  mkdir -p "$(dirname "$GATEWAY_ENV")"
  umask 077
  printf 'AUTH_SECRET=%s\nSECRETS_KEY=%s\n' "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" >"$GATEWAY_ENV"
  warn "Migração? Troque AUTH_SECRET e SECRETS_KEY em $GATEWAY_ENV pelos da instalação antiga antes de subir com o banco dela."
fi
chmod 600 "$GATEWAY_ENV"

# --- 7. O cerco precisa de user namespaces: confere como o usuário do serviço ---
if ! sudo -u "$GATEWAY_USER" bwrap --ro-bind / / --dev /dev --unshare-user --unshare-pid true 2>/dev/null; then
  warn "O bubblewrap não abriu um user namespace: sem cerco, o terminal dos agentes de projeto fica recusado."
  if [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == 1 ]]; then
    warn "Ubuntu com AppArmor restringindo user namespaces: libere o bwrap (perfil bwrap-userns-restrict) ou kernel.apparmor_restrict_unprivileged_userns=0."
  fi
fi

# --- 8. A unit do systemd ---
log "Serviço $SERVICE ($GATEWAY_HOST:$GATEWAY_PORT)"
cat >"/etc/systemd/system/$SERVICE.service" <<UNIT
# Gerada por infra/debian/setup.sh — não edite aqui: rode o setup de novo.
[Unit]
Description=Agents Gateway ($GATEWAY_HOST:$GATEWAY_PORT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$GATEWAY_USER
Group=$GATEWAY_USER
WorkingDirectory=$GATEWAY_HOME
Environment=HOME=$USER_HOME
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Environment=HOST=$GATEWAY_HOST
Environment=PORT=$GATEWAY_PORT
Environment=CONVERSATIONS_DB=$GATEWAY_DATA/gateway.db
EnvironmentFile=$GATEWAY_ENV
ExecStart=$NODE_BIN dist/main.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

# --- 9. Conferência ---
for _ in $(seq 1 30); do
  if curl -fsS "http://$GATEWAY_HOST:$GATEWAY_PORT/v1/health" >/dev/null 2>&1; then
    log "✅ No ar: http://$GATEWAY_HOST:$GATEWAY_PORT ($(git -C "$SOURCE" rev-parse --short HEAD 2>/dev/null || echo 'sem git'))"
    journalctl -u "$SERVICE" --since '-2min' --no-pager -o cat | grep '\[setup\]' || true
    exit 0
  fi
  sleep 1
done
journalctl -u "$SERVICE" -n 40 --no-pager -o cat
die "O serviço não respondeu em /v1/health."
