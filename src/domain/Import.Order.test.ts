import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentClosure, IAgentBatchInput, orderBatch, planAgentBatch, prefixedId, proposeIds } from './Import.Order'
import { IInventoryItem, TCatalogState } from './models/ImportInventory.Model'

/** Um item do inventário sintético: a fonte é `<chave>.md` com os tokens dados. */
function item(key: string, partial: Partial<IInventoryItem> = {}, tokens = 10): IInventoryItem {
  const [kind, rest] = key.split(':') as [IInventoryItem['kind'], string]
  return {
    key,
    kind,
    candidateId: rest.includes('/') ? rest.split('/')[1] : rest,
    detectors: ['agents-dir'],
    sources: [{ path: `${rest}.md`, aliases: [], bytes: tokens * 4, tokens, sha256: 'a'.repeat(64) }],
    refs: [],
    unresolved: [],
    catalog: kind === 'unknown' || kind === 'skip' || kind === 'config' ? undefined : 'new',
    notes: [],
    ...partial,
  }
}
const cites = (...keys: string[]) => keys.map((key) => ({ path: `${key.split(':')[1]}.md`, item: key }))

const ITEMS: IInventoryItem[] = [
  item('agent:ana', { refs: [...cites('spec:base', 'agent:bia', 'trigger:ana/01-revisar', 'unknown:solto'), { path: 'docs/sem-item.md' }], unresolved: ['specs/sumiu.md'] }),
  item('trigger:ana/01-revisar', { parent: 'agent:ana', refs: cites('skill:revisar', 'command:publicar') }),
  item('trigger:ana/02-ciclo', { parent: 'agent:ana', refs: cites('spec:ciclo-a') }),
  item('agent:bia'),
  item('trigger:bia/01-outro', { parent: 'agent:bia', refs: cites('spec:so-da-bia') }),
  item('skill:revisar', { refs: cites('spec:guia') }),
  item('skill:liberada'),
  item('skill:outra-liberada', {}, 50),
  item('command:publicar', { refs: cites('spec:guia', 'agent:ana'), notes: [{ level: 'untranslatable', code: 'command-agent', text: 'o command escolhe o agente' }] }),
  item('spec:base', { refs: cites('rule:regras') }),
  item('spec:guia', { refs: cites('knowledge:fila') }),
  item('spec:ciclo-a', { refs: cites('spec:ciclo-b') }),
  item('spec:ciclo-b', { refs: cites('spec:ciclo-a') }),
  item('spec:so-da-bia'),
  item('spec:inst', {}),
  item('knowledge:fila'),
  item('rule:regras', { title: 'Regras' }),
  item('unknown:solto'),
  item('mcp:github', { catalog: 'global' }),
  item('config:opencode', { refs: [...cites('spec:inst'), ...cites('spec:so-da-bia')], unresolved: ['nada/x.md', 'outro/sem-par.md'] }),
]

describe('Import.Order — o fecho de um agente', () => {
  const { members, excluded } = agentClosure(ITEMS, 'agent:ana', { from: 'config:opencode', paths: ['inst.md'], unresolved: ['nada/x.md'] })

  it('o agente, os triggers dele e o que eles citam, transitivo (skill → spec → knowledge; spec → rule)', () => {
    assert.deepStrictEqual([...members.keys()].sort(), [
      'agent:ana',
      'command:publicar',
      'knowledge:fila',
      'rule:regras',
      'skill:revisar',
      'spec:base',
      'spec:ciclo-a',
      'spec:ciclo-b',
      'spec:guia',
      'spec:inst',
      'trigger:ana/01-revisar',
      'trigger:ana/02-ciclo',
    ])
    assert.strictEqual(members.get('trigger:ana/01-revisar')!.why, 'trigger')
    assert.deepStrictEqual([...members.get('spec:guia')!.citedBy].sort(), ['command:publicar', 'skill:revisar'])
  })

  it('as instructions entram só pelos caminhos delas (não o resto do que a configuração cita)', () => {
    assert.strictEqual(members.get('spec:inst')!.why, 'instructions')
    assert.ok(!members.has('spec:so-da-bia'))
    assert.ok(excluded.some((entry) => entry.from === 'config:opencode' && entry.reason === 'broken' && entry.path === 'nada/x.md'))
    assert.ok(!excluded.some((entry) => entry.path === 'outro/sem-par.md'))
  })

  it('o que fica de fora, com o motivo: citação quebrada, sem item, outro agente, desconhecido, não traduz', () => {
    const reasons = excluded.filter((entry) => entry.from !== 'config:opencode').map((entry) => `${entry.from} ${entry.reason} ${entry.path ?? entry.code}`)
    assert.deepStrictEqual(reasons.sort(), [
      'agent:ana broken specs/sumiu.md',
      'agent:ana no-item docs/sem-item.md',
      'agent:ana other-agent bia.md',
      'agent:ana unclassified solto.md',
      'command:publicar untranslatable command-agent',
    ])
    assert.ok(!members.has('agent:bia') && !members.has('trigger:bia/01-outro'))
  })
})

describe('Import.Order — a ordem por fase e os ciclos', () => {
  const { members } = agentClosure(ITEMS, 'agent:ana')
  const { order, cycles, deps } = orderBatch(ITEMS, members.keys())

  it('docs → skills/commands → rules → agente → triggers; dentro da fase, quem é citado antes', () => {
    assert.deepStrictEqual(order, [
      'knowledge:fila',
      'spec:base',
      // O ciclo só é quebrado quando nada mais está pronto: a guia (pronta) entra antes.
      'spec:guia',
      'spec:ciclo-a',
      'spec:ciclo-b',
      'skill:revisar',
      'command:publicar',
      'rule:regras',
      'agent:ana',
      'trigger:ana/01-revisar',
      'trigger:ana/02-ciclo',
    ])
    // A spec cita a rule (fase posterior): não é dependência que reordena, fica para o mapa de ids.
    assert.deepStrictEqual(deps.get('spec:base'), ['rule:regras'])
  })

  it('o ciclo dentro da fase é reportado e quebrado pela ordem; o agente não depende dos próprios triggers', () => {
    assert.deepStrictEqual(
      cycles.map((cycle) => [cycle.keys, cycle.brokenBy]),
      [[['spec:ciclo-a', 'spec:ciclo-b'], 'order']],
    )
    assert.match(cycles[0].text, /spec:ciclo-a entra antes/)
    assert.ok(!deps.get('agent:ana')!.includes('trigger:ana/01-revisar'))
    assert.ok(deps.get('trigger:ana/01-revisar')!.includes('agent:ana'))
  })

  it('a citação que volta para uma fase anterior não é ciclo (o command cita o agente)', () => {
    assert.ok(!cycles.some((cycle) => cycle.keys.includes('command:publicar')))
  })
})

describe('Import.Order — o mapa de ids', () => {
  const catalog = (states: Record<string, TCatalogState>) => (query: { kind: string; id: string; parent?: string }) =>
    states[`${query.kind}:${query.parent ? `${query.parent}/` : ''}${query.id}`] ?? 'new'

  it('o prefixo vai nos tipos de id legível; rule e trigger ficam como estão (o trigger mora no agente prefixado)', () => {
    const map = proposeIds(ITEMS, ['agent:ana', 'trigger:ana/01-revisar', 'skill:revisar', 'spec:base', 'rule:regras', 'knowledge:fila', 'command:publicar'], 'akm-', catalog({}))
    assert.deepStrictEqual(
      map.map((entry) => [entry.key, entry.id, entry.prefixed]),
      [
        ['agent:ana', 'akm-ana', true],
        ['trigger:ana/01-revisar', '01-revisar', false],
        ['skill:revisar', 'akm-revisar', true],
        ['spec:base', 'akm-base', true],
        ['rule:regras', 'regras', false],
        ['knowledge:fila', 'akm-fila', true],
        ['command:publicar', 'akm-publicar', true],
      ],
    )
    assert.strictEqual(map[1].parent, 'akm-ana')
  })

  it('o prefixo que estoura o limite corta o id e avisa', () => {
    assert.deepStrictEqual(prefixedId('skill', 'x'.repeat(45), 'akm-'), { id: `akm-${'x'.repeat(44)}`, cut: true })
    const long = item(`skill:${'y'.repeat(46)}`)
    const [entry] = proposeIds([long], [long.key], 'akm-', catalog({}))
    assert.strictEqual(entry.cut, true)
    assert.match(entry.reason ?? '', /cortado/)
  })

  it('colisão: outro projeto e global BLOQUEIAM, o mesmo projeto atualiza; com o prefixo, quem conta é o id novo', () => {
    const items = [item('spec:base', { catalog: 'other-project' }), item('skill:revisar', { catalog: 'global' }), item('agent:ana', { catalog: 'same-project' })]
    const plain = proposeIds(
      items,
      items.map((one) => one.key),
      '',
      catalog({}),
    )
    assert.deepStrictEqual(
      plain.map((entry) => entry.state),
      ['conflict', 'conflict', 'update'],
    )
    const prefixed = proposeIds(
      items,
      items.map((one) => one.key),
      'akm-',
      catalog({ 'skill:akm-revisar': 'other-project' }),
    )
    assert.deepStrictEqual(
      prefixed.map((entry) => entry.state),
      ['new', 'conflict', 'new'],
    )
  })

  it('dois itens do lote no mesmo id do mesmo espaço (spec e knowledge são docs) ficam duplicados', () => {
    const items = [item('spec:guia'), item('knowledge:guia'), item('skill:guia')]
    const map = proposeIds(
      items,
      items.map((one) => one.key),
      '',
      catalog({}),
    )
    assert.deepStrictEqual(
      map.map((entry) => entry.state),
      ['duplicate', 'duplicate', 'new'],
    )
  })
})

describe('Import.Order — o lote com o alcance traduzido', () => {
  const reach = new Map<string, NonNullable<ReturnType<IAgentBatchInput['reach']['get']>>>([
    [
      'agent:ana',
      {
        name: 'ana',
        permission: { skill: { '*': 'deny', 'liberada*': 'allow', 'outra-*': 'allow' }, task: { bia: 'allow', caio: 'allow' }, mcp: { 'github_*': 'allow' } },
        tools: { github_list: true },
      },
    ],
    ['agent:bia', { name: 'bia', permission: { task: { ana: 'allow' } } }],
    ['config:opencode', { name: 'opencode', permission: { skill: 'allow', bash: { 'rm *': 'deny' } } }],
  ])
  const input = (partial: Partial<IAgentBatchInput> = {}): IAgentBatchInput => ({
    items: [...ITEMS, item('agent:caio', { catalog: 'same-project' })],
    agent: 'agent:ana',
    reach,
    agentByName: new Map([
      ['ana', 'agent:ana'],
      ['bia', 'agent:bia'],
      ['caio', 'agent:caio'],
    ]),
    catalog: () => 'new',
    protocolTokens: (kind) => (kind === 'trigger' || kind === 'agent' ? 200 : 100),
    ...partial,
  })

  it('resources.skills = as skills que o agente libera; a citada e não liberada fica de fora; as liberadas e não citadas ficam à parte', () => {
    const plan = planAgentBatch(input())
    assert.deepStrictEqual(plan.reach?.skills.proposed, ['liberada', 'outra-liberada'])
    assert.strictEqual(plan.reach?.skills.from, 'agent-rules')
    assert.deepStrictEqual(plan.reach?.skills.notReleased, ['revisar'])
    assert.deepStrictEqual(
      plan.released.map((one) => one.key),
      ['skill:liberada', 'skill:outra-liberada'],
    )
    assert.ok(!plan.steps.some((step) => step.key === 'skill:liberada'), 'liberar não é usar: fora do lote')
    assert.deepStrictEqual(plan.estimate.released, { conversations: 2, inputTokens: 10 + 50 + 2 * 100 })
  })

  it('⛔ o `skill * allow` do global é ampliação a confirmar, nunca automática', () => {
    const plan = planAgentBatch(input())
    assert.ok(plan.project?.widenings.some((widening) => widening.rule.category === 'skill' && widening.rule.pattern === '*'))
    assert.ok(plan.project?.notes.some((note) => note.code === 'project-skill-all' && note.level === 'attention'))
    // O agente sem a negação de base cairia no projeto: a tradução avisa, e a lista de skills fecha.
    assert.match(plan.reach!.translation.lines.find((line) => line.key === 'skill' && line.pattern === '*')!.reason, /o projeto libera/)
  })

  it('sem regra de skill no agente, a proposta são as que ele cita (`*` seria ampliação)', () => {
    const plan = planAgentBatch(input({ reach: new Map([...reach, ['agent:ana', { name: 'ana' }]]) }))
    assert.strictEqual(plan.reach?.skills.from, 'cited')
    assert.deepStrictEqual(plan.reach?.skills.proposed, ['revisar'])
    assert.match(plan.reach!.skills.note, /skill \* allow/)
  })

  it('vínculos (fase 5): o alvo que existe entra, o que falta fica pendente, o ciclo de delegação não trava', () => {
    const plan = planAgentBatch(input())
    assert.deepStrictEqual(
      plan.links.map((link) => [link.name, link.state, link.cycle]),
      [
        ['bia', 'pending', true],
        ['caio', 'exists', false],
      ],
    )
    assert.ok(plan.reach!.translation.allowedTools.includes('agent:caio'))
    assert.ok(!plan.reach!.translation.allowedTools.includes('agent:bia'))
    assert.ok(plan.reach!.translation.lines.some((line) => line.key === 'task' && line.pattern === 'bia' && line.status === 'none'))
  })

  it('o MCP usado que existe no gateway vira ferramenta liberada; as fases 5 a 7 não têm conversa', () => {
    const plan = planAgentBatch(input())
    assert.deepStrictEqual(plan.mcps, [{ name: 'github', key: 'mcp:github', id: 'github', exists: true }])
    assert.ok(plan.reach!.translation.allowedTools.includes('mcp:github/list'))
    assert.deepStrictEqual(
      plan.phases.map((phase) => phase.steps),
      [5, 2, 1, 3, 0, 0, 0],
    )
  })

  it('a estimativa: uma conversa por item, fontes + protocolo; o id em conflito bloqueia', () => {
    const plan = planAgentBatch(input({ items: [...ITEMS.map((one) => (one.key === 'spec:base' ? { ...one, catalog: 'other-project' as const } : one)), item('agent:caio')] }))
    assert.strictEqual(plan.estimate.conversations, plan.steps.length)
    assert.strictEqual(
      plan.estimate.protocolTokens,
      plan.steps.reduce((sum, step) => sum + step.tokens.protocol, 0),
    )
    assert.strictEqual(plan.estimate.inputTokens, plan.estimate.sourceTokens + plan.estimate.protocolTokens)
    assert.deepStrictEqual(plan.estimate.byKind.trigger, { conversations: 2, inputTokens: 2 * 10 + 2 * 200 })
    assert.deepStrictEqual(plan.blocked, ['spec:base: o id base já existe em outro projeto: mude antes de transformar'])
  })

  it('sem alcance do opencode: o agente nasce fechado e não há tradução nem permissão de projeto', () => {
    const plan = planAgentBatch(input({ reach: new Map() }))
    assert.strictEqual(plan.reach, undefined)
    assert.strictEqual(plan.project, undefined)
    assert.deepStrictEqual(plan.links, [])
    assert.ok(plan.notes.some((note) => note.code === 'reach-none'))
  })
})
