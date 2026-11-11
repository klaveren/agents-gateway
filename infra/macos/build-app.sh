#!/bin/zsh
# Gera o "Agents Gateway.app" (uma janela própria, WebKit) e o .dmg (uso pessoal: sem assinatura da Apple; assinatura ad-hoc, que basta para o app
# construído nesta máquina). Do que está COMMITADO (`git archive HEAD`), com o Node desta máquina dentro do app.
#
#   infra/macos/build-app.sh            → dist-mac/Agents Gateway.app e dist-mac/Agents-Gateway-<versão>.dmg
set -eu
ROOT="${0:A:h:h:h}"
OUT="$ROOT/dist-mac"
STAGE="$OUT/stage"
APP="$OUT/Agents Gateway.app"
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || { echo "node não encontrado no PATH" >&2; exit 1 }
case "$("$NODE_BIN" -v)" in v24.*) ;; *) echo "precisa do Node 24 (achei $("$NODE_BIN" -v))" >&2; exit 1 ;; esac
VERSION="$(node -p "require('$ROOT/package.json').version")"
# O build: a versão + o commit. Muda a cada build, e é por ela que o app sabe que precisa reiniciar o servidor.
BUILD="$VERSION+$(git -C "$ROOT" rev-parse --short HEAD)"

echo "▶ montagem limpa do HEAD ($(git -C "$ROOT" rev-parse --short HEAD))"
rm -rf "$OUT"
mkdir -p "$STAGE"
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$STAGE"

echo "▶ dependências e build"
(cd "$STAGE" && pnpm install --frozen-lockfile --silent && pnpm build && pnpm build:web >/dev/null && CI=true pnpm install --prod --frozen-lockfile --silent)

echo "▶ app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
cp -R "$STAGE/dist" "$STAGE/node_modules" "$STAGE/package.json" "$APP/Contents/Resources/app/"
mkdir -p "$APP/Contents/Resources/app/web"
cp -R "$STAGE/web/dist" "$APP/Contents/Resources/app/web/dist"
cp "$NODE_BIN" "$APP/Contents/Resources/node"
cp "$ROOT/infra/macos/run-server.sh" "$ROOT/infra/macos/service.sh" "$APP/Contents/Resources/"
# A janela (WebKit): o executável do app. Precisa das Command Line Tools (`xcode-select --install`).
swiftc -O -target arm64-apple-macos12.0 "$ROOT/infra/macos/App.swift" -o "$APP/Contents/MacOS/Agents Gateway"
chmod +x "$APP/Contents/MacOS/Agents Gateway" "$APP/Contents/Resources/run-server.sh" "$APP/Contents/Resources/service.sh" "$APP/Contents/Resources/node"

echo "▶ ícone"
ICONSET="$OUT/AppIcon.iconset"
mkdir -p "$ICONSET"
# O desenho é o `AppIcon.svg`; o PNG de 1024 já vem gerado dele (`rsvg-convert -w 1024 AppIcon.svg -o AppIcon.png`).
for size in 16 32 128 256 512; do
  sips -z $size $size "$ROOT/infra/macos/AppIcon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$ROOT/infra/macos/AppIcon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Agents Gateway</string>
  <key>CFBundleDisplayName</key><string>Agents Gateway</string>
  <key>CFBundleIdentifier</key><string>com.agents-gateway.app</string>
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>Agents Gateway</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

echo "▶ assinatura ad-hoc"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (assinatura ad-hoc falhou: o app abre com botão direito → Abrir)"

# O ícone também no PRÓPRIO executável: é ele que o LaunchAgent roda, e os Itens de Início do macOS mostram o ícone do
# arquivo do serviço. Depois da assinatura (o ícone fica num atributo do arquivo, fora do que ela confere).
osascript -l JavaScript -e "ObjC.import('AppKit'); \$.NSWorkspace.sharedWorkspace.setIconForFileOptions(\$.NSImage.alloc.initWithContentsOfFile('$ROOT/infra/macos/AppIcon.png'), '$APP/Contents/MacOS/Agents Gateway', 0)" >/dev/null

echo "▶ dmg"
DMG_DIR="$OUT/dmg"
mkdir -p "$DMG_DIR"
cp -R "$APP" "$DMG_DIR/"
ln -s /Applications "$DMG_DIR/Applications"
hdiutil create -volname "Agents Gateway" -srcfolder "$DMG_DIR" -ov -format UDZO "$OUT/Agents-Gateway-$VERSION.dmg" >/dev/null
rm -rf "$STAGE" "$DMG_DIR" "$ICONSET"
echo "✅ $OUT/Agents-Gateway-$VERSION.dmg"
