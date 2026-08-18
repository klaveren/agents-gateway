import { AgentProvider } from '@infra/providers/AgentProvider'
import { ClaudeAdapter } from '@infra/adapters/ClaudeAdapter'
import { OpenAIAdapter } from '@infra/adapters/OpenAIAdapter'
import { GoogleAdapter } from '@infra/adapters/GoogleAdapter'
import { IAgentAdapter } from '@domain/ports/IAgentAdapter'
import { EProvider } from '@domain/enums/EProvider'
import { McpServerClient } from '@infra/mcp/McpServerClient'

export function makeOrchestrator(): AgentProvider {
  const mcpClient = new McpServerClient(process.env.MCP_SERVER_URL || 'http://localhost:8000/mcp')

  const claudeAdapter = new ClaudeAdapter(mcpClient)
  const openAIAdapter = new OpenAIAdapter(mcpClient)
  const googleAdapter = new GoogleAdapter(mcpClient)

  const adapters = new Map<EProvider, IAgentAdapter>()
  adapters.set(EProvider.CLAUDE, claudeAdapter)
  adapters.set(EProvider.OPENAI, openAIAdapter)
  adapters.set(EProvider.GOOGLE, googleAdapter)

  return new AgentProvider(adapters)
}
