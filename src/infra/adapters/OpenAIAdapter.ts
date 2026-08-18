import { IAgentAdapter } from '@domain/ports/IAgentAdapter'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput'
import { IAgentSession } from '@domain/models/AgentSession'
import { IAgentEvent } from '@domain/models/AgentEvent'
import { EProvider } from '@domain/enums/EProvider'
import { IAgent } from '@domain/models/Agent'
import { IMessageInput } from '@domain/models/MessageInput'
import { McpServerClient } from '@infra/mcp/McpServerClient'
import OpenAI from 'openai'

export class OpenAIAdapter implements IAgentAdapter {
  private client: OpenAI
  private history: Map<string, OpenAI.Chat.ChatCompletionMessageParam[]> = new Map()
  private sessionModels: Map<string, string> = new Map()
  private sessionReasoning: Map<string, string> = new Map()

  constructor(private mcpClient: McpServerClient) {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'sk-dummy',
    })
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const sessionId = `openai-sess-${Date.now()}`

    let prompt = agent.systemPrompt
    if (input.language) {
      prompt += `\n\nIMPORTANT: Please reply exclusively in ${input.language}.`
    }

    const initialMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: prompt }]
    this.history.set(sessionId, initialMessages)
    this.sessionModels.set(sessionId, input.model || 'gpt-5.6-sol')
    this.sessionReasoning.set(sessionId, input.reasoning || 'none')

    return {
      id: sessionId,
      provider: EProvider.OPENAI,
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
          type: 'image_url',
          image_url: { url: `data:${file.mimeType};base64,${file.data}` },
        })
      }
    }

    messages.push({ role: 'user', content })

    // Convert MCP tools to OpenAI Tools
    const allMcpTools = await this.mcpClient.getTools()
    const agentTools = allMcpTools.filter((t) => agent.allowedTools.includes(t.name))

    const tools: OpenAI.Chat.ChatCompletionTool[] = agentTools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as any,
      },
    }))

    yield { type: 'message.started', sessionId, timestamp: new Date() }

    try {
      let shouldContinue = true

      while (shouldContinue) {
        shouldContinue = false

        const modelToUse = this.sessionModels.get(sessionId) || 'gpt-5.6-sol'

        const requestConfig: any = {
          model: modelToUse as any,
          messages: messages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
        }

        const reasoning = this.sessionReasoning.get(sessionId) || 'none'
        if (reasoning !== 'none' || modelToUse.includes('gpt-5.6') || modelToUse.includes('o3') || modelToUse.includes('o4')) {
          requestConfig.reasoning_effort = reasoning
        }

        const stream = (await this.client.chat.completions.create(requestConfig)) as any

        let fullResponse = ''
        let toolCalls = new Map<number, any>()

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta

          if (delta?.content) {
            fullResponse += delta.content
            yield {
              type: 'text.delta',
              sessionId,
              payload: { text: delta.content },
              timestamp: new Date(),
            }
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, {
                  id: tc.id || '',
                  type: 'function',
                  function: { name: tc.function?.name || '', arguments: '' },
                })
              }
              const currentTc = toolCalls.get(idx)!
              if (tc.id) currentTc.id = tc.id
              if (tc.function?.name) currentTc.function.name = tc.function.name
              if (tc.function?.arguments) currentTc.function.arguments += tc.function.arguments
            }
          }
        }

        const messageToPush: OpenAI.Chat.ChatCompletionMessageParam = {
          role: 'assistant',
          content: fullResponse || null,
        }

        if (toolCalls.size > 0) {
          messageToPush.tool_calls = Array.from(toolCalls.values())
        }

        messages.push(messageToPush)

        if (toolCalls.size > 0) {
          for (const [_, call] of toolCalls) {
            let args
            try {
              args = JSON.parse(call.function.arguments)
            } catch (e) {
              args = {}
            }

            yield {
              type: 'tool.started',
              sessionId,
              payload: { tool: call.function.name, args },
              timestamp: new Date(),
            }

            const toolResult = await this.mcpClient.invokeTool(call.function.name, args)

            yield {
              type: 'tool.result',
              sessionId,
              payload: { tool: call.function.name, result: toolResult },
              timestamp: new Date(),
            }

            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            })
          }
          shouldContinue = true
        }
      }

      this.history.set(sessionId, messages)
      yield { type: 'message.completed', sessionId, timestamp: new Date() }
    } catch (error: any) {
      console.error('[OpenAI] Error:', error)
      yield {
        type: 'error',
        sessionId,
        payload: { error: error.message },
        timestamp: new Date(),
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.history.delete(sessionId)
    console.log(`Cancelled OpenAI session ${sessionId}`)
  }
}
