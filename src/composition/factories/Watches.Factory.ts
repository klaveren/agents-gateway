import { WatchRunner } from '@application/Watch.Runner'
import { IWatchConversation, WatchService } from '@application/Watch.Service'
import { DELEGATED_BY } from '@domain/models/Delegation.Model'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { drain } from '@infra/http/Drain.State'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteWatchRepository } from '@infra/persistence/Sqlite.WatchRepository'
import { workFolderOf } from '@infra/providers/Agent.Provider'
import { WatchDesk } from '@infra/tools/Watch.Tools'
import { IWatchedConversation, makeWatchExecutor } from '@infra/watch/Watch.Executor'
import { makeAgents } from './Agents.Factory'
import { makeAuth } from './Auth.Factory'
import { makeConversationRepository } from './Conversations.Factory'
import { makeSessionStore } from './Orchestrator.Factory'
import { makeResourceSecrets } from './ResourceSecrets.Factory'

const desk = new WatchDesk(() => makeWatches())
let service: WatchService | undefined
let runner: WatchRunner | undefined
let conversations: IConversationRepository | undefined
type TNotice = (token: string, sessionId: string, text: string) => Promise<'queued' | 'turn' | 'archived'>
let notice: TNotice | undefined

/** O balcão que as ferramentas de vigia recebem (ver `Watch.Tools`): existe antes do serviço, que nasce na primeira chamada. */
export function watchDesk(): WatchDesk {
  return desk
}

/**
 * A conversa de uma vigia. ⚠️ Primeiro a que está na MEMÓRIA: o cabeçalho só é gravado no fim do turno, e a vigia armada
 * no primeiro turno ainda não tem conversa no banco. A gravada responde depois do reinício, e diz se foi arquivada.
 */
async function watchedConversation(sessionId: string): Promise<IWatchedConversation | undefined> {
  conversations ??= makeConversationRepository()
  const stored = await conversations.findSession(sessionId).catch(() => undefined)
  const live = makeSessionStore().get(sessionId)
  if (live) return { agentId: live.agentId, metadata: live.metadata, archived: Boolean(stored?.archivedAt) }
  return stored ? { agentId: stored.agentId, metadata: stored.metadata, archived: Boolean(stored.archivedAt) } : undefined
}

const ownerOf = (metadata: Record<string, unknown> | undefined): string | undefined => {
  const id = (metadata?.owner as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id ? id : undefined
}

/** As vigias das conversas: UM serviço, no mesmo arquivo das conversas (as ferramentas, o relógio e a tela o dividem). */
export function makeWatches(): WatchService {
  if (service) return service
  const configured = process.env.CONVERSATIONS_DB?.trim()
  service = new WatchService({
    repository: new SqliteWatchRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH),
    conversation: async (sessionId): Promise<IWatchConversation | undefined> => {
      const found = await watchedConversation(sessionId)
      if (!found) return undefined
      const ownerId = ownerOf(found.metadata)
      return { agentId: found.agentId, ...(ownerId ? { ownerId } : {}), delegated: Boolean(found.metadata?.[DELEGATED_BY]), archived: found.archived }
    },
    ownerActive: (userId) => Boolean(makeAuth().accounts?.sessionForHook(userId)),
  })
  const executor = makeWatchExecutor({
    conversation: watchedConversation,
    agentProject: (agentId) => {
      const agent = makeAgents().get(agentId)
      return agent ? (agent.projectId ?? null) : undefined
    },
    workFolder: workFolderOf,
    secretEnv: (agentId, sessionId, projectId) => makeResourceSecrets().envFor(agentId, sessionId, projectId).env,
    bash: (command, context) => desk.check(command, context),
    sessionFor: (userId) => makeAuth().accounts?.sessionForHook(userId),
    notice: (token, sessionId, text) => {
      if (!notice) throw new Error('a entrega das vigias ainda não foi ligada')
      return notice(token, sessionId, text)
    },
  })
  service.useCheck(executor.check)
  service.useDelivery(executor.deliver)
  return service
}

/** Liga a entrega: o aviso entra na conversa pelo controller, em nome da conta dona (ver `Controller.Factory`). */
export function useWatchNotice(deliver: TNotice): void {
  notice = deliver
}

/** O relógio das vigias: para enquanto o gateway drena, e o que venceu nesse meio-tempo dispara no processo novo. */
export function makeWatchRunner(): WatchRunner {
  runner ??= new WatchRunner(makeWatches(), () => new Date(), drain.active)
  return runner
}
