import { describe, expect, it } from 'vitest'
import {
  batchName,
  bytesLabel,
  citedBy,
  countByCatalog,
  countByKind,
  countByState,
  EMPTY_FILTERS,
  effectiveKind,
  exclusionsByReason,
  filterItems,
  groupByKind,
  type IImportPlan,
  type IInventoryItem,
  ignoredDirs,
  type IPlanOutside,
  itemTokens,
  noteCodes,
  outsideByState,
  overridesFrom,
  prefixIssue,
  reachRows,
  searchIndex,
  sortItems,
  statesByKey,
  stepsByPhase,
} from './importer'

function item(partial: Partial<IInventoryItem> & Pick<IInventoryItem, 'key' | 'kind'>): IInventoryItem {
  return { candidateId: partial.key.split(':')[1] ?? partial.key, detectors: ['agents-dir'], sources: [], refs: [], unresolved: [], notes: [], ...partial }
}

const source = (path: string, tokens = 10, aliases: string[] = []) => ({ path, aliases, bytes: tokens * 4, tokens, sha256: 'abc' })

const ITEMS: IInventoryItem[] = [
  item({
    key: 'agent:maya',
    kind: 'agent',
    catalog: 'new',
    sources: [source('.agents/agents/maya/soul.md', 300)],
    refs: [{ path: '.agents/skills/deploy/SKILL.md', item: 'skill:deploy' }],
  }),
  item({
    key: 'skill:deploy',
    kind: 'skill',
    catalog: 'same-project',
    sources: [source('.agents/skills/deploy/SKILL.md', 50, ['.claude/skills/deploy/SKILL.md'])],
    notes: [{ level: 'untranslatable', code: 'skill-triggers', text: 'skill com triggers/' }],
  }),
  item({
    key: 'command:ship',
    kind: 'command',
    catalog: 'other-project',
    sources: [source('.agents/commands/ship.md', 20)],
    unresolved: ['docs/nao-existe.md'],
    refs: [{ path: '.agents/skills/deploy/SKILL.md', item: 'skill:deploy' }],
    notes: [
      { level: 'attention', code: 'broken-ref', text: 'referência quebrada: docs/nao-existe.md' },
      { level: 'attention', code: 'id-conflict', text: 'o id ship já existe em outro projeto' },
      { level: 'untranslatable', code: 'command-agent', text: 'o command escolhe o agente' },
    ],
  }),
  item({ key: 'unknown:notes/x.md', kind: 'unknown', sources: [source('notes/x.md', 5)], notes: [{ level: 'attention', code: 'unclassified', text: 'reclassifique' }] }),
  item({ key: 'spec:api', kind: 'spec', catalog: 'global', sources: [source('docs/specs/api.md', 900)] }),
]

describe('filterItems', () => {
  it('sem filtro devolve tudo', () => {
    expect(filterItems(ITEMS, EMPTY_FILTERS)).toHaveLength(ITEMS.length)
  })

  it('por tipo, pelo tipo reclassificado', () => {
    expect(filterItems(ITEMS, { ...EMPTY_FILTERS, kind: 'spec' }).map((entry) => entry.key)).toEqual(['spec:api'])
    expect(filterItems(ITEMS, { ...EMPTY_FILTERS, kind: 'spec' }, { 'unknown:notes/x.md': 'spec' }).map((entry) => entry.key)).toEqual(['unknown:notes/x.md', 'spec:api'])
    expect(filterItems(ITEMS, { ...EMPTY_FILTERS, kind: 'unknown' }, { 'unknown:notes/x.md': 'spec' })).toEqual([])
  })

  it('por estado no catálogo; `none` é o que não vai ao catálogo', () => {
    expect(filterItems(ITEMS, { ...EMPTY_FILTERS, catalog: 'other-project' }).map((entry) => entry.key)).toEqual(['command:ship'])
    expect(filterItems(ITEMS, { ...EMPTY_FILTERS, catalog: 'none' }).map((entry) => entry.key)).toEqual(['unknown:notes/x.md'])
  })

  it('por nota: nível ou código', () => {
    expect(filterItems(ITEMS, { ...EMPTY_FILTERS, note: 'untranslatable' }).map((entry) => entry.key)).toEqual(['skill:deploy', 'command:ship'])
    expect(filterItems(ITEMS, { ...EMPTY_FILTERS, note: 'attention' }).map((entry) => entry.key)).toEqual(['command:ship', 'unknown:notes/x.md'])
    expect(filterItems(ITEMS, { ...EMPTY_FILTERS, note: 'code:broken-ref' }).map((entry) => entry.key)).toEqual(['command:ship'])
  })

  it('a busca acha por id, chave, caminho e alias, sem caixa, com todos os termos', () => {
    const index = searchIndex(ITEMS)
    const find = (query: string) => filterItems(ITEMS, { ...EMPTY_FILTERS, query }, {}, index).map((entry) => entry.key)
    expect(find('MAYA')).toEqual(['agent:maya'])
    expect(find('.claude/skills')).toEqual(['skill:deploy'])
    expect(find('agents ship')).toEqual(['command:ship'])
    expect(find('nada-disso')).toEqual([])
  })

  it('os filtros se somam', () => {
    expect(filterItems(ITEMS, { kind: 'command', catalog: 'other-project', note: 'code:broken-ref', query: 'ship' })).toHaveLength(1)
    expect(filterItems(ITEMS, { kind: 'command', catalog: 'new', note: '', query: '' })).toHaveLength(0)
  })
})

describe('agrupamento e ordem', () => {
  it('agrupa na ordem dos tipos, com o reclassificado no grupo novo', () => {
    expect(groupByKind(ITEMS).map((group) => group.kind)).toEqual(['agent', 'skill', 'command', 'spec', 'unknown'])
    const groups = groupByKind(ITEMS, { 'unknown:notes/x.md': 'knowledge' })
    expect(groups.map((group) => group.kind)).toEqual(['agent', 'skill', 'command', 'spec', 'knowledge'])
  })

  it('ordena por tipo, por chave ou por tokens', () => {
    expect(sortItems(ITEMS, 'kind').map((entry) => entry.kind)).toEqual(['agent', 'skill', 'command', 'spec', 'unknown'])
    expect(sortItems(ITEMS, 'key')[0].key).toBe('agent:maya')
    expect(sortItems(ITEMS, 'tokens').map((entry) => itemTokens(entry))).toEqual([900, 300, 50, 20, 5])
  })

  it('não mexe na lista de entrada', () => {
    const before = ITEMS.map((entry) => entry.key)
    sortItems(ITEMS, 'tokens')
    expect(ITEMS.map((entry) => entry.key)).toEqual(before)
  })
})

describe('contagens', () => {
  it('por tipo (reclassificado) e por estado', () => {
    expect(countByKind(ITEMS, { 'command:ship': 'skill' })).toEqual([
      { kind: 'agent', count: 1 },
      { kind: 'skill', count: 2 },
      { kind: 'spec', count: 1 },
      { kind: 'unknown', count: 1 },
    ])
    expect(countByCatalog(ITEMS)).toEqual({ new: 1, 'same-project': 1, global: 1, 'other-project': 1, none: 1 })
  })

  it('os códigos de nota: o mais grave primeiro, um por item', () => {
    const repeated = [
      ...ITEMS,
      item({
        key: 'skill:b',
        kind: 'skill',
        notes: [
          { level: 'attention', code: 'broken-ref', text: 'a' },
          { level: 'attention', code: 'broken-ref', text: 'b' },
        ],
      }),
    ]
    const codes = noteCodes(repeated)
    expect(codes.slice(0, 2).map((entry) => entry.level)).toEqual(['untranslatable', 'untranslatable'])
    expect(codes.find((entry) => entry.code === 'broken-ref')).toEqual({ code: 'broken-ref', level: 'attention', count: 2 })
  })

  it('quem cita cada item, sem repetir', () => {
    const map = citedBy(ITEMS)
    expect(map.get('skill:deploy')).toEqual(['agent:maya', 'command:ship'])
    expect(map.has('agent:maya')).toBe(false)
  })

  it('pastas ignoradas, as mais cheias primeiro', () => {
    expect(ignoredDirs({ '.git': 3, node_modules: 120, dist: 3 })).toEqual([
      { name: 'node_modules', count: 120 },
      { name: '.git', count: 3 },
      { name: 'dist', count: 3 },
    ])
  })

  it('o tipo em vigor e o tamanho legível', () => {
    expect(effectiveKind(ITEMS[3], { [ITEMS[3].key]: 'rule' })).toBe('rule')
    expect(effectiveKind(ITEMS[3], {})).toBe('unknown')
    expect(bytesLabel(512)).toBe('512 B')
    expect(bytesLabel(2048)).toBe('2,0 KB')
  })
})

describe('o lote', () => {
  const plan = {
    phases: [
      { phase: 1, label: 'docs', steps: 1 },
      { phase: 2, label: 'skills', steps: 0 },
      { phase: 4, label: 'agente', steps: 1 },
    ],
    steps: [
      { phase: 4, key: 'agent:ana' },
      { phase: 1, key: 'spec:a' },
    ],
    reach: { translation: { lines: [{ key: 'bash' }], added: [{ key: 'read' }] } },
    project: { lines: [{ key: 'skill' }] },
  } as unknown as IImportPlan

  it('agrupa os passos por fase, só as fases com passo', () => {
    expect(stepsByPhase(plan).map((group) => [group.phase, group.steps.map((step) => step.key)])).toEqual([
      [1, ['spec:a']],
      [4, ['agent:ana']],
    ])
  })

  it('o alcance numa tabela só, com a camada', () => {
    expect(reachRows(plan).map((row) => `${row.layer} ${row.key}`)).toEqual(['agente bash', 'acrescentada read', 'projeto skill'])
  })

  it('o que fica de fora por motivo, o grave primeiro', () => {
    const groups = exclusionsByReason([
      { from: 'a', reason: 'config', text: '' },
      { from: 'b', reason: 'broken', text: '' },
    ])
    expect(groups.map((group) => group.reason)).toEqual(['broken', 'config'])
  })

  it('o prefixo segue o padrão do servidor', () => {
    expect(prefixIssue('')).toBeUndefined()
    expect(prefixIssue('akm-')).toBeUndefined()
    expect(prefixIssue('a b')).toBeTruthy()
    expect(prefixIssue('x'.repeat(17))).toBeTruthy()
  })
})

describe('trabalho de importação', () => {
  const states = [
    { key: 'unknown:notes/x.md', state: 'pending' as const, kind: 'spec' as const, fingerprint: 'f' },
    { key: 'command:ship', state: 'skipped' as const, fingerprint: 'f' },
    { key: 'skill:deploy', state: 'stale' as const, staleFrom: 'approved' as const, fingerprint: 'f' },
  ]

  it('a reclassificação gravada vira o tipo da tela', () => {
    expect(overridesFrom(states)).toEqual({ 'unknown:notes/x.md': 'spec' })
  })

  it('filtra pelo estado; item sem estado conta como a importar', () => {
    const map = statesByKey(states)
    expect(filterItems(ITEMS, { ...EMPTY_FILTERS, state: 'skipped' }, {}, undefined, map).map((entry) => entry.key)).toEqual(['command:ship'])
    const pending = filterItems(ITEMS, { ...EMPTY_FILTERS, state: 'pending' }, {}, undefined, map).map((entry) => entry.key)
    expect(pending).not.toContain('command:ship')
    expect(pending).not.toContain('skill:deploy')
    expect(pending).toContain('agent:maya')
    expect(filterItems(ITEMS, { ...EMPTY_FILTERS, state: 'pending' }, {}, undefined, new Map())).toHaveLength(ITEMS.length)
  })

  it('conta por estado na ordem da tela, só os que têm', () => {
    expect(countByState({ skipped: 2, pending: 3, stale: 1 })).toEqual([
      { state: 'pending', count: 3 },
      { state: 'stale', count: 1 },
      { state: 'skipped', count: 2 },
    ])
  })
})

describe('importer — o lote por seleção', () => {
  it('as citações para fora, por estado: as que pedem ação primeiro', () => {
    const entry = (state: IPlanOutside['state'], from: string): IPlanOutside => ({ from, state, text: state })
    const groups = outsideByState([entry('catalog', 'a'), entry('missing', 'b'), entry('broken', 'c'), entry('missing', 'd')])
    expect(groups.map((group) => `${group.state} ${group.entries.length}`)).toEqual(['broken 1', 'missing 2', 'catalog 1'])
  })

  it('o nome sugerido: o tipo quando é um só (com a reclassificação), e quantos', () => {
    const one = (key: string, kind: IInventoryItem['kind']): IInventoryItem => ({ key, kind, candidateId: key, detectors: [], sources: [], refs: [], unresolved: [], notes: [] })
    expect(batchName([one('knowledge:a', 'knowledge'), one('knowledge:b', 'knowledge')])).toBe('Knowledge (2)')
    expect(batchName([one('knowledge:a', 'knowledge'), one('unknown:b', 'unknown')])).toBe('Seleção (2)')
    expect(batchName([one('knowledge:a', 'knowledge'), one('unknown:b', 'unknown')], { 'unknown:b': 'knowledge' })).toBe('Knowledge (2)')
  })
})
