import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteSpeechUsageRepository } from '@infra/persistence/Sqlite.SpeechUsageRepository'

let repository: SqliteSpeechUsageRepository | undefined

/** 🔊 O uso da voz (ver `SpeechUsage.Model`): uma instância, no arquivo das conversas — a voz grava, o relatório de Uso lê. */
export function makeSpeechUsage(): SqliteSpeechUsageRepository {
  const configured = process.env.CONVERSATIONS_DB?.trim()
  repository ??= new SqliteSpeechUsageRepository(configured === 'off' || configured === ':memory:' ? ':memory:' : configured || DEFAULT_DB_PATH)
  return repository
}
