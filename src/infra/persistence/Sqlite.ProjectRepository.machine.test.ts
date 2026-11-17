import assert from 'node:assert'
import { describe, it } from 'node:test'
import { marksMachine } from '@domain/models/Project.Model'
import { SqliteProjectRepository } from './Sqlite.ProjectRepository'

describe('Sqlite.ProjectRepository — agentes de máquina', () => {
  it('🖥️ grava, lê e apaga a lista; vazia some', () => {
    const repo = new SqliteProjectRepository()
    const at = new Date()
    repo.insert({ id: 'xpto', name: 'XPTO', createdAt: at, updatedAt: at })
    assert.deepStrictEqual(repo.update('xpto', { machineAgents: ['dev', 'zeus'] })?.machineAgents, ['dev', 'zeus'])
    assert.ok(marksMachine(repo.get('xpto'), 'dev'))
    assert.ok(!marksMachine(repo.get('xpto'), 'outro'))
    assert.strictEqual(repo.update('xpto', { machineAgents: [] })?.machineAgents, undefined)
    assert.ok(!marksMachine(repo.get('xpto'), 'dev'))
  })
})
