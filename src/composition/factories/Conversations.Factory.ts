import { NullConversationRepository } from '@infra/persistence/Null.ConversationRepository'
import { DEFAULT_DB_PATH, SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'

/**
 * Onde a conversa é gravada.
 *
 * ⚖️ GRAVA POR PADRÃO. O arquivo é criado sozinho e não custa nada; exigir configuração para
 * registrar faria toda instalação nova rodar sem histórico, e ninguém descobre que falta registro
 * pelo sintoma — descobre no dia em que precisa olhar para trás e não tem o quê.
 *
 * `CONVERSATIONS_DB=off` desliga; qualquer outro valor é o caminho do arquivo.
 *
 * ⚠️ O script `test` do package.json força `:memory:`. Sem isso a suíte grava um `data/gateway.db`
 * de verdade no repositório — três testes montam esta factory, e um teste que deixa arquivo para
 * trás é um teste que muda de resultado conforme a ordem em que roda.
 */
export function makeConversationRepository() {
  const configured = process.env.CONVERSATIONS_DB?.trim()
  if (configured === 'off') return new NullConversationRepository()

  try {
    return new SqliteConversationRepository(configured || DEFAULT_DB_PATH)
  } catch (error) {
    // ⛔ Não poder gravar não pode impedir o gateway de atender. Disco cheio, permissão negada,
    // caminho inválido: segue sem histórico, dizendo por quê.
    console.warn('[sqlite] não foi possível abrir o banco; seguindo sem registrar conversa.', error)
    return new NullConversationRepository()
  }
}
