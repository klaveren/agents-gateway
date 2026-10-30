import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SecretMasker } from '@infra/secrets/Secret.Masker'
import { makeCredentials, makeSecretBox } from './Credentials.Factory'
import { makeProviders } from './Providers.Factory'

let instance: SecretMasker | undefined

/** A máscara de segredos: uma instância só (os segredos das contas por conversa e os acertos vivem nela). */
export function makeSecretMasker(): SecretMasker {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  instance = new SecretMasker(makeSecretBox(), configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH, () =>
    makeProviders()
      .list()
      .map((provider) => ({ value: makeCredentials().get(provider.id) ?? '', label: `chave ${provider.id}` }))
      .filter((secret) => secret.value),
  )
  return instance
}
