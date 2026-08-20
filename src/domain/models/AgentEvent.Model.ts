export type TAgentEventType =
  | 'session.created'
  | 'message.started'
  | 'text.delta'
  | 'reasoning.delta'
  | 'tool.started'
  | 'tool.result'
  | 'tool.error'
  | 'usage'
  | 'warning'
  | 'message.completed'
  | 'message.aborted'
  | 'session.completed'
  | 'error'

export interface IUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

export type IAgentEvent =
  | { type: 'session.created'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'message.started'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'text.delta'; sessionId: string; timestamp: Date; payload: { text: string } }
  | { type: 'reasoning.delta'; sessionId: string; timestamp: Date; payload: { text: string } }
  | { type: 'tool.started'; sessionId: string; timestamp: Date; payload: { tool: string; args: Record<string, unknown> } }
  | { type: 'tool.result'; sessionId: string; timestamp: Date; payload: { tool: string; result: unknown } }
  | { type: 'tool.error'; sessionId: string; timestamp: Date; payload: { tool: string; message: string } }
  | { type: 'usage'; sessionId: string; timestamp: Date; payload: IUsage }
  | { type: 'warning'; sessionId: string; timestamp: Date; payload: { message: string } }
  | { type: 'message.completed'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'message.aborted'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'session.completed'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'error'; sessionId: string; timestamp: Date; payload: { message: string } }
