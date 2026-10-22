import { ProvidersService } from '@application/Providers.Service'
import { SqliteProviderRepository } from '@infra/persistence/Sqlite.ProviderRepository'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { makeCredentials } from './Credentials.Factory'

let instance: ProvidersService | undefined

/**
 * Os providers e a conexão de cada um. ⚠️ UMA INSTÂNCIA SÓ — os adapters, o provider de sessões, o
 * classificador e a tela precisam ver o MESMO provider e a MESMA chave.
 */
export function makeProviders(): ProvidersService {
  if (instance) return instance

  const configured = process.env.CONVERSATIONS_DB?.trim()
  const repository = new SqliteProviderRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH)

  instance = new ProvidersService(repository, makeCredentials())
  return instance
}
