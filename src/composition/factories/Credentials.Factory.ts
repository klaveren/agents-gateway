import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ICredentialStore } from '@domain/ports/CredentialStore.Port'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { masterKey, SecretBox } from '@infra/secrets/Aes.SecretBox'

let instance: ICredentialStore | undefined

/**
 * As chaves de API dos providers.
 *
 * ⚠️ UMA INSTÂNCIA SÓ: os adapters, o classificador e a tela precisam ver a MESMA chave — com duas,
 * a tela salvaria numa e o modelo continuaria chamando com a outra.
 *
 * A chave-mestra fica em `secrets.key`, AO LADO do banco (nunca dentro dele), ou em `SECRETS_KEY`.
 */
export function makeCredentials(): ICredentialStore {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  instance = new SqliteCredentialStore(makeSecretBox(), configured === 'off' ? undefined : configured || DEFAULT_DB_PATH)
  return instance
}

let box: SecretBox | undefined

/** O cofre (a chave-mestra): o mesmo das chaves dos providers e das contas dos projetos. */
export function makeSecretBox(): SecretBox {
  if (box) return box
  const configured = process.env.CONVERSATIONS_DB?.trim()
  const dbPath = configured || DEFAULT_DB_PATH
  // Sem arquivo de banco (`off`, ou `:memory:` dos testes), nada fica guardado: uma chave-mestra de
  // passagem basta, e nenhum `secrets.key` é deixado para trás.
  const ephemeral = configured === 'off' || dbPath === ':memory:'
  const key = ephemeral && !process.env.SECRETS_KEY ? randomBytes(32) : masterKey(process.env.SECRETS_KEY_FILE?.trim() || join(dirname(dbPath), 'secrets.key'))
  box = new SecretBox(key)
  return box
}
