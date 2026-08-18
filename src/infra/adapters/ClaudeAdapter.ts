import { IAgentAdapter } from '@domain/ports/IAgentAdapter'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput'
import { IAgentSession } from '@domain/models/AgentSession'
import { IAgentEvent } from '@domain/models/AgentEvent'
import { EProvider } from '@domain/enums/EProvider'
import { IAgent } from '@domain/models/Agent'
import { IMessageInput } from '@domain/models/MessageInput'
import { McpServerClient } from '@infra/mcp/McpServerClient'
import Anthropic from '@anthropic-ai/sdk'

export class ClaudeAdapter implements IAgentAdapter {
  private client: Anthropic
  private history: Map<string, Anthropic.MessageParam[]> = new Map()
  private sessionModels: Map<string, string> = new Map()
  private sessionReasoning: Map<string, string> = new Map()
  private sessionLanguage: Map<string, string> = new Map()

  constructor(private mcpClient: McpServerClient) {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || 'sk-ant-dummy',
    })
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const sessionId = `claude-sess-${Date.now()}`
    this.history.set(sessionId, []) // Keep history clean, we will pass system prompt directly
    this.sessionModels.set(sessionId, input.model || 'claude-sonnet-5')
    this.sessionReasoning.set(sessionId, input.reasoning || 'high')
    if (input.language) {
      this.sessionLanguage.set(sessionId, input.language)
    }

    return {
      id: sessionId,
      provider: EProvider.CLAUDE,
      createdAt: new Date(),
      metadata: input.metadata,
    }
  }

  async *sendMessage(agent: IAgent, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    const messages = this.history.get(sessionId) || []

    const content: any[] = [{ type: 'text', text: input.text }]
    for (const file of input.files || []) {
      if (file.mimeType.startsWith('image/')) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: file.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: file.data,
          },
        })
      } else if (file.mimeType === 'application/pdf') {
        content.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: file.mimeType as 'application/pdf',
            data: file.data,
          },
        })
      }
    }

    messages.push({ role: 'user', content })

    // Convert MCP tools to Anthropic Tools
    const allMcpTools = await this.mcpClient.getTools()
    const agentTools = allMcpTools.filter((t) => agent.allowedTools.includes(t.name))

    const tools: Anthropic.Tool[] = agentTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as any,
    }))

    yield { type: 'message.started', sessionId, timestamp: new Date() }

    try {
      let shouldContinue = true

      while (shouldContinue) {
        shouldContinue = false

        const modelToUse = this.sessionModels.get(sessionId) || 'claude-sonnet-5'
        let systemPrompt = agent.systemPrompt
        const lang = this.sessionLanguage.get(sessionId)
        if (lang) {
          systemPrompt += `\n\nIMPORTANT: Please reply exclusively in ${lang}.`
        }

        const requestConfig: any = {
          model: modelToUse as any,
          system: systemPrompt,
          max_tokens: 1024,
          messages: messages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
        }

        const reasoning = this.sessionReasoning.get(sessionId)
        if (reasoning) {
          requestConfig.output_config = { effort: reasoning }
        }

        const stream: any = await this.client.messages.create(requestConfig)

        let fullResponse = ''
        let toolUses: any[] = []
        let currentToolUse: any = null

        for await (const chunk of stream) {
          if (chunk.type === 'content_block_start') {
            if (chunk.content_block.type === 'tool_use') {
              currentToolUse = {
                id: chunk.content_block.id,
                name: chunk.content_block.name,
                inputJSON: '',
              }
              toolUses.push(currentToolUse)
            }
          } else if (chunk.type === 'content_block_delta') {
            if (chunk.delta.type === 'text_delta') {
              const text = chunk.delta.text
              fullResponse += text
              yield {
                type: 'text.delta',
                sessionId,
                payload: { text },
                timestamp: new Date(),
              }
            } else if (chunk.delta.type === 'input_json_delta' && currentToolUse) {
              currentToolUse.inputJSON += chunk.delta.partial_json
            }
          }
        }

        const content: any[] = []
        if (fullResponse) content.push({ type: 'text', text: fullResponse })
        for (const tu of toolUses) {
          content.push({
            type: 'tool_use',
            id: tu.id,
            name: tu.name,
            input: JSON.parse(tu.inputJSON || '{}'),
          })
        }

        if (content.length > 0) {
          messages.push({ role: 'assistant', content })
        } else {
          // Anthropic requires non-empty content
          messages.push({ role: 'assistant', content: [{ type: 'text', text: '...' }] })
        }

        if (toolUses.length > 0) {
          const toolResultContent: any[] = []
          for (const tu of toolUses) {
            let args
            try {
              args = JSON.parse(tu.inputJSON || '{}')
            } catch (e) {
              args = {}
            }

            yield {
              type: 'tool.started',
              sessionId,
              payload: { tool: tu.name, args },
              timestamp: new Date(),
            }

            const toolResult = await this.mcpClient.invokeTool(tu.name, args)

            yield {
              type: 'tool.result',
              sessionId,
              payload: { tool: tu.name, result: toolResult },
              timestamp: new Date(),
            }

            toolResultContent.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            })
          }

          messages.push({ role: 'user', content: toolResultContent })
          shouldContinue = true
        }
      }

      this.history.set(sessionId, messages)
      yield { type: 'message.completed', sessionId, timestamp: new Date() }
    } catch (error: any) {
      console.error('[Claude] Error:', error)
      yield {
        type: 'error',
        sessionId,
        payload: { error: error.message },
        timestamp: new Date(),
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    // Anthropic API doesn't easily let us abort an active stream without AbortController
    // For now we just clear the history to stop tracking.
    this.history.delete(sessionId)
    console.log(`Cancelled Claude session ${sessionId}`)
  }
}
