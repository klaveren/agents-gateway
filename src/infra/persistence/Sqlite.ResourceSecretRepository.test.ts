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
  it('⛔ os valores são POR PROJETO: a origem e cada projeto que recebeu têm os seus, com os mesmos nomes', () => {
    const repository = new SqliteResourceSecretRepository(new SecretBox(randomBytes(32)))
    repository.save({ scope: 'skill', scopeId: 'deploy', name: 'TOKEN', value: 'valor-da-origem', by: 'ana', at })
    repository.save({ scope: 'skill', scopeId: 'deploy', project: 'beta', name: 'TOKEN', value: 'valor-do-beta', by: 'bia', at })
    assert.strictEqual(repository.value('skill', 'deploy', 'TOKEN'), 'valor-da-origem')
    assert.strictEqual(repository.value('skill', 'deploy', 'TOKEN', 'beta'), 'valor-do-beta')
    assert.strictEqual(repository.value('skill', 'deploy', 'TOKEN', 'gama'), undefined)
    assert.strictEqual(repository.list('skill', 'deploy', 'beta').length, 1)
    // Sem descrição nem valor novo, só o projeto certo muda.
    assert.strictEqual(repository.save({ scope: 'skill', scopeId: 'deploy', project: 'gama', name: 'TOKEN', by: 'x', at }), false)
    assert.ok(repository.remove('skill', 'deploy', 'TOKEN', 'beta'))
    assert.strictEqual(repository.value('skill', 'deploy', 'TOKEN'), 'valor-da-origem')
  })

  it('⛔ parar de compartilhar apaga os valores de quem saiu; apagar o projeto ou o recurso apaga os dele', () => {
    const repository = new SqliteResourceSecretRepository(new SecretBox(randomBytes(32)))
    for (const project of ['', 'beta', 'gama']) repository.save({ scope: 'skill', scopeId: 'deploy', project, name: 'TOKEN', value: `valor-${project || 'origem'}`, by: 'ana', at })
    repository.save({ scope: 'command', scopeId: 'rodar', project: 'beta', name: 'TOKEN', value: 'valor-command', by: 'ana', at })
    repository.keepProjects('skill', 'deploy', ['beta'])
    assert.deepStrictEqual(
      [repository.value('skill', 'deploy', 'TOKEN'), repository.value('skill', 'deploy', 'TOKEN', 'beta'), repository.value('skill', 'deploy', 'TOKEN', 'gama')],
      ['valor-origem', 'valor-beta', undefined],
    )
    repository.removeProject('beta')
    assert.deepStrictEqual(
      [repository.value('skill', 'deploy', 'TOKEN', 'beta'), repository.value('command', 'rodar', 'TOKEN', 'beta'), repository.value('skill', 'deploy', 'TOKEN')],
      [undefined, undefined, 'valor-origem'],
    )
    repository.save({ scope: 'skill', scopeId: 'deploy', project: 'beta', name: 'TOKEN', value: 'de-novo', by: 'ana', at })
    repository.removeScope('skill', 'deploy')
    assert.deepStrictEqual([repository.list('skill', 'deploy'), repository.list('skill', 'deploy', 'beta')], [[], []])
  })

  it('⚖️ banco de antes dos projetos: as variáveis viram as da origem, sem perder nenhuma, e o valor ainda abre', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-secret-'))
    try {
      const path = join(dir, 'gateway.db')
      const box = new SecretBox(randomBytes(32))
      const old = new DatabaseSync(path)
      old.exec(
        `CREATE TABLE resource_secrets (scope TEXT NOT NULL, scope_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, sealed TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT, PRIMARY KEY (scope, scope_id, name))`,
      )
      old
        .prepare('INSERT INTO resource_secrets VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('skill', 'deploy', 'TOKEN', 'antigo', box.seal('valor-antigo', 'segredo:skill:deploy:TOKEN'), at.toISOString(), 'ana')
      old.close()
      const repository = new SqliteResourceSecretRepository(box, path)
      assert.strictEqual(repository.value('skill', 'deploy', 'TOKEN'), 'valor-antigo')
      assert.deepStrictEqual(repository.list('skill', 'deploy'), [{ scope: 'skill', scopeId: 'deploy', name: 'TOKEN', description: 'antigo', updatedAt: at, updatedBy: 'ana' }])
      // Abrir de novo (já migrado) não mexe em nada.
      assert.strictEqual(new SqliteResourceSecretRepository(box, path).value('skill', 'deploy', 'TOKEN'), 'valor-antigo')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
