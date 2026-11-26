import type { Server } from 'node:http'

/**
 * Quanto uma conexão ociosa fica aberta esperando a próxima requisição.
 *
 * O padrão do Node (5 s) é menor que o de clientes que reaproveitam conexão (o CLI do
 * Antigravity, em Go, guarda a conexão por 90 s): o servidor fecha, o cliente manda a
 * próxima chamada de ferramenta pela conexão morta e recebe `connection reset by peer`.
 */
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 65_000

/** Sempre acima do keep-alive, senão o Node derruba a conexão antes dos cabeçalhos da requisição seguinte. */
export const HEADERS_TIMEOUT_MARGIN_MS = 1_000

export interface ServerTimeouts {
  keepAliveTimeout: number
  headersTimeout: number
}

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim())
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** `HTTP_KEEP_ALIVE_TIMEOUT_MS` e `HTTP_HEADERS_TIMEOUT_MS` ajustam; o dos cabeçalhos nunca fica abaixo do keep-alive. */
export function serverTimeouts(env: NodeJS.ProcessEnv = process.env): ServerTimeouts {
  const keepAliveTimeout = positiveMs(env.HTTP_KEEP_ALIVE_TIMEOUT_MS, DEFAULT_KEEP_ALIVE_TIMEOUT_MS)
  const minimumHeaders = keepAliveTimeout + HEADERS_TIMEOUT_MARGIN_MS
  const headersTimeout = Math.max(positiveMs(env.HTTP_HEADERS_TIMEOUT_MS, minimumHeaders), minimumHeaders)
  return { keepAliveTimeout, headersTimeout }
}

/**
 * Só mexe no tempo de conexão ociosa e de cabeçalhos. `server.timeout` (inatividade do socket)
 * segue 0 e o `requestTimeout` do Node só conta a chegada da requisição, não a resposta:
 * SSE e streams longos não são cortados por nada daqui.
 */
export function applyServerTimeouts(server: Server, env: NodeJS.ProcessEnv = process.env): Server {
  const { keepAliveTimeout, headersTimeout } = serverTimeouts(env)
  server.keepAliveTimeout = keepAliveTimeout
  server.headersTimeout = headersTimeout
  if (server.requestTimeout > 0 && server.requestTimeout < headersTimeout) server.requestTimeout = headersTimeout
  return server
}
