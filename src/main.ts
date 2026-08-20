import dotenv from 'dotenv'
dotenv.config({ override: true })

import { setTracingDisabled } from '@openai/agents'
import { makeTools } from '@composition/factories/Tools.Factory'
import { HttpServer } from '@infra/http/Http.Server'

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

  // `connect()` nunca lança: sem MCP server no ar o gateway segue com o toolset local, e
  // tenta de novo sozinho (com backoff) na primeira vez que alguma tool precisar dele.
  await makeTools().mcp.connect()

  const server = new HttpServer()
  server.start(Number.parseInt(process.env.PORT || '3000', 10))
}

bootstrap().catch(console.error)
