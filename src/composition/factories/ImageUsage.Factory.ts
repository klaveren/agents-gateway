import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteImageUsageRepository } from '@infra/persistence/Sqlite.ImageUsageRepository'

let repository: SqliteImageUsageRepository | undefined

/** 🖼️ O uso das imagens (ver `ImageUsage.Model`): uma instância, no arquivo das conversas — o `generate_image` grava, o relatório e o teto leem. */
export function makeImageUsage(): SqliteImageUsageRepository {
  const configured = process.env.CONVERSATIONS_DB?.trim()
  repository ??= new SqliteImageUsageRepository(configured === 'off' || configured === ':memory:' ? ':memory:' : configured || DEFAULT_DB_PATH)
  return repository
}
