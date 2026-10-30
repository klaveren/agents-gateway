import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IAgent } from '@domain/models/Agent.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'

export interface IAgentAdapter {
  createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession>
  /**
   * ⚖️ `context` vem do PROVIDER. O adapter não busca credencial em lugar nenhum — recebe a que
   * vale para esta chamada. É o que impede um adapter novo de esquecer de propagá-la, que foi
   * exatamente o que aconteceu quando cada um buscava por conta própria.
   */
  sendMessage(agent: IAgent, sessionId: string, input: IMessageInput, context: IExecutionContext): AsyncIterable<IAgentEvent>
  cancel(sessionId: string): Promise<void>
  /**
   * O estado do SDK que vale guardar com a conversa (o id da sessão do CLI do Claude), para a retomada continuar com
   * a MEMÓRIA dele, e não só com a transcrição. `undefined` = nada a guardar ainda. Opcional: o adapter que não tem
   * fica na transcrição.
   */
  exportNative?(sessionId: string): unknown
  /** Planta o estado guardado na sessão reaberta. `false` = não serve mais (o arquivo do SDK sumiu): vale a transcrição. */
  restoreNative?(sessionId: string, data: unknown): boolean
  /** O SDK compacta o contexto sozinho (Claude Agent SDK, Codex, Antigravity): o gateway não compacta (ver `Compaction.Policy`). */
  readonly compactsItself?: boolean
}
