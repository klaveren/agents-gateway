#!/bin/zsh
# O servidor do Agents Gateway em segundo plano, chamado pelo app (a janela, `App.swift`):
#   - grava a configuração (a pasta de trabalho em AG_DATA, quando escolhida agora; o código de instalação, uma vez);
#   - garante o LaunchAgent (sobe no login, volta se cair) apontando para este app, e o reinicia quando algo mudou;
#   - espera o servidor responder e imprime o endereço que a janela abre (o setup já com o código, no primeiro uso).
# Sai com 1 (e o motivo no stderr) se o servidor não subir.
#
# `service.sh restart`: o mesmo, reiniciando o servidor de qualquer jeito.
# `service.sh stop`: só para o servidor (menu Servidor do app; é o que libera o app para ser trocado por uma versão nova).
# `service.sh status`: só diz o estado, `running <porta>` ou `stopped <porta>`.
set -u
RES="${0:A:h}"
CONTENTS="${RES:h}"
SUPPORT="$HOME/Library/Application Support/Agents Gateway"
CONFIG="$SUPPORT/config.env"
LOGDIR="$HOME/Library/Logs/Agents Gateway"
LABEL=com.agents-gateway.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$CONTENTS/Info.plist" 2>/dev/null)"
mkdir -p "$SUPPORT" "$LOGDIR" "$HOME/Library/LaunchAgents"

GATEWAY_DATA=""
PORT=3210
APP_VERSION=""
SETUP_CODE=""
NETWORK_ACCESS=0
[ -f "$CONFIG" ] && source "$CONFIG"

# Tira o serviço do launchd e espera o processo sair de fato (o launchd dá 20 s a ele antes de matar).
stop_service() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  for _ in {1..30}; do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || return 0
    sleep 1
  done
  return 1
}

# ⚖️ Parar não desfaz a instalação: o LaunchAgent fica no lugar, e o servidor volta ao abrir o app, no "Iniciar" do menu ou
# no próximo login.
if [ "${1:-}" = stop ]; then
  stop_service || { echo "o servidor não parou. Veja o log em $LOGDIR/server.log" >&2; exit 1 }
  exit 0
fi

# O IPv4 deste Mac na rede (a interface da rota padrão): o endereço que os outros aparelhos usam com o acesso pela rede.
lan_address() {
  local iface="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')"
  [ -n "$iface" ] && ipconfig getifaddr "$iface" 2>/dev/null
}

# No ar = carregado no launchd: é ele quem mantém o processo vivo. Depois da porta: o acesso pela rede (1/0) e o endereço na rede.
if [ "${1:-}" = status ]; then
  state=stopped
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && state=running
  print -r -- "$state $PORT ${NETWORK_ACCESS:-0} $(lan_address)"
  exit 0
fi

restart=0
[ "${1:-}" = restart ] && restart=1
# ⚖️ O acesso pela rede (menu Servidor): liga ou desliga e reinicia — o endereço em que o servidor ouve só muda ao subir.
if [ "${1:-}" = network ]; then
  case "${2:-}" in
    on) NETWORK_ACCESS=1 ;;
    off) NETWORK_ACCESS=0 ;;
    *) echo "use: network on|off" >&2; exit 2 ;;
  esac
  restart=1
fi
if [ -n "${AG_DATA:-}" ] && [ "${AG_DATA%/}" != "$GATEWAY_DATA" ]; then
  GATEWAY_DATA="${AG_DATA%/}"
  restart=1
fi
[ -n "$GATEWAY_DATA" ] || { echo "sem pasta de trabalho" >&2; exit 1 }
[ "$APP_VERSION" != "$VERSION" ] && restart=1
# O código do primeiro admin: um, desta instalação (o servidor o usa no lugar de sortear um a cada início).
if [ -z "$SETUP_CODE" ]; then
  SETUP_CODE="$(od -An -tx1 -N6 /dev/urandom | tr -d ' \n' | tr 'a-f' 'A-F' | sed -E 's/(....)(....)(....)/\1-\2-\3/')"
  restart=1
fi

{
  print -r -- "GATEWAY_DATA=${(q)GATEWAY_DATA}"
  print -r -- "PORT=${(q)PORT}"
  print -r -- "APP_VERSION=${(q)VERSION}"
  print -r -- "SETUP_CODE=${(q)SETUP_CODE}"
  print -r -- "NETWORK_ACCESS=${(q)NETWORK_ACCESS}"
} >"$CONFIG"
chmod 600 "$CONFIG"

plist="$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>AssociatedBundleIdentifiers</key><string>com.agents-gateway.app</string>
  <key>ProgramArguments</key>
  <array><string>$CONTENTS/MacOS/Agents Gateway</string><string>--server</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGDIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/server.log</string>
</dict>
</plist>
PLIST
)"
if [ ! -f "$PLIST" ] || [ "$(cat "$PLIST")" != "$plist" ]; then
  print -r -- "$plist" >"$PLIST"
  restart=1
fi

if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootstrap "$DOMAIN" "$PLIST"
elif [ "$restart" = 1 ]; then
  stop_service
  launchctl bootstrap "$DOMAIN" "$PLIST"
fi

for _ in {1..90}; do
  reply="$(curl -sf "http://127.0.0.1:$PORT/v1/auth/status")"
  if [ -n "$reply" ]; then
    case "$reply" in
      *'"setupRequired":true'*) print -r -- "http://localhost:$PORT/setup?code=$SETUP_CODE" ;;
      *) print -r -- "http://localhost:$PORT/" ;;
    esac
    exit 0
  fi
  sleep 1
done
echo "o servidor não respondeu na porta $PORT. Veja o log em $LOGDIR/server.log" >&2
exit 1
