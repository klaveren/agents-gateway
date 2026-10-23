# syntax=docker/dockerfile:1

# A deny-list do run_bash barra o comando catastrófico, mas não é contenção: um modelo com
# shell continua rodando como o seu usuário, no seu $HOME. Este container é a contenção.

# Globais: valem nas linhas `FROM` (o estágio do Antigravity escolhe o download pela arquitetura).
ARG AGY_VERSION=1.4.6
ARG TARGETARCH

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# A tela (Vue) compila à parte: o gateway serve `web/dist`, e o `node_modules` dela não vai para a imagem.
FROM node:24-slim AS web
WORKDIR /web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web ./
RUN pnpm build

FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# Sem --no-optional de propósito: o binário do Claude Code vem como optionalDependency por
# plataforma, e sem ele a lane agent do Claude falha no primeiro turno.
RUN pnpm install --frozen-lockfile --prod

# O Antigravity CLI oficial (github.com/google-antigravity/antigravity-cli): versão FIXA e sha256 CONFERIDO
# pelo próprio BuildKit (`ADD --checksum`) — download que não bate com o hash derruba o build.
FROM scratch AS agy-arm64
ARG AGY_VERSION
ADD --checksum=sha256:ef88c996178b55a3c5416f2c8b67a9c343ac0a62c900e7b7158ee2ff1135ad96 \
    https://github.com/google-antigravity/antigravity-cli/releases/download/${AGY_VERSION}/agy_cli_linux_arm64.tar.gz /agy.tar.gz
FROM scratch AS agy-amd64
ARG AGY_VERSION
ADD --checksum=sha256:513c74ad3e70323839a65d8dccc6f9977b0903e5facd914cbb06be283c2bb640 \
    https://github.com/google-antigravity/antigravity-cli/releases/download/${AGY_VERSION}/agy_cli_linux_x64.tar.gz /agy.tar.gz
# `TARGETARCH` (do buildx: amd64 / arm64) escolhe o download da plataforma.
FROM agy-${TARGETARCH} AS agy-download
FROM node:24-slim AS agy
COPY --from=agy-download /agy.tar.gz /tmp/agy.tar.gz
RUN mkdir -p /opt/agy && tar -xzf /tmp/agy.tar.gz -C /opt/agy && chmod 0755 /opt/agy/antigravity

FROM node:24-slim AS runtime
ARG BUILD_VERSION=dev
ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.title="agents-gateway" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}"

# ⚠️ Sem `BASH_CWD`: com ele, o `run_bash` de TODAS as conversas caía na mesma pasta. Sem ele, cada
# conversa ganha a sua, vazia, em /tmp (no k8s, um `emptyDir`).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# O processo roda com este usuário. O shell é nologin porque ninguém deve logar como ele;
# o exec() usa /bin/sh diretamente e não depende do shell de login.
# `/app/data` é o ÚNICO lugar gravável além de /tmp: banco, chave-mestra e logins (o PVC monta aqui).
# Com isso a imagem roda com `readOnlyRootFilesystem`.
# ⚠️ `ca-certificates`: o `node:24-slim` não traz os certificados do sistema. O Node não sente (tem os dele),
# mas o Codex (Rust) e o Antigravity (Go) usam os do sistema — sem eles, todo login e toda conversa por
# assinatura falhava com "error sending request".
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin gateway \
    && mkdir -p /app/data \
    && chown gateway:gateway /app/data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# O frontend não passa pelo tsc, então vai direto para o primeiro caminho que o
# Http.Server procura (dist/infra/http/public).
COPY src/infra/http/public ./dist/infra/http/public
COPY --from=web /web/dist ./web/dist
# O Antigravity no PATH como `agy` (o nome que o gateway procura; `ANTIGRAVITY_BIN` troca).
COPY --from=agy /opt/agy/antigravity /usr/local/bin/agy

USER gateway
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
