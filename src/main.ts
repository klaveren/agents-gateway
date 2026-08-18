import dotenv from 'dotenv'
dotenv.config({ override: true })
import { HttpServer } from '@infra/http/Server'
import { McpServerClient } from '@infra/mcp/McpServerClient'

async function bootstrap() {
  // 1. Instanciar MCP
  const mcpClient = new McpServerClient('http://localhost:8000/mcp')
  try {
    await mcpClient.connect()
  } catch (e: any) {
    console.warn(`[Aviso] Falha ao conectar no MCP Server: ${e.message}. Continuando sem ele...`)
  }

  // 2. Instanciar HTTP Server (Infra)
  const server = new HttpServer()

  // 3. Iniciar
  const port = parseInt(process.env.PORT || '3000', 10)
  server.start(port)
}

bootstrap().catch(console.error)
