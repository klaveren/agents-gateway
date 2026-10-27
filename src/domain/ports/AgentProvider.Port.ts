import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IConversationSession, IConversationTurn } from '@domain/models/Conversation.Model'
import { ISession } from '@domain/models/Session.Model'

/** `reasoning: null` volta ao padrão do provider; campo ausente não muda. */
export interface ISessionChange {
  /** Outro provider do agente: a conversa segue nele, com a transcrição (ver `Handoff.Policy`). */
  provider?: string
  model?: string
  reasoning?: string | null
}

/** O que a retomada precisa: a conversa gravada e os turnos dela (ver `AgentProvider.resume`). */
export interface IResumeInput {
  session: IConversationSession
  turns: readonly IConversationTurn[]
  /** Quem retoma é administrador provado (agente `adminOnly`). */
  adminAccess?: boolean
}

export interface IAgentProvider {
  createSession(input: ICreateSessionInput): Promise<IAgentSession>
  sendMessage(sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent>
  cancel(sessionId: string): Promise<void>
  dispose(sessionId: string): Promise<void>
  describe(sessionId: string): ISession
  /** Troca o modelo e/ou o nível de raciocínio de uma sessão viva; vale a partir do próximo turno. */
  reconfigure(sessionId: string, change: ISessionChange): ISession
  list(): ISession[]
  /**
   * Reabre a sessão de uma conversa gravada que já não está na memória (expirou, ou o gateway reiniciou), com o MESMO
   * id e a transcrição para o próximo turno. Sem nada a fazer quando ela ainda está viva.
   */
  resume?(input: IResumeInput): Promise<void>
}
