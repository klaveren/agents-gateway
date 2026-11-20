import { speechEngineOf, SpeechService } from '@application/Speech.Service'
import { synthesizeSpeech } from '@infra/speech/Speech.Synthesizer'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteUserPreferenceRepository } from '@infra/persistence/Sqlite.UserPreferenceRepository'
import { SpeechController } from '@infra/http/Speech.Controller'
import { makeAuth } from './Auth.Factory'
import { makePersonMessages } from './PersonMessages.Factory'
import { makeProviderVoices } from './ProviderVoices.Factory'
import { makeProviders } from './Providers.Factory'
import { makeSpeechUsage } from './SpeechUsage.Factory'
import { makeSettings } from './Settings.Factory'

let service: SpeechService | undefined

/** 🔊 A voz das mensagens (ver `Speech.Service`): uma instância (o cache mora nela); o motor é lido das Configurações a cada chamada. */
export function makeSpeech(): SpeechService {
  if (service) return service
  const configured = process.env.CONVERSATIONS_DB?.trim()
  const path = configured === 'off' || configured === ':memory:' ? ':memory:' : configured || DEFAULT_DB_PATH
  service = new SpeechService({
    prefs: new SqliteUserPreferenceRepository(path),
    engine: async () => speechEngineOf(await makeSettings().read(), (providerId) => makeProviders().connection(providerId)),
    synthesize: (connection, model, text, options) => synthesizeSpeech(connection, model, text, options),
    record: (entry) => makeSpeechUsage().record(entry),
    accountVoices: (providerId) => makeProviderVoices().get(providerId).voices,
  })
  return service
}

export function makeSpeechController(): SpeechController {
  return new SpeechController({ speech: makeSpeech(), messages: makePersonMessages(), proof: makeAuth().proof })
}
