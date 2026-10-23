#!/bin/bash
# Publica a imagem do gateway no registry privado (registry.infoccus.com.br), amd64 + arm64.
# Mesmo caminho do Logiccus: `logiccus docker-build-push`. Uso: infra/build-push.sh [--allow-dirty]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ⛔ A imagem tem que corresponder a um commit do main: sem isso, ninguém sabe o que está rodando.
if [[ "${1:-}" != "--allow-dirty" ]]; then
  [[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || { echo "❌ Publique a partir do main (está em $(git rev-parse --abbrev-ref HEAD))."; exit 1; }
  [[ -z "$(git status --porcelain)" ]] || { echo "❌ Árvore suja: faça commit ou descarte antes de publicar."; exit 1; }
fi

VERSION="$(node -p "require('./package.json').version")"
REVISION="$(git rev-parse --short HEAD)"
TAG="${DOCKER_TAG:-$VERSION-$REVISION}"
NAME="${DOCKER_IMAGE_NAME:-agents-gateway}"

echo "🚀 $NAME:$TAG (e latest) — versão $VERSION, commit $REVISION, plataformas amd64 + arm64"

# `--skip-deps`: o gateway não tem dependência `workspace:*` para converter (é o que o CLI faz no package.json).
# `--ignore-package`: pula o gate de frescor dos pacotes `@logiccus/*`, que o gateway não usa.
# O `latest` sai do mesmo build, do cache: limpeza só no primeiro.
build() {
  logiccus docker-build-push --name "$NAME" \
    --file "$ROOT/Dockerfile" \
    --platform multi \
    --tag "$1" \
    --cleanup "$2" \
    --skip-deps \
    --ignore-package \
    --verbose \
    --build-arg BUILD_VERSION="$VERSION" \
    --build-arg BUILD_REVISION="$REVISION"
}

build "$TAG" aggressive
build latest none
