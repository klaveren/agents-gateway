import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ENV_KEY_NAME, ICredentialStatus, ICredentialStore } from '@domain/ports/CredentialStore.Port'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS provider_credentials (
    provider    TEXT NOT NULL PRIMARY KEY,
    sealed      TEXT NOT NULL,
    last4       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT
  );

  CREATE TABLE IF NOT EXISTS credential_meta (
    key    TEXT NOT NULL PRIMARY KEY,
    value  TEXT NOT NULL
  );
`

type TRow = Record<string, unknown>

/**
 * As chaves de API salvas pela tela, FECHADAS (`SecretBox`) no mesmo arquivo das conversas.
 *
 * ⚖️ DECIFRADAS UMA VEZ e mantidas em memória: a chave é pedida a cada chamada ao modelo, e abrir
 * AES a cada turno é custo à toa. A memória é refeita a cada escrita.
 */
export class SqliteCredentialStore implements ICredentialStore {
  private readonly db?: DatabaseSync
  private readonly memory = new Map<string, { key?: string; last4: string; updatedAt: Date; updatedBy?: string }>()
  private readonly listeners: Array<(provider: string) => void> = []

  /** `path` ausente = só memória (`CONVERSATIONS_DB=off`): vale até o restart (com o `.env` importado a cada boot). */
  constructor(
    private readonly box: SecretBox,
    path?: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    if (path) {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
      this.db = new DatabaseSync(path)
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec(SCHEMA)
      this.load()
    }
    this.importFromEnv()
  }

  /**
   * ⚖️ O `.env` vira o cofre UMA VEZ: a chave de um oficial que está só no ambiente é importada (cifrada)
   * no primeiro boot, e daí em diante vale o cofre e só ele. Antes o `.env` era uma segunda fonte viva:
   * "Remover chave" na tela não desligava nada, porque a do ambiente continuava valendo.
   * A marca por provider (`env-imported:<id>`) impede que a chave removida pela tela volte no boot seguinte.
   */
  private importFromEnv(): void {
    for (const provider of Object.keys(ENV_KEY_NAME)) {
      const key = this.fromEnv(provider)
      if (!key || this.memory.get(provider)?.key) continue
      const marker = `env-imported:${provider}`
      if (this.db?.prepare('SELECT 1 FROM credential_meta WHERE key = ?').get(marker)) continue
      this.save(provider, key, 'env')
      this.db?.prepare('INSERT OR REPLACE INTO credential_meta (key, value) VALUES (?, ?)').run(marker, new Date().toISOString())
      console.log(`[credentials] a chave de ${provider} veio do ambiente para o cofre; daqui em diante vale a da tela.`)
    }
  }

  get(provider: string): string | undefined {
    return this.memory.get(provider)?.key
  }

  status(providerIds: readonly string[]): ICredentialStatus[] {
    return providerIds.map((provider) => {
      const stored = this.memory.get(provider)

      if (stored?.key) return { provider, configured: true, source: 'stored', last4: stored.last4, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy }
      const unreadable = stored ? { unreadable: true, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy } : {}
      return { provider, configured: false, source: 'none', ...unreadable }
    })
  }

  save(provider: string, key: string, by: string): void {
    const clean = key.trim()
    const entry = { key: clean, last4: clean.slice(-4), updatedAt: new Date(), updatedBy: by }

    this.db
      ?.prepare(
        `INSERT INTO provider_credentials (provider, sealed, last4, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET sealed = excluded.sealed, last4 = excluded.last4, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(provider, this.box.seal(clean, provider), entry.last4, entry.updatedAt.toISOString(), by)

    this.memory.set(provider, entry)
    this.notify(provider)
  }

  clear(provider: string): void {
    this.db?.prepare('DELETE FROM provider_credentials WHERE provider = ?').run(provider)
    this.memory.delete(provider)
    this.notify(provider)
  }

  subscribe(listener: (provider: string) => void): void {
    this.listeners.push(listener)
  }

  private load(): void {
    for (const row of this.db!.prepare('SELECT * FROM provider_credentials').all() as TRow[]) {
      const provider = String(row.provider)

      // Ilegível fica registrado SEM chave: a tela avisa, e a do `.env` (se houver) continua valendo.
      const key = this.box.open(String(row.sealed), provider)
      if (!key) console.warn(`[credentials] a chave salva de ${provider} não decifra (a chave-mestra mudou?); cole de novo.`)
      this.memory.set(provider, {
        key,
        last4: String(row.last4),
        updatedAt: new Date(String(row.updated_at)),
        updatedBy: typeof row.updated_by === 'string' ? row.updated_by : undefined,
      })
    }
  }

  /** Só os oficiais têm variável de ambiente; um compatível vive só do que foi salvo. */
  private fromEnv(provider: string): string | undefined {
    const name = ENV_KEY_NAME[provider]
    return (name && this.env[name]?.trim()) || undefined
  }

  private notify(provider: string): void {
    for (const listener of this.listeners) {
      try {
        listener(provider)
      } catch (error) {
        console.warn('[credentials] um ouvinte falhou:', error)
      }
    }
  }
}
