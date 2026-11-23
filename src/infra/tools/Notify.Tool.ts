import { NOTIFY_TOOL, PERSON_MESSAGE_LEVELS } from '@domain/models/PersonMessage.Model'
import type { ILocalTool, IToolResult } from './Tool.Types'

/** O que a ferramenta usa: mandar (o serviço) e o turno em curso da conversa (o ponto do contexto). */
export interface INotifyDesk {
  send(input: { sessionId: string; agentId: string; to: string; title?: string; body: string; level?: string; turn?: number; replyTo?: string }): Promise<string[]>
  turnOf?(sessionId: string): number | undefined
}

/**
 * 💬 `notify`: o agente escreve para uma pessoa — e ela responde da tela Mensagens, sem voltar à conversa; a resposta entra
 * aqui como mensagem dela. Para quando o agente PRECISA de alguém (uma decisão, um acesso, um "pronto") ou para avisar o
 * que terminou num agendamento ou hook, onde ninguém está olhando.
 */
export function notifyTool(desk: INotifyDesk): ILocalTool {
  return {
    origin: 'local',
    name: NOTIFY_TOOL,
    description:
      'Sends a message to a person, in their Messages inbox (and phone, when they enabled it): use it when you need someone (a decision, an access, a confirmation) or to report what finished when nobody is watching (a schedule, a hook). ' +
      'They can reply right there: the reply comes back into this conversation as a message from them. to: "admins" (the administrators of this project), "owner" (the person who owns this conversation) or the name or e-mail of a person of the project. ' +
      'Write a short title and a self-contained message: say what you need and why, so they can answer without opening the conversation. ' +
      'Answering a request the person replied to (the reply names it: "pedido m_…")? Pass replyTo with that id and level info: your answer stays in that request\'s item. ' +
      'Not for delegated conversations: when another agent delegated to you, report to it in your reply instead.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '"admins", "owner", or the name or e-mail of a person of this project' },
        title: { type: 'string', description: 'A short subject' },
        message: { type: 'string', description: 'The message (Markdown): what you need or what happened, self-contained' },
        level: { type: 'string', enum: [...PERSON_MESSAGE_LEVELS], description: 'info (default), attention (needs an answer) or urgent' },
        replyTo: { type: 'string', description: 'The id (m_…) of the request you are answering; your message (level info) goes into its item' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      const sessionId = context?.sessionId
      if (!sessionId || !context?.agentId) return { status: 'error', result: `${NOTIFY_TOOL} only works inside a conversation.` }
      try {
        const names = await desk.send({
          sessionId,
          agentId: context.agentId,
          to: typeof args.to === 'string' ? args.to : '',
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
          body: typeof args.message === 'string' ? args.message : '',
          ...(typeof args.level === 'string' ? { level: args.level } : {}),
          ...(typeof args.replyTo === 'string' && args.replyTo.trim() ? { replyTo: args.replyTo.trim() } : {}),
          ...(desk.turnOf?.(sessionId) !== undefined ? { turn: desk.turnOf!(sessionId) } : {}),
        })
        return { status: 'success', result: `Sent to ${names.join(', ')}. Their reply, if any, will arrive in this conversation as a message from them.` }
      } catch (error: unknown) {
        return { status: 'error', result: `Could not send: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}
