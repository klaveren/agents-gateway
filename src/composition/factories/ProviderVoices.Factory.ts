import type { IProviderVoiceStore } from '@domain/models/ProviderVoice.Model'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteProviderVoiceStore } from '@infra/persistence/Sqlite.ProviderVoiceStore'

let instance: IProviderVoiceStore | undefined

/** 🎙️ As vozes da conta de cada provider (DashScope), no arquivo das conversas. Uma instância só. */
export function makeProviderVoices(): IProviderVoiceStore {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  instance = new SqliteProviderVoiceStore(configured === 'off' || configured === ':memory:' ? ':memory:' : configured || DEFAULT_DB_PATH)
  return instance
}
