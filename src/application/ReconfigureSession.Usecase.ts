import { InvalidSessionChangeError } from '@domain/errors/Domain.Error'
import { ISession } from '@domain/models/Session.Model'
import { IAgentProvider, ISessionChange } from '@domain/ports/AgentProvider.Port'

export class ReconfigureSessionUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  execute(sessionId: string, change: ISessionChange): ISession {
    return this.agentProvider.reconfigure(sessionId, change)
  }

  /** Compactar à mão: vale a partir do próximo turno, como a troca de modelo. */
  compact(sessionId: string): ISession {
    if (!this.agentProvider.requestCompaction) throw new InvalidSessionChangeError([{ field: 'session', message: 'compaction is not available' }])
    return this.agentProvider.requestCompaction(sessionId)
  }
}
