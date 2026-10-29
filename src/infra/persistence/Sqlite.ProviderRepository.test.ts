import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { SqliteProviderRepository } from './Sqlite.ProviderRepository'

describe('SqliteProviderRepository', () => {
  it('os oficiais nascem com o nome que diz como se paga: empresa = token, produto = assinatura', () => {
    const names = new SqliteProviderRepository().list().map((provider) => `${provider.id}=${provider.name}`)
    assert.deepStrictEqual(names, ['claude=Anthropic', 'openai=OpenAI', 'google=Google', 'claude-sub=Claude', 'codex=Codex', 'antigravity=Antigravity'])
  })

  it('o nome antigo de um oficial passa ao de agora; o que alguém renomeou fica', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'providers-')), 'gateway.db')
    new SqliteProviderRepository(path)
    const db = new DatabaseSync(path)
    db.prepare("UPDATE providers SET name = 'ChatGPT (assinatura)' WHERE id = 'codex'").run()
    db.prepare("UPDATE providers SET name = 'Claude da firma' WHERE id = 'claude'").run()
    db.prepare("UPDATE providers SET name = 'Gemini' WHERE id = 'antigravity'").run()
    db.close()
    const repository = new SqliteProviderRepository(path)
    assert.strictEqual(repository.get('codex')?.name, 'Codex')
    assert.strictEqual(repository.get('antigravity')?.name, 'Antigravity')
    assert.strictEqual(repository.get('claude')?.name, 'Claude da firma')
  })
})
