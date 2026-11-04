import { ResourceSecretsService } from '@application/ResourceSecrets.Service'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteResourceSecretRepository } from '@infra/persistence/Sqlite.ResourceSecretRepository'
import { makeAgents } from './Agents.Factory'
import { makeSecretBox } from './Credentials.Factory'
import { makeGuidance } from './Guidance.Factory'
import { makeSecretMasker } from './SecretMask.Factory'

let instance: ResourceSecretsService | undefined

/**
 * As variáveis secretas dos agentes, skills e commands (ver `ResourceSecret.Model`): uma instância só — o que cada conversa
 * carregou vive nela. O cofre é o mesmo das chaves dos providers e das contas dos projetos.
 */
export function makeResourceSecrets(): ResourceSecretsService {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  instance = new ResourceSecretsService({
    store: new SqliteResourceSecretRepository(makeSecretBox(), configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH),
    exists: (scope, scopeId) => (scope === 'agent' ? !!makeAgents().get(scopeId) : makeGuidance().resourceKindOf(scopeId) === scope),
    mask: makeSecretMasker(),
  })
  return instance
}
