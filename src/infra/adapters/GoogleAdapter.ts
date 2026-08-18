import { IAgentAdapter } from '@domain/ports/IAgentAdapter'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput'
import { IAgentSession } from '@domain/models/AgentSession'
import { IAgentEvent } from '@domain/models/AgentEvent'
import { EProvider } from '@domain/enums/EProvider'
import { IAgent } from '@domain/models/Agent'
import { IMessageInput } from '@domain/models/MessageInput'
import { McpServerClient } from '@infra/mcp/McpServerClient'
import { GoogleGenerativeAI, Content, Part, FunctionDeclaration, Tool } from '@google/generative-ai'

export class GoogleAdapter implements IAgentAdapter {
  private client: GoogleGenerativeAI
  private history: Map<string, Content[]> = new Map()
  private sessionModels: Map<string, string> = new Map()
  private sessionReasoning: Map<string, string> = new Map()

  constructor(private mcpClient: McpServerClient) {
    this.client = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || 'AIzaSy-dummy')
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const sessionId = `google-sess-${Date.now()}`

    let prompt = agent.systemPrompt
    if (input.language) {
      prompt += `\n\nIMPORTANT: Please reply exclusively in ${input.language}.`
    }

    const initialHistory: Content[] = [{ role: 'user', parts: [{ text: prompt }] }]
    this.history.set(sessionId, initialHistory)
    this.sessionModels.set(sessionId, input.model || 'gemini-3.7-flash')
    this.sessionReasoning.set(sessionId, input.reasoning || 'medium')

    return {
      id: sessionId,
      provider: EProvider.GOOGLE,
      createdAt: new Date(),
      metadata: input.metadata,
    }
  }

  async *sendMessage(agent: IAgent, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    const messages = this.history.get(sessionId) || []

    const parts: Part[] = [{ text: input.text }]
    for (const file of input.files || []) {
      parts.push({
        inlineData: {
          data: file.data,
          mimeType: file.mimeType,
        },
      })
    }

    const currentMessage: Content = { role: 'user', parts }

    // Convert MCP tools to Gemini Function Declarations
    const allMcpTools = await this.mcpClient.getTools()
    const agentTools = allMcpTools.filter((t) => agent.allowedTools.includes(t.name))

    const functionDeclarations: FunctionDeclaration[] = agentTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }))

    const tools: Tool[] = functionDeclarations.length > 0 ? [{ functionDeclarations }] : []

    yield { type: 'message.started', sessionId, timestamp: new Date() }

    try {
      const modelToUse = this.sessionModels.get(sessionId) || 'gemini-3.7-flash'
      const reasoning = this.sessionReasoning.get(sessionId)

      const modelConfig: any = {
        model: modelToUse,
        systemInstruction: agent.systemPrompt,
        tools,
      }

      // Removed thinking_level injection to avoid "Unknown name thinking_level at generation_config" 400 Error.
      // Gemini dynamic thinking applies automatically in this version of the SDK.

      const model = this.client.getGenerativeModel(modelConfig)

      const chat = model.startChat({
        history: this.history.get(sessionId) || [],
      })

      let currentInput: any = currentMessage
      let shouldContinue = true
      let isFirstLoop = true

      while (shouldContinue) {
        shouldContinue = false

        // Push the input to our messages array manually
        if (isFirstLoop) {
          messages.push(currentMessage)
          isFirstLoop = false
        } else {
          // It's a function response, we push it as 'user' role
          messages.push({ role: 'user', parts: currentInput })
        }

        const result = await model.generateContentStream({ contents: messages })

        let fullResponse = ''
        let functionCalls: any[] = []
        let modelParts: any[] = []

        for await (const chunk of result.stream) {
          // Extrair diretamente as parts para não perder o thoughtSignature ou outros metadados internos
          if (chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content && chunk.candidates[0].content.parts) {
            const rawParts = chunk.candidates[0].content.parts

            for (const part of rawParts) {
              if (part.functionCall) {
                functionCalls.push(part.functionCall)
                modelParts.push(part) // push the raw part containing thoughtSignature
              } else if (part.text) {
                fullResponse += part.text
              } else {
                modelParts.push(part) // any other parts like thoughtSignature alone
              }
            }
          }

          // Yield text chunks
          try {
            const text = chunk.text()
            if (text) {
              yield {
                type: 'text.delta',
                sessionId,
                payload: { text },
                timestamp: new Date(),
              }
            }
          } catch (e) {
            // chunk.text() throws if it's a function call chunk with no text
          }
        }

        if (fullResponse) {
          modelParts.unshift({ text: fullResponse })
        }

        if (modelParts.length > 0) {
          messages.push({ role: 'model', parts: modelParts })
        }

        if (functionCalls.length > 0) {
          const fnResponses: any[] = []

          for (const call of functionCalls) {
            yield {
              type: 'tool.started',
              sessionId,
              payload: { tool: call.name, args: call.args },
              timestamp: new Date(),
            }

            const toolResult = await this.mcpClient.invokeTool(call.name, call.args)

            yield {
              type: 'tool.result',
              sessionId,
              payload: { tool: call.name, result: toolResult },
              timestamp: new Date(),
            }

            fnResponses.push({
              functionResponse: {
                name: call.name,
                response: { result: toolResult },
              },
            })
          }

          currentInput = fnResponses
          shouldContinue = true // Feed results back to model
        }
      }

      this.history.set(sessionId, messages)

      yield { type: 'message.completed', sessionId, timestamp: new Date() }
    } catch (error: any) {
      console.error('[Google] Error:', error)
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
    console.log(`Cancelled Google session ${sessionId}`)
  }
}
