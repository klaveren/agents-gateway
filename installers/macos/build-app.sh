#!/bin/zsh
# Gera o "Agents Gateway.app" (uma janela própria, WebKit) e o .dmg (uso pessoal: sem assinatura da Apple; assinatura ad-hoc, que basta para o app
# construído nesta máquina). Do que está COMMITADO (`git archive HEAD`), com o Node desta máquina dentro do app.
#
#   installers/macos/build-app.sh            → installers/macos/dist/Agents Gateway.app e installers/macos/dist/Agents-Gateway-<versão>.dmg
set -eu
ROOT="${0:A:h:h:h}"
OUT="$ROOT/installers/macos/dist"
STAGE="$OUT/stage"
APP="$OUT/Agents Gateway.app"
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || { echo "node não encontrado no PATH" >&2; exit 1 }
case "$("$NODE_BIN" -v)" in v24.*) ;; *) echo "precisa do Node 24 (achei $("$NODE_BIN" -v))" >&2; exit 1 ;; esac
VERSION="$(node -p "require('$ROOT/package.json').version")"
# O micromamba (a guia Pacotes, conda-forge): a MESMA versão da imagem e do setup do Debian, conferida pelo checksum.
MICROMAMBA_VERSION=2.9.0-0
MAMBA_SHA_OSX_ARM64=ec2a072f028e1a7cf20f3e2e74d5a8127cf5a5f27636375b5359811565f4e5be
# O Antigravity CLI (`agy`, assinatura do Gemini): a MESMA versão da imagem; o checksum é o que a release publica.
AGY_VERSION=1.4.9
AGY_SHA_MAC_ARM64=64204e14975e632ae7f26912bed48d49ffe17bb2719093ca38c00276b1f134f0
# O build: a versão + o commit. Muda a cada build, e é por ela que o app sabe que precisa reiniciar o servidor.
BUILD="$VERSION+$(git -C "$ROOT" rev-parse --short HEAD)"

# ⛔ Todo build sai com a versão incrementada: dois instaladores com a mesma versão não se distinguem no "Sobre".
[ ! -e "$OUT/Agents-Gateway-$VERSION.dmg" ] || { echo "a versão $VERSION já tem instalador: suba a versão (npm version prerelease --no-git-tag-version), commit, e rode de novo" >&2; exit 1 }

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
# 🧰 O KIT DO SERVIDOR, o mesmo da imagem (o terminal dos agentes e a guia Pacotes não dependem do que a máquina tem): o
# Node com npm, npx e corepack — só eles, sem os globais de quem gera —, o micromamba e o Antigravity (`agy`). Claude e
# Codex já vêm nas dependências (os binários da plataforma). Fica em `Resources/runtime/bin`, primeiro no PATH.
RUNTIME="$APP/Contents/Resources/runtime"
NODE_PREFIX="${NODE_BIN:A:h:h}"
mkdir -p "$RUNTIME/bin" "$RUNTIME/lib/node_modules"
cp "$NODE_BIN" "$RUNTIME/bin/node"
cp -R "$NODE_PREFIX/lib/node_modules/npm" "$NODE_PREFIX/lib/node_modules/corepack" "$RUNTIME/lib/node_modules/"
ln -s ../lib/node_modules/npm/bin/npm-cli.js "$RUNTIME/bin/npm"
ln -s ../lib/node_modules/npm/bin/npx-cli.js "$RUNTIME/bin/npx"
ln -s ../lib/node_modules/corepack/dist/corepack.js "$RUNTIME/bin/corepack"
MAMBA_CACHE="$ROOT/installers/macos/dist/cache/micromamba-$MICROMAMBA_VERSION-osx-arm64"
mkdir -p "${MAMBA_CACHE:h}"
[ -f "$MAMBA_CACHE" ] || curl -fsSL -o "$MAMBA_CACHE" "https://github.com/mamba-org/micromamba-releases/releases/download/$MICROMAMBA_VERSION/micromamba-osx-arm64"
echo "$MAMBA_SHA_OSX_ARM64  $MAMBA_CACHE" | shasum -a 256 -c - >/dev/null || { echo "micromamba com checksum diferente: abortado" >&2; rm -f "$MAMBA_CACHE"; exit 1 }
install -m 755 "$MAMBA_CACHE" "$RUNTIME/bin/micromamba"
AGY_CACHE="$ROOT/installers/macos/dist/cache/agy-$AGY_VERSION-mac-arm64.tar.gz"
[ -f "$AGY_CACHE" ] || curl -fsSL -o "$AGY_CACHE" "https://github.com/google-antigravity/antigravity-cli/releases/download/$AGY_VERSION/agy_cli_mac_arm64.tar.gz"
echo "$AGY_SHA_MAC_ARM64  $AGY_CACHE" | shasum -a 256 -c - >/dev/null || { echo "agy com checksum diferente: abortado" >&2; rm -f "$AGY_CACHE"; exit 1 }
AGY_TMP="$OUT/agy"
mkdir -p "$AGY_TMP"
tar -xzf "$AGY_CACHE" -C "$AGY_TMP"
install -m 755 "$AGY_TMP/antigravity" "$RUNTIME/bin/agy"
rm -rf "$AGY_TMP"
cp "$ROOT/installers/macos/run-server.sh" "$ROOT/installers/macos/service.sh" "$APP/Contents/Resources/"
# A janela (WebKit): o executável do app. Precisa das Command Line Tools (`xcode-select --install`).
swiftc -O -target arm64-apple-macos12.0 "$ROOT/installers/macos/App.swift" -o "$APP/Contents/MacOS/Agents Gateway"
chmod +x "$APP/Contents/MacOS/Agents Gateway" "$APP/Contents/Resources/run-server.sh" "$APP/Contents/Resources/service.sh"

echo "▶ ícone"
ICONSET="$OUT/AppIcon.iconset"
mkdir -p "$ICONSET"
# O desenho é o `AppIcon.svg`; o PNG de 1024 já vem gerado dele (`rsvg-convert -w 1024 AppIcon.svg -o AppIcon.png`).
for size in 16 32 128 256 512; do
  sips -z $size $size "$ROOT/installers/macos/AppIcon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$ROOT/installers/macos/AppIcon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
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
  <key>NSLocalNetworkUsageDescription</key><string>Para abrir os gateways que você cadastrou na rede local.</string>
</dict>
</plist>
PLIST

echo "▶ assinatura ad-hoc"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (assinatura ad-hoc falhou: o app abre com botão direito → Abrir)"

# O ícone também no PRÓPRIO executável: é ele que o LaunchAgent roda, e os Itens de Início do macOS mostram o ícone do
# arquivo do serviço. Depois da assinatura (o ícone fica num atributo do arquivo, fora do que ela confere).
osascript -l JavaScript -e "ObjC.import('AppKit'); \$.NSWorkspace.sharedWorkspace.setIconForFileOptions(\$.NSImage.alloc.initWithContentsOfFile('$ROOT/installers/macos/AppIcon.png'), '$APP/Contents/MacOS/Agents Gateway', 0)" >/dev/null

echo "▶ dmg"
DMG_DIR="$OUT/dmg"
mkdir -p "$DMG_DIR"
cp -R "$APP" "$DMG_DIR/"
ln -s /Applications "$DMG_DIR/Applications"
hdiutil create -volname "Agents Gateway" -srcfolder "$DMG_DIR" -ov -format UDZO "$OUT/Agents-Gateway-$VERSION.dmg" >/dev/null
rm -rf "$STAGE" "$DMG_DIR" "$ICONSET"
# O cache do micromamba fica (o próximo build não baixa de novo).
echo "✅ $OUT/Agents-Gateway-$VERSION.dmg"
