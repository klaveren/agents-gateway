#!/bin/zsh
# O servidor do Agents Gateway em segundo plano, chamado pelo app (a janela, `App.swift`):
#   - grava a configuração (a pasta de trabalho em AG_DATA, quando escolhida agora; o código de instalação, uma vez);
#   - garante o LaunchAgent (sobe no login, volta se cair) apontando para este app, e o reinicia quando algo mudou;
#   - espera o servidor responder e imprime o endereço que a janela abre (o setup já com o código, no primeiro uso).
# Sai com 1 (e o motivo no stderr) se o servidor não subir.
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
[ -f "$CONFIG" ] && source "$CONFIG"

restart=0
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
} >"$CONFIG"
chmod 600 "$CONFIG"

plist="$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>$RES/run-server.sh</string></array>
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
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  sleep 1
  launchctl bootstrap "$DOMAIN" "$PLIST"
fi

for _ in {1..90}; do
  status="$(curl -sf "http://127.0.0.1:$PORT/v1/auth/status")"
  if [ -n "$status" ]; then
    case "$status" in
      *'"setupRequired":true'*) print -r -- "http://localhost:$PORT/setup?code=$SETUP_CODE" ;;
      *) print -r -- "http://localhost:$PORT/" ;;
    esac
    exit 0
  fi
  sleep 1
done
echo "o servidor não respondeu na porta $PORT. Veja o log em $LOGDIR/server.log" >&2
exit 1
