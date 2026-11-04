import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { SqliteResourceSecretRepository } from './Sqlite.ResourceSecretRepository'

describe('SqliteResourceSecretRepository', () => {
  const at = new Date('2026-11-04T12:00:00Z')

  it('⛔ a lista nunca traz o valor; o valor sai só por `value`; sem valor, só a descrição muda', () => {
    const repository = new SqliteResourceSecretRepository(new SecretBox(randomBytes(32)))
    repository.save({ scope: 'skill', scopeId: 'gitlab', name: 'GITLAB_TOKEN', description: 'deploy', value: 'glpat-segredo-1234', by: 'root', at })
    assert.deepStrictEqual(repository.list('skill', 'gitlab'), [
      { scope: 'skill', scopeId: 'gitlab', name: 'GITLAB_TOKEN', description: 'deploy', updatedAt: at, updatedBy: 'root' },
    ])
    assert.ok(!JSON.stringify(repository.list('skill', 'gitlab')).includes('glpat'))
    assert.strictEqual(repository.value('skill', 'gitlab', 'GITLAB_TOKEN'), 'glpat-segredo-1234')
    assert.ok(repository.save({ scope: 'skill', scopeId: 'gitlab', name: 'GITLAB_TOKEN', description: 'outra', by: 'root', at }))
    assert.strictEqual(repository.value('skill', 'gitlab', 'GITLAB_TOKEN'), 'glpat-segredo-1234')
    assert.strictEqual(repository.save({ scope: 'skill', scopeId: 'gitlab', name: 'NAO_EXISTE', by: 'root', at }), false)
  })

  it('⛔ cifrado no banco e amarrado ao recurso e ao nome: copiado para outra variável, não abre', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-secret-'))
    try {
      const path = join(dir, 'gateway.db')
      const repository = new SqliteResourceSecretRepository(new SecretBox(randomBytes(32)), path)
      repository.save({ scope: 'agent', scopeId: 'theo', name: 'TOKEN_A', value: 'valor-muito-secreto', by: 'root', at })
      repository.save({ scope: 'agent', scopeId: 'theo', name: 'TOKEN_B', value: 'outro-valor-qualquer', by: 'root', at })
      const raw = new DatabaseSync(path)
      assert.ok(!JSON.stringify(raw.prepare('SELECT * FROM resource_secrets').all()).includes('valor-muito-secreto'))
      raw.prepare("UPDATE resource_secrets SET sealed = (SELECT sealed FROM resource_secrets WHERE name = 'TOKEN_A') WHERE name = 'TOKEN_B'").run()
      raw.close()
      assert.strictEqual(repository.value('agent', 'theo', 'TOKEN_B'), undefined)
      repository.removeScope('agent', 'theo')
      assert.deepStrictEqual(repository.list('agent', 'theo'), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
