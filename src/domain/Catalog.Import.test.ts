import assert from 'node:assert'
import { describe, it } from 'node:test'
import { mcpDocument, resourceDocument } from './Catalog.Document'
import { attentionsOf, importOrder, IOrderInput, normalizeDocument, planHashOf, referencesOf, withBody } from './Catalog.Import'

const at = new Date('2026-10-30T12:00:00.000Z')

describe('normalizeDocument', () => {
  it('volta à forma canônica: conjunto ordenado, derivado recalculado, mesmo hash do leitor', () => {
    const skill = resourceDocument({ id: 'deploy', kind: 'skill', description: 'D', body: 'B', docIds: ['b', 'a'], docRefs: ['b', 'a'], createdAt: at, updatedAt: at })
    const messy = withBody(skill, { ...skill.body, docRefs: ['b', 'a'] })
    assert.notStrictEqual(messy.hash, skill.hash)
    assert.strictEqual(normalizeDocument(messy).document?.hash, skill.hash)

    const mcp = mcpDocument({ id: 'busca', name: 'B', url: 'https://x.example.com/', transport: 'auto', auth: 'header', enabled: true, createdAt: at, updatedAt: at })
    const lying = withBody(mcp, { ...mcp.body, secrets: [] })
    assert.deepStrictEqual(normalizeDocument(lying).document?.body.secrets, ['header'])
  })

  it('campo fora da forma, tipo errado e chave que não bate com o corpo viram problema', () => {
    const skill = resourceDocument({ id: 'deploy', kind: 'skill', description: 'D', body: 'B', docIds: [], createdAt: at, updatedAt: at })
    assert.deepStrictEqual(normalizeDocument(withBody(skill, { ...skill.body, createdAt: 'x', docIds: 'a' })).issues, [
      { field: 'docIds', message: 'expected a list of values' },
      { field: 'createdAt', message: 'not a field of the catalog document' },
    ])
    assert.deepStrictEqual(normalizeDocument(withBody({ kind: 'skill', id: 'outro' }, skill.body)).issues, [{ field: 'id', message: 'differs from the item (outro)' }])
    assert.deepStrictEqual(normalizeDocument(withBody({ kind: 'skill', id: 'deploy', projectId: 'alfa' }, skill.body)).issues, [
      { field: 'projectId', message: 'differs from the item scope' },
    ])
  })
})

describe('referencesOf e attentionsOf', () => {
  it('o agente cita recursos, specs, MCPs (no escopo dele), agentes e o projeto', () => {
    const agent = withBody(
      { kind: 'agent', id: 'theo', projectId: 'alfa' },
      { id: 'theo', projectId: 'alfa', allowedTools: ['mcp:busca/*', 'agent:lia', 'cap:terminal'], resources: { skills: ['*'], commands: ['cmd'] }, initialContext: ['spec-a'] },
    )
    assert.deepStrictEqual(
      referencesOf(agent).map((ref) => `${ref.field} ${ref.target}:${ref.id}${ref.projectId ? `@${ref.projectId}` : ''}`),
      ['projectId project:alfa', 'resources.commands command:cmd', 'initialContext spec:spec-a', 'allowedTools mcp:busca@alfa', 'allowedTools agent:lia'],
    )
  })

  it('atenção: prompt e modelo do agente, reordenação das permissões, skill global nova', () => {
    const before = withBody({ kind: 'agent', id: 'theo' }, { id: 'theo', systemPrompt: 'A', providers: [{ provider: 'claude', models: ['opus'] }] })
    const after = withBody(before, { ...before.body, systemPrompt: 'B', providers: [{ provider: 'claude', models: ['sonnet'] }] })
    assert.deepStrictEqual(
      attentionsOf(before, after).map((item) => item.key),
      ['agent/theo#systemPrompt~', 'agent/theo#providers~'],
    )
    const rules = [
      { category: 'terminal', pattern: 'ls', decision: 'allow' },
      { category: 'terminal', pattern: 'rm *', decision: 'deny' },
    ]
    const perms = withBody({ kind: 'project-permissions', id: 'alfa', projectId: 'alfa' }, { projectId: 'alfa', rules })
    assert.deepStrictEqual(
      attentionsOf(perms, withBody(perms, { projectId: 'alfa', rules: [...rules].reverse() })).map((item) => item.key),
      ['project-permissions/alfa#rules~order'],
    )
    const skill = resourceDocument({ id: 'x', kind: 'skill', description: 'D', body: 'B', docIds: [], createdAt: at, updatedAt: at })
    assert.deepStrictEqual(
      attentionsOf(undefined, skill).map((item) => item.key),
      ['skill/x#new-global'],
    )
  })
})

describe('importOrder', () => {
  const step = (ref: string, patch: Partial<IOrderInput> = {}): IOrderInput => {
    const [kind, id] = ref.split('/') as [IOrderInput['kind'], string]
    return { ref, kind, id, op: 'create', widens: false, dependsOn: [], ...patch }
  }

  it('fases fixas; citado antes; restringe antes de ampliar; ciclo marcado e não trava', () => {
    const order = importOrder([
      step('project-permissions/alfa', { widens: true }),
      step('agent/b', { widens: true }),
      step('agent/a', { dependsOn: ['agent/b'] }),
      step('agent/c'),
      step('spec/x', { dependsOn: ['spec/y'] }),
      step('spec/y', { dependsOn: ['spec/x'] }),
      step('mcp/m', { widens: true }),
    ])
    assert.deepStrictEqual(
      order.map((item) => `${item.phase}:${item.ref}${item.cycle ? '!' : ''}`),
      ['docs:spec/x!', 'docs:spec/y', 'mcps:mcp/m', 'agents:agent/c', 'agents:agent/b', 'agents:agent/a', 'permissions:project-permissions/alfa'],
    )
  })
})

describe('planHashOf', () => {
  it('a ordem de entrada não importa; o estado atual e o resultado importam', () => {
    const base = {
      scope: 'all',
      documents: [
        { ref: 'spec/a', hash: '1' },
        { ref: 'spec/b', hash: '2' },
      ],
      fileErrors: [],
      current: [{ ref: 'spec/a', hash: '0' }, { ref: 'spec/b' }],
      items: [
        { ref: 'spec/a', op: 'update' as const, hash: '1', widenings: [], issues: [], missingSecrets: [] },
        { ref: 'spec/b', op: 'create' as const, hash: '2', widenings: [], issues: [], missingSecrets: [] },
      ],
    }
    const hash = planHashOf(base)
    assert.strictEqual(planHashOf({ ...base, documents: [...base.documents].reverse(), items: [...base.items].reverse(), current: [...base.current].reverse() }), hash)
    assert.notStrictEqual(planHashOf({ ...base, current: [{ ref: 'spec/a', hash: 'x' }, { ref: 'spec/b' }] }), hash)
    assert.notStrictEqual(planHashOf({ ...base, items: [{ ...base.items[0], op: 'error' }, base.items[1]] }), hash)
  })
})
