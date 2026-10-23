import { applyLimits } from '@domain/models/Limits.Model'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteSettingsRepository } from '@infra/persistence/Sqlite.SettingsRepository'

let instance: ISettingsRepository | undefined

/**
 * Onde as configurações vivem.
 *
 * ⚖️ O MESMO ARQUIVO E A MESMA CHAVE DA CONVERSA (`CONVERSATIONS_DB`): `off` desliga a persistência
 * — as configurações passam a viver em memória e somem no restart —; qualquer outro valor é o
 * caminho do arquivo. Uma variável só porque quem desliga o banco quer os dois desligados, e duas
 * chaves para o mesmo arquivo era pedir que divergissem.
 *
 * ⚠️ UMA INSTÂNCIA SÓ. O provider e o controller precisam enxergar a MESMA configuração: com duas,
 * a tela salvaria numa e o provider continuaria lendo a outra — o "salvo" que não muda nada.
 */
export function makeSettings(): ISettingsRepository {
  if (instance) return instance
  instance = build()
  // Os limites da tela num espelho síncrono: quem pergunta está no meio de um turno (ver `Limits.Model`).
  instance.subscribe((settings) => applyLimits(settings.limits))
  void instance
    .read()
    .then((settings) => applyLimits(settings.limits))
    .catch(() => undefined)
  return instance
}

function build(): ISettingsRepository {
  const configured = process.env.CONVERSATIONS_DB?.trim()
  if (configured === 'off') return new NullSettingsRepository()

  // O próprio repositório absorve a falha de abrir o arquivo (⛔ não poder gravar não pode impedir de atender).
  return new SqliteSettingsRepository(configured || DEFAULT_DB_PATH)
}
