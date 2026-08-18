export type TAgentEventType = 'session.created' | 'message.started' | 'text.delta' | 'tool.started' | 'tool.result' | 'message.completed' | 'session.completed' | 'error'

export type IAgentEvent =
  | { type: 'session.created'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'message.started'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'text.delta'; sessionId: string; timestamp: Date; payload: { text: string } }
  | { type: 'tool.started'; sessionId: string; timestamp: Date; payload: { tool: string; args: Record<string, unknown> } }
  | { type: 'tool.result'; sessionId: string; timestamp: Date; payload: { tool: string; result: unknown } }
  | { type: 'message.completed'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'session.completed'; sessionId: string; timestamp: Date; payload?: never }
  | { type: 'error'; sessionId: string; timestamp: Date; payload: string | { message: string } | unknown }
