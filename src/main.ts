import dotenv from 'dotenv'
dotenv.config({ override: true })

import { setTracingDisabled } from '@openai/agents'
import { HttpServer } from '@infra/http/Http.Server'
import { McpServerClient } from '@infra/mcp/McpServer.Client'

/**
 * Precisa acontecer antes de qualquer agente ser construído: só de importar o
 * `@openai/agents` o exportador de tracing da OpenAI é registrado, e ele envia prompts,
 * entradas e saídas de tool para api.openai.com autenticando com a OPENAI_API_KEY.
 */
setTracingDisabled(true)

/**
 * O `@google/adk` lê `GOOGLE_GENAI_API_KEY` ou `GEMINI_API_KEY` — nunca `GOOGLE_API_KEY`,
 * que é o nome usado pelo SDK legado da lane chat. Sem esta ponte, a lane agent do Gemini
 * falha na primeira chamada com "API key must be provided".
 */
function bridgeGoogleApiKey(): void {
  if (process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY) return
  if (!process.env.GOOGLE_API_KEY) return

  process.env.GOOGLE_GENAI_API_KEY = process.env.GOOGLE_API_KEY
  console.log('[config] GOOGLE_GENAI_API_KEY ausente; usando GOOGLE_API_KEY para o @google/adk.')
}

async function bootstrap() {
  bridgeGoogleApiKey()

  const mcpClient = new McpServerClient(process.env.MCP_SERVER_URL || 'http://localhost:8000/mcp')
  try {
    await mcpClient.connect()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[Aviso] Falha ao conectar no MCP Server: ${message}. Continuando sem ele...`)
  }

  const server = new HttpServer()
  server.start(Number.parseInt(process.env.PORT || '3000', 10))
}

bootstrap().catch(console.error)
