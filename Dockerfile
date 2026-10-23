# syntax=docker/dockerfile:1

# A deny-list do run_bash barra o comando catastrófico, mas não é contenção: um modelo com
# shell continua rodando como o seu usuário, no seu $HOME. Este container é a contenção.

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

USER gateway
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
