import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IKnownSecret, IMaskHit, knownForms, maskDeep, maskText } from '@domain/Secret.Mask'
import { SecretBox } from './Aes.SecretBox'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS secret_mask_values (
    id          TEXT NOT NULL PRIMARY KEY,
    label       TEXT NOT NULL,
    sealed      TEXT NOT NULL,
    last4       TEXT,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT
  );
  CREATE TABLE IF NOT EXISTS secret_mask_names (
    kind  TEXT NOT NULL,
    name  TEXT NOT NULL,
    PRIMARY KEY (kind, name)
  );
`

type TRow = Record<string, unknown>

export interface IMaskValueView {
  id: string
  label: string
  last4?: string
  updatedAt: Date
  updatedBy?: string
}

export interface IMaskHitEntry extends IMaskHit {
  at: Date
  sessionId?: string
}

/** Quanto tempo o segredo de uma conta, entregue a um comando, segue mascarado depois (o log pode ser lido horas depois). */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const HITS_KEPT = 200

/**
 * ⛔ QUEM MASCARA, num lugar só: junta os segredos conhecidos (as chaves dos providers, os das contas que foram a um
 * comando, os cadastrados na tela), aplica as três camadas (ver `Secret.Mask`) e guarda os últimos acertos — só o
 * metadado. O valor cadastrado na tela fica selado no cofre e nunca volta.
 */
export class SecretMasker {
  private readonly db: DatabaseSync
  private readonly bySession = new Map<string, { secrets: IKnownSecret[]; until: number }>()
  private readonly hits: IMaskHitEntry[] = []
  private cache?: { stored: IKnownSecret[]; names: { secret: string[]; safe: string[] } }

  constructor(
    private readonly box: SecretBox,
    path = ':memory:',
    /** As chaves dos providers (o cofre das credenciais), lidas na hora. */
    private readonly providerKeys: () => IKnownSecret[] = () => [],
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  /** Os segredos que as contas entregaram a um comando desta conversa. */
  register(sessionId: string, secrets: readonly IKnownSecret[]): void {
    if (!secrets.length) return
    const current = this.bySession.get(sessionId)
    const merged = [...(current?.secrets ?? []), ...secrets].filter((secret, index, all) => all.findIndex((other) => other.value === secret.value) === index)
    this.bySession.set(sessionId, { secrets: merged, until: Date.now() + SESSION_TTL_MS })
  }

  text(text: string, sessionId?: string): string {
    if (!text) return text
    const { known, options } = this.context(sessionId)
    return maskText(text, known, options)
  }

  deep<T>(value: T, sessionId?: string): T {
    const { known, options } = this.context(sessionId)
    return maskDeep(value, known, options) as T
  }

  /**
   * Um valor mascarado e os acertos DESTA chamada (o export do catálogo lista o que trocou, sem o valor). `key` é o nome
   * do campo: ancora a forma como no `deep` (`GH_TOKEN: <opaco>` sai mascarado mesmo sem formato de token).
   */
  scan(value: string, key?: string): { text: string; hits: IMaskHit[] } {
    const hits: IMaskHit[] = []
    const { known, options } = this.context(undefined)
    const scoped = {
      ...options,
      onHit: (hit: IMaskHit) => {
        hits.push(hit)
        options.onHit(hit)
      },
    }
    const text = key === undefined ? maskText(value, known, scoped) : (maskDeep({ [key]: value }, known, scoped) as Record<string, string>)[key]
    return { text, hits }
  }

  /** O comando traz um segredo conhecido escrito por extenso? (Ele roda; o aviso ensina a usar a variável.) */
  literalIn(command: string, sessionId?: string): string | undefined {
    return this.context(sessionId).known.find((secret) => command.includes(secret.value))?.label
  }

  recentHits(): IMaskHitEntry[] {
    return [...this.hits].reverse()
  }

  // —— O cadastro da tela ——

  values(): IMaskValueView[] {
    return (this.db.prepare('SELECT id, label, last4, updated_at, updated_by FROM secret_mask_values ORDER BY label').all() as TRow[]).map((row) => ({
      id: String(row.id),
      label: String(row.label),
      ...(typeof row.last4 === 'string' ? { last4: row.last4 } : {}),
      updatedAt: new Date(String(row.updated_at)),
      ...(typeof row.updated_by === 'string' ? { updatedBy: row.updated_by } : {}),
    }))
  }

  saveValue(id: string, label: string, value: string | undefined, by: string): void {
    const current = this.db.prepare('SELECT sealed FROM secret_mask_values WHERE id = ?').get(id) as TRow | undefined
    const clean = value?.trim()
    if (!clean && !current) throw new Error('value: obrigatório')
    const sealed = clean ? this.box.seal(clean, `mascara:${id}`) : String(current!.sealed)
    this.db
      .prepare(
        `INSERT INTO secret_mask_values (id, label, sealed, last4, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET label = excluded.label, sealed = excluded.sealed, last4 = COALESCE(excluded.last4, secret_mask_values.last4),
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(id, label, sealed, clean ? clean.slice(-4) : null, new Date().toISOString(), by)
    this.cache = undefined
  }

  removeValue(id: string): boolean {
    const removed = Number(this.db.prepare('DELETE FROM secret_mask_values WHERE id = ?').run(id).changes) > 0
    this.cache = undefined
    return removed
  }

  names(): { secret: string[]; safe: string[] } {
    const rows = this.db.prepare('SELECT kind, name FROM secret_mask_names ORDER BY name').all() as TRow[]
    return { secret: rows.filter((row) => row.kind === 'secret').map((row) => String(row.name)), safe: rows.filter((row) => row.kind === 'safe').map((row) => String(row.name)) }
  }

  saveNames(names: { secret: readonly string[]; safe: readonly string[] }): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM secret_mask_names').run()
      const insert = this.db.prepare('INSERT OR IGNORE INTO secret_mask_names (kind, name) VALUES (?, ?)')
      for (const name of names.secret) insert.run('secret', name.trim())
      for (const name of names.safe) insert.run('safe', name.trim())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.cache = undefined
  }

  private context(sessionId: string | undefined) {
    this.cache ??= {
      stored: (this.db.prepare('SELECT id, label, sealed FROM secret_mask_values').all() as TRow[])
        .map((row) => ({ value: this.box.open(String(row.sealed), `mascara:${String(row.id)}`) ?? '', label: String(row.label) }))
        .filter((secret) => secret.value),
      names: this.names(),
    }
    const now = Date.now()
    for (const [id, entry] of this.bySession) if (entry.until < now) this.bySession.delete(id)
    const session = sessionId ? (this.bySession.get(sessionId)?.secrets ?? []) : []
    const known = knownForms([...session, ...this.providerKeys(), ...this.cache.stored])
    return {
      known,
      options: {
        extraSecretNames: this.cache.names.secret,
        extraSafeNames: this.cache.names.safe,
        onHit: (hit: IMaskHit) => {
          this.hits.push({ ...hit, at: new Date(), ...(sessionId ? { sessionId } : {}) })
          if (this.hits.length > HITS_KEPT) this.hits.shift()
        },
      },
    }
  }
}
