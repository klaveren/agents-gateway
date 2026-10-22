import assert from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_SETTINGS, IAgentSettings } from '@domain/models/Settings.Model'
import { SqliteSettingsRepository } from './Sqlite.SettingsRepository'

/** Em arquivo temporário: reabrir só faz sentido se houver um arquivo para reabrir. */
function withFile(work: (path: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-settings-'))
    try {
      await work(join(dir, 'gateway.db'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

describe('SqliteSettingsRepository', () => {
  it('reads the default when nothing was saved', async () => {
    const repo = new SqliteSettingsRepository(':memory:')

    assert.deepStrictEqual(await repo.read(), DEFAULT_SETTINGS)
  })

  it(
    'survives a reopen, with the date back as a Date',
    withFile(async (path) => {
      const first = new SqliteSettingsRepository(path)
      await first.save({ audience: 'restricted', agentId: 'sysops-agent', model: 'claude-opus-5', updatedBy: 'root@x.test' })
      first.close()

      const stored = await new SqliteSettingsRepository(path).read()

      assert.strictEqual(stored.audience, 'restricted')
      assert.strictEqual(stored.agentId, 'sysops-agent')
      assert.strictEqual(stored.updatedBy, 'root@x.test')
      assert.ok(stored.updatedAt instanceof Date)
    }),
  )

  it(
    'save REPLACES: a field left out of the object is gone, not kept',
    withFile(async (path) => {
      const repo = new SqliteSettingsRepository(path)
      await repo.save({ audience: 'all', agentId: 'sysops-agent', model: 'claude-opus-5' })
      await repo.save({ audience: 'all' })
      repo.close()

      const stored = await new SqliteSettingsRepository(path).read()
      assert.strictEqual('agentId' in stored, false)
      assert.strictEqual('model' in stored, false)
    }),
  )

  it('tells subscribers, and read shows the change at once', async () => {
    const repo = new SqliteSettingsRepository(':memory:')
    const heard: IAgentSettings[] = []
    repo.subscribe((settings) => heard.push(settings))

    await repo.save({ audience: 'off' })

    assert.strictEqual(heard.length, 1)
    assert.strictEqual(heard[0].audience, 'off')
    assert.strictEqual((await repo.read()).audience, 'off')
  })

  it(
    'migrates a document written with the old `enabled` boolean',
    withFile(async (path) => {
      new SqliteSettingsRepository(path).close()
      const raw = new DatabaseSync(path)
      raw.prepare('INSERT OR REPLACE INTO settings (id, value, updated_at) VALUES (?, ?, ?)').run('agent', JSON.stringify({ enabled: false, model: 'm' }), new Date().toISOString())
      raw.close()

      const stored = await new SqliteSettingsRepository(path).read()

      assert.strictEqual(stored.audience, 'off')
      assert.strictEqual(stored.model, 'm')
      assert.strictEqual('enabled' in stored, false)
    }),
  )

  it(
    'a corrupt document fails closed — it may be hiding an `off` the admin saved',
    withFile(async (path) => {
      new SqliteSettingsRepository(path).close()
      const raw = new DatabaseSync(path)
      raw.prepare('INSERT OR REPLACE INTO settings (id, value, updated_at) VALUES (?, ?, ?)').run('agent', '{not json', 'x')
      raw.close()

      const repo = new SqliteSettingsRepository(path)
      // Nunca lança, mas também nunca cai no padrão `all`.
      assert.strictEqual((await repo.read()).audience, 'off')

      // Não fixa o estado de falha: consertado o documento, a próxima leitura vê o valor real.
      const fix = new DatabaseSync(path)
      fix.prepare('UPDATE settings SET value = ? WHERE id = ?').run(JSON.stringify({ audience: 'restricted' }), 'agent')
      fix.close()
      assert.strictEqual((await repo.read()).audience, 'restricted')
    }),
  )

  it(
    'a file that is not a database never breaks the service',
    withFile(async (path) => {
      writeFileSync(path, 'this is not sqlite '.repeat(200))

      const repo = new SqliteSettingsRepository(path)

      assert.deepStrictEqual(await repo.read(), DEFAULT_SETTINGS)
      // Gravar também não lança, e a mudança vale neste processo.
      await assert.doesNotReject(() => repo.save({ audience: 'off' }))
      assert.strictEqual((await repo.read()).audience, 'off')
    }),
  )

  it('an unusable path never breaks the service', async () => {
    const repo = new SqliteSettingsRepository('/dev/null/not-a-dir/gateway.db')

    assert.deepStrictEqual(await repo.read(), DEFAULT_SETTINGS)
    await assert.doesNotReject(() => repo.save({ audience: 'restricted' }))
    assert.strictEqual((await repo.read()).audience, 'restricted')
  })

  it('a write that fails is reported, not swallowed — and the old value stays', async () => {
    const repo = new SqliteSettingsRepository(':memory:')
    await repo.save({ audience: 'restricted' })
    repo.close()

    await assert.rejects(() => repo.save({ audience: 'off' }))
    await assert.doesNotReject(() => repo.read())
    assert.strictEqual((await repo.read()).audience, 'restricted')
  })
})
