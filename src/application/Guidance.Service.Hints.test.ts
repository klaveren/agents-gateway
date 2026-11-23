import assert from 'node:assert'
import { describe, it } from 'node:test'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { GuidanceService } from './Guidance.Service'

// O `/` da caixa de mensagem lê só o que mostra (sem o corpo); a resposta tem de ser a mesma de ler tudo.
describe('GuidanceService — recursos e documentos sem o corpo (o `/` da caixa)', () => {
  const agents: Record<string, { id: string; projectId?: string }> = { 'dev-beta': { id: 'dev-beta', projectId: 'beta' }, atlas: { id: 'atlas' } }
  const seeded = () => {
    const service = new GuidanceService(
      new SqliteGuidanceRepository(':memory:'),
      (id) => ['alfa', 'beta'].includes(id),
      (id) => agents[id],
    )
    service.createDoc({ id: 'spec-g', kind: 'spec', title: 'Global', summary: 'resumo', body: 'corpo '.repeat(100) }, 'root')
    service.createDoc({ id: 'saber-b', kind: 'knowledge', title: 'Do beta', summary: '', body: 'corpo', projectId: 'beta' }, 'root')
    service.createResource({ id: 'skill-g', kind: 'skill', description: 'Skill global', body: 'passos' }, 'root')
    service.createResource({ id: 'cmd-b', kind: 'command', projectId: 'beta', description: 'Command do beta', body: 'faça' }, 'root')
    service.createResource({ id: 'skill-a', kind: 'skill', projectId: 'alfa', description: 'Skill do alfa', body: 'passos' }, 'root')
    service.shareResource('skill-a', ['beta'], 'root')
    return service
  }
  const shape = (items: Array<{ id: string; kind: string; description: string }>) => items.map(({ id, kind, description }) => ({ id, kind, description }))

  it('os recursos liberados saem com o mesmo id, tipo e descrição (global, do projeto e compartilhado)', () => {
    const service = seeded()
    for (const agent of ['dev-beta', 'atlas', 'inexistente'])
      for (const kind of ['skill', 'command'] as const) assert.deepStrictEqual(shape(service.usableResourceHints(kind, agent)), shape(service.usableResources(kind, agent)))
    assert.deepStrictEqual(shape(service.usableResourceHints('skill', 'dev-beta')), [
      { id: 'skill-g', kind: 'skill', description: 'Skill global' },
      { id: 'skill-a', kind: 'skill', description: 'Skill do alfa' },
    ])
  })

  it('⛔ a liberação por agente segue valendo; sem corpo na resposta', () => {
    const service = seeded()
    service.setAgentResources('dev-beta', { skills: ['skill-g'], commands: [] }, 'root')
    assert.deepStrictEqual(shape(service.usableResourceHints('skill', 'dev-beta')), [{ id: 'skill-g', kind: 'skill', description: 'Skill global' }])
    assert.deepStrictEqual(service.usableResourceHints('command', 'dev-beta'), [])
    assert.strictEqual('body' in service.usableResourceHints('skill', 'dev-beta')[0], false)
  })

  it('os documentos saem com id, tipo, título e resumo, na mesma ordem', () => {
    const service = seeded()
    const full = (scope: string | null) => service.docs(scope).map(({ id, kind, title, summary }) => ({ id, kind, title, summary }))
    const hints = (scope: string | null) => service.docHints(scope).map(({ id, kind, title, summary }) => ({ id, kind, title, summary }))
    assert.deepStrictEqual(hints(null), full(null))
    assert.deepStrictEqual(hints('beta'), full('beta'))
    assert.strictEqual('body' in service.docHints(null)[0], false)
  })
})
