import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS, IAgentSettings, normalizeSettings } from '@domain/models/Settings.Model'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'
import { DEFAULT_DB_PATH } from './Sqlite.ConversationRepository'

/** Documento único: são configurações do serviço, não uma por linha. */
const SINGLETON = 'agent'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    id         TEXT NOT NULL PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`

/**
 * Configurações em SQLite — o mesmo arquivo da conversa.
 *
 * ⛔ NENHUM MÉTODO AQUI PODE DERRUBAR O SERVIÇO, a mesma regra do repositório de conversa. Banco
 * fora do ar devolve o que estava em memória (ou o default) e o gateway segue atendendo.
 *
 * ⚖️ `save()` SUBSTITUI, não mescla. Com mescla, "voltar ao padrão" — que é apagar um campo — não
 * teria efeito: o campo ausente do objeto ficaria intacto no documento, e a tela diria salvo
 * enquanto o banco mantinha a escolha antiga. Quem mescla é o controller, com o que está gravado em
 * mãos; aqui o objeto recebido É o documento.
 *
 * ⚠️ Falha de GRAVAÇÃO LANÇA (ver `save`): quem salvou precisa saber que a mudança não ficou. Só o
 * banco que não abriu no boot degrada para memória — e isso o boot já avisou.
 *
 * A cópia em memória também evita uma ida ao arquivo por chamada: `read()` é pergunta de caminho
 * quente (toda sessão nova). É uma instância só por processo, então não há quem a invalide por fora.
 */
export class SqliteSettingsRepository implements ISettingsRepository {
  private readonly db?: DatabaseSync
  private readonly listeners: Array<(settings: IAgentSettings) => void> = []
  private cached?: IAgentSettings

  constructor(path: string = DEFAULT_DB_PATH) {
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

      const db = new DatabaseSync(path)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(SCHEMA)
      this.db = db
    } catch (error) {
      // Sem banco o repositório ainda serve: guarda em memória, como o `Null`.
      console.warn('[sqlite] não foi possível abrir o banco de configurações; valem os padrões.', error)
    }
  }

  async read(): Promise<IAgentSettings> {
    if (this.cached) return this.cached

    let stored: unknown
    try {
      const row = this.db?.prepare('SELECT value FROM settings WHERE id = ?').get(SINGLETON) as { value?: unknown } | undefined
      stored = typeof row?.value === 'string' ? (JSON.parse(row.value) as unknown) : undefined
    } catch (error) {
      /**
       * ⛔ FALHA FECHA. "Não há configuração gravada" e "não consegui ler a configuração" são coisas
       * diferentes: a primeira vale o padrão; a segunda pode estar escondendo um `off` gravado pelo
       * admin, e devolver o padrão (`all`) abriria o gateway justamente quando ele foi desligado.
       * Não fixa no cache: a próxima leitura tenta de novo.
       */
      console.error('[sqlite] leitura das configurações falhou; atendendo como `off` até ler de novo.', error)
      return { ...DEFAULT_SETTINGS, audience: 'off' }
    }

    // Nada gravado (instalação nova ou sem banco): vale o padrão, e também não fixa no cache.
    if (stored === undefined) return DEFAULT_SETTINGS

    this.cached = normalizeSettings(stored)

    return this.cached
  }

  async save(settings: IAgentSettings): Promise<void> {
    const value = normalizeSettings({ ...settings, updatedAt: new Date() })

    /**
     * ⛔ GRAVAR FALHA ALTO. O "nunca quebra" deste repositório protege o turno de quem conversa;
     * salvar configuração é ação de admin, e responder 200 a uma mudança que some no próximo boot
     * é pior que um erro. Sem banco desde o boot (já avisado), a mudança vale só neste processo.
     */
    this.db
      ?.prepare('INSERT OR REPLACE INTO settings (id, value, updated_at) VALUES (?, ?, ?)')
      .run(SINGLETON, JSON.stringify(value), (value.updatedAt ?? new Date()).toISOString())

    this.cached = value
    for (const listener of this.listeners) listener(value)
  }

  subscribe(listener: (settings: IAgentSettings) => void): void {
    this.listeners.push(listener)
  }

  close(): void {
    this.guard('close', () => this.db?.close())
  }

  private guard<T>(operation: string, work: () => T): T | undefined {
    try {
      return work()
    } catch (error) {
      console.warn(`[sqlite] configurações: ${operation} falhou; segue sem persistir.`, error)
      return undefined
    }
  }
}
