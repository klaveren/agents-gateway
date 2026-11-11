import type { ILedgerContextDetail, ILedgerIndex, ILedgerSearchResult, ILedgerWriteResult, LedgerService } from '@application/Ledger.Service'
import type { ProjectConnectionService } from '@application/ProjectConnection.Service'
import type { TLedgerDesk } from '@infra/tools/Ledger.Tools'

/** As conexões, registradas pela fábrica delas (sem volta entre as fábricas): ausentes, todo ledger é o daqui. */
let connections: ProjectConnectionService | undefined

export function useConnectionsForLedger(service: ProjectConnectionService): void {
  connections = service
}

/**
 * 🔌 O LEDGER CERTO PARA CADA AGENTE: o do agente de projeto CONECTADO mora na origem (um ledger só, vale para todos que
 * usam o projeto); o resto, o daqui. Quem existe e quem lê quem segue o catálogo daqui (o espelho da origem).
 */
export function connectedLedgerDesk(local: LedgerService, projectOf: (agentId: string) => string | undefined): TLedgerDesk {
  const remote = (agentId: string) => {
    const projectId = projectOf(agentId)
    return projectId && connections?.get(projectId) ? { service: connections, projectId } : undefined
  }
  return {
    requireAgent: (agentId) => local.requireAgent(agentId),
    canRead: (reader, target) => local.canRead(reader, target),
    index: async (agentId) => {
      const via = remote(agentId)
      return via ? (await via.service.ledgerRead<{ index: ILedgerIndex }>(via.projectId, agentId, 'index')).index : local.index(agentId)
    },
    context: (agentId, topic) => {
      const via = remote(agentId)
      return via ? via.service.ledgerRead<ILedgerContextDetail>(via.projectId, agentId, 'context', topic) : local.context(agentId, topic)
    },
    search: (agentId, query) => {
      const via = remote(agentId)
      return via ? via.service.ledgerRead<ILedgerSearchResult>(via.projectId, agentId, 'search', query) : local.search(agentId, query)
    },
    write: (agentId, change, by) => {
      const via = remote(agentId)
      const conversationId = by.kind === 'agent' ? by.conversationId : undefined
      return via ? via.service.ledgerWrite<ILedgerWriteResult>(via.projectId, agentId, change, conversationId) : local.write(agentId, change, by)
    },
  }
}

/** A seção do ledger no prompt: a da origem para o agente conectado (a última lida), a daqui para o resto. */
export function connectedLedgerPrompt(local: LedgerService, projectOf: (agentId: string) => string | undefined, agentId: string): string | undefined {
  const projectId = projectOf(agentId)
  if (projectId && connections?.get(projectId)) return connections.ledgerPrompt(projectId, agentId)
  return local.promptSection(agentId)
}
