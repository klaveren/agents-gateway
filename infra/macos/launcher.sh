#!/bin/zsh
# O ícone do Agents Gateway em /Applications (`Contents/MacOS/Agents Gateway`):
#   1. no primeiro uso (ou aberto com ⌥ Option), pergunta a pasta de trabalho — projetos, banco e cofre ficam nela;
#   2. garante o servidor em segundo plano (LaunchAgent: sobe no login, volta se cair);
#   3. espera ele responder e abre a tela no navegador.
set -u
CONTENTS="${0:A:h:h}"
RES="$CONTENTS/Resources"
SUPPORT="$HOME/Library/Application Support/Agents Gateway"
CONFIG="$SUPPORT/config.env"
LOGDIR="$HOME/Library/Logs/Agents Gateway"
LABEL=com.agents-gateway.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$CONTENTS/Info.plist" 2>/dev/null)"
mkdir -p "$SUPPORT" "$LOGDIR" "$HOME/Library/LaunchAgents"

alert() { osascript -e "display alert \"Agents Gateway\" message \"$1\"" >/dev/null 2>&1 }
option_held() { osascript -l JavaScript -e 'ObjC.import("AppKit"); ($.NSEvent.modifierFlags & $.NSEventModifierFlagOption) ? "1" : "0"' 2>/dev/null }
choose_folder() { osascript -e 'POSIX path of (choose folder with prompt "Escolha a pasta de trabalho do Agents Gateway (os projetos, o banco e o cofre ficam nela):")' 2>/dev/null }

GATEWAY_DATA=""
PORT=3210
APP_VERSION=""
[ -f "$CONFIG" ] && source "$CONFIG"

restart=0
if [ -z "$GATEWAY_DATA" ] || [ "$(option_held)" = "1" ]; then
  folder="$(choose_folder)"
  [ -n "$folder" ] || exit 0 # cancelou: nada muda
  folder="${folder%/}"
  [ "$folder" != "$GATEWAY_DATA" ] && restart=1
  GATEWAY_DATA="$folder"
fi
[ "$APP_VERSION" != "$VERSION" ] && restart=1

# A configuração (lida pelo run-server.sh): valores entre aspas do zsh, a pasta pode ter espaço.
{
  print -r -- "GATEWAY_DATA=${(q)GATEWAY_DATA}"
  print -r -- "PORT=${(q)PORT}"
  print -r -- "APP_VERSION=${(q)VERSION}"
} >"$CONFIG"
chmod 600 "$CONFIG"

# O LaunchAgent aponta para ESTE app (se ele mudou de lugar, o plist muda junto).
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

for _ in {1..60}; do
  if curl -sf "http://127.0.0.1:$PORT/v1/auth/status" >/dev/null; then
    open "http://localhost:$PORT"
    exit 0
  fi
  sleep 1
done
alert "O servidor não respondeu na porta $PORT. Veja o log em $LOGDIR/server.log"
exit 1
