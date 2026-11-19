import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { IPushSubscription } from '@domain/models/PushSubscription.Model'
import type { IPushSubscriptionRepository } from '@domain/ports/PushSubscriptionRepository.Port'
import type { SecretBox } from '@infra/secrets/Aes.SecretBox'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT NOT NULL PRIMARY KEY,
    user_id     TEXT NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    label       TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);
  CREATE TABLE IF NOT EXISTS push_vapid (
    id          INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    public_key  TEXT NOT NULL,
    sealed      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_contact (
    id       INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    contact  TEXT
  );
`
const VAPID_OWNER = 'push:vapid'

type TRow = Record<string, unknown>

/** 📱 As assinaturas de push, no mesmo arquivo das conversas; a chave privada VAPID FECHADA (`SecretBox`). */
export class SqlitePushSubscriptionRepository implements IPushSubscriptionRepository {
  private readonly db: DatabaseSync

  constructor(
    private readonly box: SecretBox,
    path = ':memory:',
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(SCHEMA)
  }

  save(subscription: IPushSubscription): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, created_at = excluded.created_at`,
      )
      .run(subscription.endpoint, subscription.userId, subscription.keys.p256dh, subscription.keys.auth, subscription.label ?? null, subscription.createdAt.toISOString())
  }

  remove(userId: string, endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint)
  }

  forget(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
  }

  of(userId: string): IPushSubscription[] {
    return (this.db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(userId) as TRow[]).map((row) => ({
      endpoint: String(row.endpoint),
      keys: { p256dh: String(row.p256dh), auth: String(row.auth) },
      userId: String(row.user_id),
      ...(row.label ? { label: String(row.label) } : {}),
      createdAt: new Date(String(row.created_at)),
    }))
  }

  vapid(): { publicKey: string; privateKey: string } | undefined {
    const row = this.db.prepare('SELECT public_key, sealed FROM push_vapid WHERE id = 1').get() as TRow | undefined
    if (!row) return undefined
    const privateKey = this.box.open(String(row.sealed), VAPID_OWNER)
    return privateKey ? { publicKey: String(row.public_key), privateKey } : undefined
  }

  contact(): string | undefined {
    const row = this.db.prepare('SELECT contact FROM push_contact WHERE id = 1').get() as TRow | undefined
    return row?.contact ? String(row.contact) : undefined
  }

  setContact(contact: string | undefined): void {
    this.db.prepare('INSERT INTO push_contact (id, contact) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET contact = excluded.contact').run(contact ?? null)
  }

  clear(): void {
    this.db.exec('DELETE FROM push_subscriptions')
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS total FROM push_subscriptions').get() as TRow).total)
  }

  setVapid(keys: { publicKey: string; privateKey: string }): void {
    this.db
      .prepare('INSERT INTO push_vapid (id, public_key, sealed) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET public_key = excluded.public_key, sealed = excluded.sealed')
      .run(keys.publicKey, this.box.seal(keys.privateKey, VAPID_OWNER))
  }
}
