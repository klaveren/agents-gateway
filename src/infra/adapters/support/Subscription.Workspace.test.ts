import assert from 'node:assert'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { projectHome, projectWorkspace, removeProjectWorkspace, sessionWorkspace, workspaceFor } from './Subscription.Workspace'

describe('pasta de trabalho do agente', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-workspace-'))
  const previous = process.env.CONVERSATIONS_DB
  process.env.CONVERSATIONS_DB = join(root, 'gateway.db')
  after(() => {
    process.env.CONVERSATIONS_DB = previous
    rmSync(root, { recursive: true, force: true })
  })

  it('⚖️ agente de projeto: a pasta do projeto, a mesma em toda conversa; global: uma vazia por conversa', () => {
    const a = workspaceFor('alfa', 's-1')
    assert.strictEqual(a, join(root, 'projects', 'alfa'))
    assert.strictEqual(workspaceFor('alfa', 's-2'), a)
    const loose = workspaceFor(undefined, 's-1')
    assert.notStrictEqual(loose, workspaceFor(undefined, 's-2'))
    assert.ok(!loose.startsWith(join(root, 'projects')))
  })

  it('⛔ a pasta da conversa que já existia plantada (link, ou aberta à escrita de outros) é recusada', () => {
    const subs = join(root, 'sub')
    assert.strictEqual(sessionWorkspace('s/1', subs), join(subs, 's_1'))
    assert.strictEqual(sessionWorkspace('s/1', subs), join(subs, 's_1'))

    const elsewhere = join(root, 'alheia')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(subs, 'plantada'))
    assert.throws(() => sessionWorkspace('plantada', subs), /não é só do gateway/)

    mkdirSync(join(subs, 'aberta'))
    chmodSync(join(subs, 'aberta'), 0o777)
    assert.throws(() => sessionWorkspace('aberta', subs), /não é só do gateway/)

    const open = join(root, 'sub-aberta')
    mkdirSync(open)
    chmodSync(open, 0o777)
    assert.throws(() => sessionWorkspace('s-1', open), /não é só do gateway/)
  })

  it('o HOME do Codex fica dentro do projeto (`.home`), e apagar o projeto leva a pasta', () => {
    assert.strictEqual(projectHome('beta'), join(root, 'projects', 'beta', '.home'))
    assert.ok(existsSync(projectWorkspace('beta')))
    removeProjectWorkspace('beta')
    assert.ok(!existsSync(join(root, 'projects', 'beta')))
  })
})
