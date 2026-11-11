#!/bin/zsh
# Gera o pacote .deb do Agents Gateway para Debian/Ubuntu, do que está COMMITADO (`git archive HEAD`), compilado num
# contêiner Debian da arquitetura certa (as dependências nativas saem para Linux) e com o Node 24 dentro do pacote.
#
#   installers/debian/build-deb.sh [amd64|arm64|all]   → installers/debian/dist/agents-gateway_<versão>_<arch>.deb
#
# Precisa do Docker (com buildx/qemu para a arquitetura que não é a desta máquina: emulada, mais lenta).
set -eu
ROOT="${0:A:h:h:h}"
HERE="${0:A:h}"
OUT="$HERE/dist"
NODE_IMAGE=node:24.12.0-bookworm
TARGET="${1:-all}"
case "$TARGET" in amd64 | arm64) ARCHES=("$TARGET") ;; all) ARCHES=(amd64 arm64) ;; *) echo "uso: $0 [amd64|arm64|all]" >&2; exit 1 ;; esac
VERSION="$(node -p "require('$ROOT/package.json').version")"
# A versão do Debian: `-` separa a revisão do pacote; o pré-lançamento vira `~` (ordena antes da versão final).
DEB_VERSION="${VERSION//-/~}-1"
mkdir -p "$OUT"

for ARCH in $ARCHES; do
  echo "▶ $ARCH: montagem limpa do HEAD ($(git -C "$ROOT" rev-parse --short HEAD))"
  WORK="$OUT/work-$ARCH"
  rm -rf "$WORK"
  mkdir -p "$WORK/src"
  git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$WORK/src"
  cp -R "$HERE/package" "$WORK/package"

  echo "▶ $ARCH: build no contêiner ($NODE_IMAGE)"
  docker run --rm --platform "linux/$ARCH" -v "$WORK:/work" -w /work/src -e DEB_VERSION="$DEB_VERSION" -e ARCH="$ARCH" "$NODE_IMAGE" bash -euc '
    corepack enable >/dev/null 2>&1
    pnpm install --frozen-lockfile --silent
    pnpm build >/dev/null
    pnpm build:web >/dev/null 2>&1
    CI=true pnpm install --prod --frozen-lockfile --silent

    ROOTFS=/work/root
    rm -rf "$ROOTFS"
    mkdir -p "$ROOTFS/opt/agents-gateway/bin" "$ROOTFS/opt/agents-gateway/app/web" "$ROOTFS/lib/systemd/system" "$ROOTFS/usr/bin" "$ROOTFS/DEBIAN"
    cp "$(command -v node)" "$ROOTFS/opt/agents-gateway/bin/node"
    cp -R dist node_modules package.json "$ROOTFS/opt/agents-gateway/app/"
    cp -R web/dist "$ROOTFS/opt/agents-gateway/app/web/dist"
    cp /work/package/agents-gateway.service "$ROOTFS/lib/systemd/system/"
    install -m 755 /work/package/agents-gateway "$ROOTFS/usr/bin/agents-gateway"
    cp /work/package/DEBIAN/* "$ROOTFS/DEBIAN/"
    chmod 755 "$ROOTFS/DEBIAN/config" "$ROOTFS/DEBIAN/postinst" "$ROOTFS/DEBIAN/prerm" "$ROOTFS/DEBIAN/postrm"
    cat >"$ROOTFS/DEBIAN/control" <<CONTROL
Package: agents-gateway
Version: $DEB_VERSION
Architecture: $ARCH
Maintainer: Agents Gateway <noreply@agents-gateway.local>
Section: net
Priority: optional
Installed-Size: $(du -sk "$ROOTFS" | cut -f1)
Depends: bubblewrap, socat, proxychains4, git, openssh-client, ripgrep, ca-certificates, curl, debconf (>= 0.5) | debconf-2.0, passwd
Recommends: chromium, fonts-liberation
Description: Agents Gateway: o gateway dos agentes como serviço do systemd
 A tela e a API dos agentes (projetos, conversas, ferramentas, permissões),
 com o Node 24 embutido. Pergunta na instalação a pasta de dados, o endereço
 e a porta; muda depois com dpkg-reconfigure agents-gateway.
CONTROL
    dpkg-deb --root-owner-group --build "$ROOTFS" "/work/agents-gateway_${DEB_VERSION}_${ARCH}.deb" >/dev/null
  '
  mv "$WORK/agents-gateway_${DEB_VERSION}_${ARCH}.deb" "$OUT/"
  rm -rf "$WORK"
  echo "✅ $OUT/agents-gateway_${DEB_VERSION}_${ARCH}.deb"
done
