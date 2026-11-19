import { PersonMessagesService } from '@application/PersonMessages.Service'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqlitePersonMessageRepository } from '@infra/persistence/Sqlite.PersonMessageRepository'
import { makeAuth } from './Auth.Factory'
import { makeConversationRepository } from './Conversations.Factory'
import { makeProjects } from './Projects.Factory'

let service: PersonMessagesService | undefined
let conversations: ReturnType<typeof makeConversationRepository> | undefined

/** 💬 As mensagens dos agentes para as pessoas (ver `PersonMessage.Model`): uma instância, no mesmo arquivo das conversas. */
export function makePersonMessages(): PersonMessagesService {
  if (service) return service
  const configured = process.env.CONVERSATIONS_DB?.trim()
  const path = configured === 'off' || configured === ':memory:' ? ':memory:' : configured || DEFAULT_DB_PATH
  service = new PersonMessagesService({
    repository: new SqlitePersonMessageRepository(path),
    conversation: (sessionId) => {
      conversations ??= makeConversationRepository()
      return conversationOf(conversations, sessionId)
    },
    members: (projectId) => {
      try {
        return makeProjects().members(projectId)
      } catch {
        return []
      }
    },
    accounts: () => makeAuth().accounts?.list() ?? [],
  })
  return service
}

/** O dono e o projeto de uma conversa, para o serviço de mensagens. */
export async function conversationOf(repository: Pick<ReturnType<typeof makeConversationRepository>, 'findSession'>, sessionId: string) {
  const session = await repository.findSession(sessionId).catch(() => undefined)
  if (!session) return undefined
  const owner = (session.metadata?.owner as { id?: unknown } | undefined)?.id
  const project = session.metadata?.project
  return { ...(typeof owner === 'string' ? { ownerId: owner } : {}), ...(typeof project === 'string' ? { projectId: project } : {}) }
}
