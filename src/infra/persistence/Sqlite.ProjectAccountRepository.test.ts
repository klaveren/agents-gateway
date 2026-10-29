import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { SqliteProjectAccountRepository } from './Sqlite.ProjectAccountRepository'

describe('SqliteProjectAccountRepository', () => {
  it('⛔ o segredo fica selado e só abre como o da conta dele: copiado para outro projeto, não abre', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'accounts-')), 'gateway.db')
    const repository = new SqliteProjectAccountRepository(new SecretBox(randomBytes(32)), path)
    const saved = repository.save('p1', 'github-empresa1', { kind: 'github-token', label: 'Empresa 1', public: { owner: 'empresa1' }, secret: 'ghp_segredo1234' }, 'admin')

    assert.strictEqual(saved.public.last4, '1234')
    assert.strictEqual(repository.secret('p1', 'github-empresa1'), 'ghp_segredo1234')
    const db = new DatabaseSync(path)
    const row = db.prepare('SELECT sealed FROM project_accounts').get() as { sealed: string }
    assert.ok(!row.sealed.includes('segredo'))
    db.prepare("INSERT INTO project_accounts SELECT 'p2', id, kind, label, public, sealed, updated_at, updated_by FROM project_accounts").run()
    db.close()
    assert.strictEqual(repository.secret('p2', 'github-empresa1'), undefined)
  })

  it('editar sem segredo mantém o guardado; apagar o projeto leva as contas', () => {
    const repository = new SqliteProjectAccountRepository(new SecretBox(randomBytes(32)))
    repository.save('p1', 'gitlab', { kind: 'secret-env', label: 'GitLab', public: { envName: 'GITLAB_TOKEN' }, secret: 'glpat-abcd' }, 'admin')
    repository.save('p1', 'gitlab', { kind: 'secret-env', label: 'GitLab da firma', public: { envName: 'GITLAB_TOKEN' } }, 'admin')
    assert.strictEqual(repository.secret('p1', 'gitlab'), 'glpat-abcd')
    assert.strictEqual(repository.get('p1', 'gitlab')?.label, 'GitLab da firma')
    assert.strictEqual(repository.get('p1', 'gitlab')?.public.last4, 'abcd')
    repository.deleteProject('p1')
    assert.deepStrictEqual(repository.list('p1'), [])
  })
})
