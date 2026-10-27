import assert from 'node:assert'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { projectHome, projectWorkspace, removeProjectWorkspace, workspaceFor } from './Subscription.Workspace'

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

  it('o HOME do Codex fica dentro do projeto (`.home`), e apagar o projeto leva a pasta', () => {
    assert.strictEqual(projectHome('beta'), join(root, 'projects', 'beta', '.home'))
    assert.ok(existsSync(projectWorkspace('beta')))
    removeProjectWorkspace('beta')
    assert.ok(!existsSync(join(root, 'projects', 'beta')))
  })
})
