import dotenv from 'dotenv'
dotenv.config({ override: true })

import { setTracingDisabled } from '@openai/agents'
import { makeAuth } from '@composition/factories/Auth.Factory'
import {
  makeAuthController,
  makeController,
  makeMcpProxyController,
  makePackagesController,
  makeMcpServersController,
  makeProvidersController,
  makeUsageController,
} from '@composition/factories/Controller.Factory'
import { cleanupOrphans } from '@infra/sandbox/Docker.Sandbox'
import { addToolsToPath } from '@infra/packages/Micromamba.Adapter'
import { bootIssues, bootWarnings } from '@infra/http/Boot.Checks'
import { clearSessionWorkspaces } from '@infra/adapters/support/Subscription.Workspace'
import { makeTools } from '@composition/factories/Tools.Factory'
import { warnIfProofDisabled } from '@infra/http/Caller.Proof'
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
  const issues = bootIssues()
  if (issues.length) {
    for (const issue of issues) console.error(`[security] ${issue}`)
    process.exit(1)
  }
  for (const warning of bootWarnings()) console.warn(`[security] ${warning}`)
  bridgeGoogleApiKey()
  // As ferramentas da guia Pacotes (`<dados>/tools/bin`) no PATH de tudo que este processo lança.
  addToolsToPath()

  // Conecta os servidores MCP cadastrados sem esperar: nenhum `connect()` lança, e servidor fora do ar
  // tenta de novo sozinho (com backoff) na primeira vez que uma ferramenta dele for pedida.
  void makeTools().mcp.connectAll()
  // Contêineres e redes de MCP que um processo anterior deixou (queda, reinício) saem antes de tudo.
  void cleanupOrphans()
  // Os diretórios vazios das conversas de assinatura de um processo anterior.
  clearSessionWorkspaces()

  // Com contas locais há prova (a do token deste gateway); o aviso fica para quem roda sem banco.
  warnIfProofDisabled(makeAuth().proof)
  // Sem nenhuma conta: o código que a tela de setup pede. Só quem lê o log do servidor o tem.
  const accounts = makeAuth().accounts
  if (accounts?.setupRequired()) console.log(`[setup] Nenhuma conta ainda. Código de instalação do primeiro admin: ${accounts.setupCode}`)

  const controller = makeController()
  const server = new HttpServer(
    controller,
    makeAuthController(),
    makeProvidersController(),
    makeUsageController(controller.conversations),
    makeMcpServersController(),
    makeMcpProxyController(),
    makePackagesController(),
  )
  server.start(Number.parseInt(process.env.PORT || '3000', 10))
}

bootstrap().catch(console.error)
