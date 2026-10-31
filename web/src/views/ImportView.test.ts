import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import type { IImportBatchView, IImportItemStatus, IImportJob, IImportJobSummary, IImportPlan, IImportScan, IInventoryItem, ISelectionPlan } from '@/lib/importer'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import ImportView from './ImportView.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

function item(partial: Partial<IInventoryItem> & Pick<IInventoryItem, 'key' | 'kind'>): IInventoryItem {
  return { candidateId: partial.key.split(':')[1], detectors: ['agents-dir'], sources: [], refs: [], unresolved: [], notes: [], ...partial }
}

function scan(items: IInventoryItem[]): IImportScan {
  return {
    projectId: 'alfa',
    repository: 'app',
    head: '0123456789abcdef',
    dirty: true,
    scannedAt: '2026-10-30T12:00:00.000Z',
    formats: ['agents-dir', 'opencode'],
    totals: { files: 9, items: items.length, tokens: 1200, byKind: {} },
    ignored: { dirs: { node_modules: 40 }, binaries: [], links: [{ path: '.agents/fora', reason: 'outside' }] },
    items,
  }
}

const SMALL = [
  item({
    key: 'skill:deploy',
    kind: 'skill',
    catalog: 'new',
    sources: [{ path: '.agents/skills/deploy/SKILL.md', aliases: ['.claude/skills/deploy/SKILL.md'], bytes: 400, tokens: 100, sha256: 'f'.repeat(64), secret: true }],
    notes: [{ level: 'untranslatable', code: 'skill-triggers', text: 'a skill tem triggers/' }],
  }),
  item({
    key: 'command:ship',
    kind: 'command',
    catalog: 'other-project',
    sources: [{ path: '.agents/commands/ship.md', aliases: [], bytes: 80, tokens: 20, sha256: 'a'.repeat(64) }],
    refs: [{ path: '.agents/skills/deploy/SKILL.md', item: 'skill:deploy' }],
    unresolved: ['docs/sumiu.md'],
    notes: [{ level: 'attention', code: 'broken-ref', text: 'referência quebrada: docs/sumiu.md' }],
  }),
  item({ key: 'unknown:notes/x.md', kind: 'unknown', sources: [{ path: 'notes/x.md', aliases: [], bytes: 10, tokens: 3, sha256: 'b'.repeat(64) }] }),
]

async function flush() {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

const PLAN: IImportPlan = {
  projectId: 'alfa',
  repository: 'app',
  plannedAt: '2026-10-30T12:00:00.000Z',
  agent: 'agent:ana',
  prefix: '',
  phases: [
    { phase: 1, label: 'docs: knowledge, specs e ADRs', steps: 1 },
    { phase: 2, label: 'skills e commands', steps: 0 },
    { phase: 3, label: 'rules do projeto', steps: 0 },
    { phase: 4, label: 'agente fechado, com os triggers', steps: 2 },
    { phase: 5, label: 'vínculos entre agentes', steps: 0 },
    { phase: 6, label: 'alcance do agente (confirmado)', steps: 0 },
    { phase: 7, label: 'permissões do projeto (confirmadas)', steps: 0 },
  ],
  steps: [
    {
      phase: 1,
      key: 'spec:base',
      kind: 'spec',
      id: 'base',
      why: 'cited',
      citedBy: ['agent:ana'],
      dependsOn: [],
      forward: [],
      tokens: { sources: 100, protocol: 1000 },
      state: 'conflict',
      notes: [],
    },
    {
      phase: 4,
      key: 'agent:ana',
      kind: 'agent',
      id: 'ana',
      why: 'agent',
      citedBy: [],
      dependsOn: ['spec:base'],
      forward: [],
      tokens: { sources: 300, protocol: 2000 },
      state: 'new',
      notes: [],
    },
    {
      phase: 4,
      key: 'trigger:ana/01',
      kind: 'trigger',
      id: '01',
      why: 'trigger',
      citedBy: ['agent:ana'],
      dependsOn: ['agent:ana'],
      forward: [],
      tokens: { sources: 50, protocol: 2000 },
      state: 'new',
      notes: [],
    },
  ],
  links: [{ name: 'bia', key: 'agent:bia', id: 'bia', state: 'pending', cycle: true, text: 'pendente' }],
  reach: {
    format: 'opencode',
    sourceName: 'ana',
    translation: {
      lines: [
        { origin: 'agent', key: 'skill', pattern: '*', action: 'deny', rules: [], status: 'changed', reason: 'omitida' },
        {
          origin: 'agent',
          key: 'bash',
          pattern: '*',
          action: 'allow',
          rules: [{ category: 'terminal', pattern: '*', decision: 'allow' }],
          status: 'direct',
          reason: '',
          widening: 'terminal amplo: qualquer comando',
        },
        { origin: 'agent', key: 'webfetch', pattern: '*', action: 'allow', rules: [], status: 'none', reason: 'sem equivalente' },
      ],
      added: [],
      rules: [{ category: 'terminal', pattern: '*', decision: 'allow' }],
      widenings: [{ rule: { category: 'terminal', pattern: '*', decision: 'allow' }, reason: 'terminal amplo: qualquer comando' }],
      tools: [],
      allowedTools: ['cap:terminal'],
      totals: { direct: 1, changed: 1, none: 1 },
    },
    skills: { proposed: ['akm-revisar'], from: 'agent-rules', notReleased: [], pending: [], note: 'as 1 skill(s) que as regras do agente liberam' },
    notes: [{ level: 'info', code: 'reach-closed', text: 'o agente nasce FECHADO' }],
  },
  project: {
    lines: [
      {
        origin: 'project',
        key: 'skill',
        pattern: '*',
        action: 'allow',
        rules: [{ category: 'skill', pattern: '*', decision: 'allow' }],
        status: 'direct',
        reason: '',
        widening: 'qualquer skill',
      },
    ],
    widenings: [{ rule: { category: 'skill', pattern: '*', decision: 'allow' }, reason: 'qualquer skill' }],
    notes: [{ level: 'attention', code: 'project-skill-all', text: '`skill * allow` do global liberaria TODAS as skills' }],
  },
  idMap: [
    {
      key: 'spec:base',
      kind: 'spec',
      sourceId: 'base',
      id: 'base',
      prefixed: false,
      cut: false,
      catalog: 'other-project',
      state: 'conflict',
      reason: 'o id base já existe em outro projeto',
    },
    { key: 'agent:ana', kind: 'agent', sourceId: 'ana', id: 'ana', prefixed: false, cut: false, catalog: 'new', state: 'new' },
  ],
  excluded: [{ from: 'agent:ana', reason: 'broken', path: 'specs/sumiu.md', text: 'citação quebrada: specs/sumiu.md' }],
  released: [{ key: 'skill:outra', id: 'outra', tokens: 10 }],
  mcps: [],
  cycles: [],
  estimate: {
    conversations: 3,
    inputTokens: 5450,
    sourceTokens: 450,
    protocolTokens: 5000,
    byKind: { spec: { conversations: 1, inputTokens: 1100 }, agent: { conversations: 1, inputTokens: 2300 }, trigger: { conversations: 1, inputTokens: 2050 } },
    released: { conversations: 1, inputTokens: 1010 },
    note: '≈ entrada da primeira volta',
  },
  blocked: ['spec:base: o id base já existe em outro projeto'],
  notes: [],
}

/** O lote da seleção que o "servidor" devolve: a ordem só entre os escolhidos, as citações para fora e a estimativa. */
function selectionPlan(keys: string[], prefix = ''): ISelectionPlan {
  return {
    keys,
    prefix,
    phases: PLAN.phases.map((phase) => ({ ...phase, steps: phase.phase === 2 ? 1 : 0 })),
    steps: [
      {
        phase: 2,
        key: 'skill:deploy',
        kind: 'skill',
        id: `${prefix}deploy`,
        why: 'selected',
        citedBy: ['command:ship'],
        dependsOn: [],
        forward: [],
        tokens: { sources: 100, protocol: 1000 },
        state: 'update',
        done: 'catalog',
        notes: [],
      },
      {
        phase: 2,
        key: 'command:ship',
        kind: 'command',
        id: `${prefix}ship`,
        why: 'selected',
        citedBy: [],
        dependsOn: ['skill:deploy'],
        forward: [],
        tokens: { sources: 20, protocol: 1000 },
        state: 'new',
        notes: [],
      },
    ].filter((step) => keys.includes(step.key)) as ISelectionPlan['steps'],
    idMap: [],
    cycles: [{ keys: ['spec:a', 'spec:b'], brokenBy: 'order', text: 'ciclo de citações entre spec:a, spec:b' }],
    outside: [
      { from: 'command:ship', state: 'broken', path: 'docs/sumiu.md', text: 'citação quebrada: docs/sumiu.md não existe no repositório' },
      { from: 'command:ship', state: 'batch', item: 'spec:guia', id: 'guia', batch: { id: 'b0', name: 'docs' }, text: 'em outro lote deste trabalho: docs' },
    ],
    excluded: [],
    estimate: {
      conversations: 1,
      inputTokens: 1020,
      sourceTokens: 20,
      protocolTokens: 1000,
      byKind: { command: { conversations: 1, inputTokens: 1020 } },
      done: 1,
      released: { conversations: 0, inputTokens: 0 },
      note: '≈ entrada',
    },
    blocked: [],
    notes: [],
  }
}

let ignoreStored: string[] = []
/** Os lotes salvos de cada trabalho. */
let savedBatches: Record<string, IImportBatchView[]> = {}
/** O "servidor" dos trabalhos: os salvos (com os itens) e o estado de cada item. */
let saved: IImportJob[] = []

function summary(job: IImportJob): IImportJobSummary {
  const { scan: _scan, states, ...rest } = job
  const byState: IImportJobSummary['byState'] = {}
  for (const entry of states) byState[entry.state] = (byState[entry.state] ?? 0) + 1
  return { ...rest, byState }
}

function savedJob(id: string, items: IInventoryItem[], extra: Partial<IImportJob> = {}, states: Record<string, Partial<IImportItemStatus>> = {}): IImportJob {
  return {
    id,
    projectId: 'alfa',
    repository: 'app',
    head: '0123456789abcdef',
    dirty: true,
    scannedAt: '2026-10-30T12:00:00.000Z',
    by: 'ana@x.test',
    items: items.length,
    byState: {},
    latest: true,
    scan: scan(items),
    states: items.map((entry) => ({ key: entry.key, state: 'pending', fingerprint: 'f', ...states[entry.key] })),
    ...extra,
  }
}

async function mount(items: IInventoryItem[], options: { jobs?: IImportJob[]; analyze?: boolean; batches?: Record<string, IImportBatchView[]> } = {}): Promise<HTMLElement> {
  ignoreStored = ['.agents/benchmark']
  saved = options.jobs ?? []
  savedBatches = options.batches ?? {}
  vi.mocked(api).mockImplementation(async (path: string, request?: { method?: string; body?: unknown }) => {
    if (path.endsWith('/repositories'))
      return [
        { name: 'app', worktrees: [] },
        { name: 'lib', worktrees: [] },
      ]
    if (path.endsWith('/import/jobs') && request?.method === 'POST') {
      const previous = saved.find((entry) => entry.latest)
      const created = savedJob(
        `j${saved.length + 1}`,
        items,
        previous ? { previousId: previous.id, reuse: { from: previous.id, kept: items.length, stale: [], restored: [], added: [], gone: [] } } : {},
      )
      saved = [created, ...saved.map((entry) => ({ ...entry, latest: false }))]
      return created
    }
    if (path.endsWith('/import/jobs')) return saved.map(summary)
    const items_ = path.match(/\/import\/jobs\/([^/]+)\/items$/)
    if (items_ && request?.method === 'PATCH') {
      const body = request.body as { key: string; state?: IImportItemStatus['state']; kind?: IInventoryItem['kind'] | null }
      const job = saved.find((entry) => entry.id === items_[1])!
      const current = job.states.find((entry) => entry.key === body.key)!
      const next: IImportItemStatus = { ...current, ...(body.state ? { state: body.state } : {}), by: 'root@x.test', at: '2026-10-30T13:00:00.000Z' }
      if (body.kind !== undefined) {
        if (body.kind) next.kind = body.kind
        else delete next.kind
      }
      job.states = job.states.map((entry) => (entry.key === body.key ? next : entry))
      return next
    }
    const batchPlan = path.match(/\/import\/jobs\/([^/]+)\/batches\/plan$/)
    if (batchPlan) {
      const body = request!.body as { keys: string[]; prefix?: string }
      return selectionPlan(body.keys, body.prefix)
    }
    const batchList = path.match(/\/import\/jobs\/([^/]+)\/batches$/)
    if (batchList && request?.method === 'POST') {
      const body = request.body as { name: string; keys: string[]; prefix?: string }
      const plan = selectionPlan(body.keys, body.prefix)
      const view: IImportBatchView = {
        id: `b${Object.values(savedBatches).flat().length + 1}`,
        jobId: batchList[1],
        name: body.name,
        prefix: plan.prefix,
        keys: body.keys,
        order: plan.steps.map((step) => step.key),
        by: 'root@x.test',
        at: '2026-10-30T14:00:00.000Z',
        plan,
      }
      savedBatches[batchList[1]] = [view, ...(savedBatches[batchList[1]] ?? [])]
      return view
    }
    if (batchList) return (savedBatches[batchList[1]] ?? []).map(({ plan: _plan, ...record }) => record)
    const batchOne = path.match(/\/import\/jobs\/([^/]+)\/batches\/([^/]+)$/)
    if (batchOne) return savedBatches[batchOne[1]]!.find((entry) => entry.id === batchOne[2])
    const opened = path.match(/\/import\/jobs\/([^/]+)$/)
    if (opened) return saved.find((entry) => entry.id === opened[1])
    if (path.endsWith('/import/ignore')) {
      if (request?.method === 'PUT') ignoreStored = (request.body as { patterns: string[] }).patterns
      return { patterns: ignoreStored }
    }
    if (path.endsWith('/import/plan')) {
      const body = request!.body as { prefix?: string }
      return body.prefix ? { ...PLAN, prefix: body.prefix, idMap: PLAN.idMap.map((entry) => ({ ...entry, id: `${body.prefix}${entry.id}`, prefixed: true })) } : PLAN
    }
    throw new Error(`inesperado: ${path}`)
  })
  const host = document.createElement('div')
  // ⚠️ No documento: o jsdom só envia o formulário (o "Analisar") que está nele.
  document.body.append(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().isAdmin = true
  const projects = useProjectsStore()
  projects.list = [{ id: 'alfa', name: 'Alfa', createdAt: '', updatedAt: '' }]
  projects.current = 'alfa'
  projects.loaded = true
  createApp(ImportView).use(pinia).mount(host)
  await flush()
  if (options.analyze === false) return host
  host.querySelector<HTMLButtonElement>('[data-test="analyze"]')!.click()
  await flush()
  return host
}

function rows(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-test="row"]')].map((row) => row.textContent ?? '')
}

function choose(host: HTMLElement, test: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(`[data-test="${test}"]`)!
  select.value = value
  select.dispatchEvent(new Event('change'))
}

describe('ImportView', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    document.body.innerHTML = ''
  })

  it('analisa o repositório escolhido, salva o trabalho e mostra o topo', async () => {
    const host = await mount(SMALL)
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/jobs', { method: 'POST', body: { repository: 'app' } })
    expect(host.querySelectorAll('[data-test="job"]')).toHaveLength(1)
    const summary = host.querySelector('[data-test="summary"]')!.textContent!
    expect(summary).toContain('0123456789ab')
    expect(summary).toContain('árvore suja')
    expect(summary).toContain('agents-dir')
    expect(summary).toContain('node_modules')
    expect(summary).toContain('Links recusados (1)')
    expect(rows(host)).toHaveLength(3)
  })

  it('filtra por nota, por estado e pela busca', async () => {
    const host = await mount(SMALL)
    choose(host, 'note', 'code:broken-ref')
    await flush()
    expect(rows(host)).toHaveLength(1)
    expect(rows(host)[0]).toContain('ship')

    choose(host, 'note', '')
    choose(host, 'catalog', 'none')
    await flush()
    expect(rows(host).map((row) => row.includes('notes/x.md'))).toEqual([true])

    choose(host, 'catalog', '')
    const query = host.querySelector<HTMLInputElement>('[data-test="query"]')!
    query.value = '.claude/skills'
    query.dispatchEvent(new Event('input'))
    await flush()
    expect(rows(host)).toHaveLength(1)
    expect(rows(host)[0]).toContain('deploy')
  })

  it('o detalhe mostra fontes, citações, "não traduz" e quem cita', async () => {
    const host = await mount(SMALL)
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="row"]')].find((row) => row.textContent!.includes('deploy'))!.click()
    await flush()
    const detail = host.querySelector('[data-test="import-detail"]')!
    expect(detail.querySelector('[data-test="untranslatable"]')!.textContent).toContain('a skill tem triggers/')
    expect(detail.textContent).toContain('.claude/skills/deploy/SKILL.md')
    expect(detail.textContent).toContain('segredo')
    expect(detail.textContent).toContain('Citado por (1)')

    // Ir para quem cita: o detalhe troca para o command, com a citação quebrada.
    ;[...detail.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'command:ship')!.click()
    await flush()
    expect(host.querySelector('[data-test="unresolved"]')!.textContent).toContain('docs/sumiu.md')
  })

  it('reclassificar grava no trabalho e sobrevive a reabrir', async () => {
    const host = await mount(SMALL)
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="row"]')].find((row) => row.textContent!.includes('notes/x.md'))!.click()
    await flush()
    choose(host, 'reclassify', 'spec')
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/jobs/j1/items', { method: 'PATCH', body: { key: 'unknown:notes/x.md', kind: 'spec' } })
    choose(host, 'kind', 'spec')
    await flush()
    expect(rows(host)).toHaveLength(1)
    expect(rows(host)[0]).toContain('Spec')
    expect(host.querySelector('[data-test="summary"]')!.textContent).toContain('1 reclassificado(s)')

    // Reabrir o trabalho pela lista: o tipo veio do servidor.
    host.querySelector<HTMLButtonElement>('[data-test="job"]')!.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/jobs/j1')
    choose(host, 'kind', 'spec')
    await flush()
    expect(rows(host)).toHaveLength(1)

    // Voltar ao detectado manda `null`.
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="row"]')].find((row) => row.textContent!.includes('notes/x.md'))!.click()
    await flush()
    choose(host, 'reclassify', 'unknown')
    await flush()
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/import/jobs/j1/items', { method: 'PATCH', body: { key: 'unknown:notes/x.md', kind: null } })
  })

  it('a lista abre um trabalho salvo, com o estado de cada item; excluir e incluir gravam', async () => {
    const stale = savedJob(
      'j7',
      SMALL,
      { reuse: { from: 'j6', kept: 2, stale: ['skill:deploy'], restored: [], added: [], gone: [] }, previousId: 'j6' },
      {
        'skill:deploy': { state: 'stale', staleFrom: 'skipped', by: 'bia@x.test', at: '2026-10-30T11:00:00.000Z' },
        'command:ship': { state: 'skipped' },
      },
    )
    const host = await mount(SMALL, { jobs: [stale], analyze: false })
    expect(host.querySelector('[data-test="summary"]')).toBeNull()
    expect(host.querySelector('[data-test="job"]')!.textContent).toContain('fonte mudou 1')
    host.querySelector<HTMLButtonElement>('[data-test="job"]')!.click()
    await flush()
    expect(host.querySelector('[data-test="reuse"]')!.textContent).toContain('1 com fonte mudada')
    expect([...host.querySelectorAll('[data-test="row-state"]')].map((chip) => chip.textContent!.trim()).sort()).toEqual(['excluído', 'fonte mudou'])

    choose(host, 'state', 'stale')
    await flush()
    expect(rows(host)).toHaveLength(1)
    host.querySelector<HTMLButtonElement>('[data-test="row"]')!.click()
    await flush()
    const detail = host.querySelector('[data-test="item-state"]')!
    expect(detail.textContent).toContain('era excluído')
    expect(detail.textContent).toContain('bia@x.test')
    host.querySelector<HTMLButtonElement>('[data-test="include"]')!.click()
    await flush()
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/import/jobs/j7/items', { method: 'PATCH', body: { key: 'skill:deploy', state: 'pending' } })
    expect(rows(host)).toHaveLength(0)

    choose(host, 'state', '')
    await flush()
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="row"]')].find((row) => row.textContent!.includes('deploy'))!.click()
    await flush()
    host.querySelector<HTMLButtonElement>('[data-test="exclude"]')!.click()
    await flush()
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/import/jobs/j7/items', { method: 'PATCH', body: { key: 'skill:deploy', state: 'skipped' } })
    expect(host.querySelector('[data-test="item-state"]')!.textContent).toContain('excluído')
    expect(host.querySelector('[data-test="job"]')!.textContent).toContain('excluído 2')
  })

  it('⛔ o trabalho antigo é registro: sem excluir, incluir nem reclassificar', async () => {
    const old = savedJob('j1', SMALL, { latest: false })
    const host = await mount(SMALL, { jobs: [savedJob('j2', SMALL), old], analyze: false })
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="job"]')].find((button) => button.textContent!.includes('registro'))!.click()
    await flush()
    expect(host.querySelector('[data-test="readonly"]')).not.toBeNull()
    host.querySelector<HTMLButtonElement>('[data-test="row"]')!.click()
    await flush()
    expect(host.querySelector('[data-test="exclude"]')).toBeNull()
    expect(host.querySelector('[data-test="include"]')).toBeNull()
    expect(host.querySelector<HTMLSelectElement>('[data-test="reclassify"]')!.disabled).toBe(true)
  })

  it('um inventário grande abre só a primeira página', async () => {
    const many = Array.from({ length: 730 }, (_, i) => item({ key: `spec:doc-${String(i).padStart(3, '0')}`, kind: 'spec', catalog: 'new' }))
    const host = await mount(many)
    expect(rows(host)).toHaveLength(100)
    expect(host.querySelector('[data-test="count"]')!.textContent).toContain('730 de 730')
    host.querySelector<HTMLButtonElement>('[data-test="more"]')!.click()
    await flush()
    expect(rows(host)).toHaveLength(200)
  })

  it('o ignorar do projeto: carrega, edita e salva pela API, sem analisar', async () => {
    const host = await mount(SMALL)
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/ignore')
    const editor = host.querySelector('[data-test="ignore-editor"]')!
    expect(editor.textContent).toContain('(1 padrão')
    const area = editor.querySelector<HTMLTextAreaElement>('[data-test="ignore-patterns"]')!
    expect(area.value).toBe('.agents/benchmark')
    area.value = '.agents/benchmark\n  *.log  \n\n*.log'
    area.dispatchEvent(new Event('input'))
    await flush()
    editor.querySelector<HTMLButtonElement>('[data-test="ignore-save"]')!.click()
    editor.querySelector('form')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/ignore', { method: 'PUT', body: { patterns: ['.agents/benchmark', '*.log'] } })
    expect(editor.textContent).toContain('Analise de novo para aplicar')
  })

  it('"Montar lote" no agente mostra o fecho em ordem, o mapa de ids, as permissões e a estimativa — sem botão que grave', async () => {
    const host = await mount([...SMALL, item({ key: 'agent:ana', kind: 'agent', catalog: 'new' })])
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="row"]')].find((row) => row.textContent!.includes('ana'))!.click()
    await flush()
    host.querySelector<HTMLButtonElement>('[data-test="plan"]')!.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/plan', { method: 'POST', body: { repository: 'app', agent: 'agent:ana', job: 'j1' } })
    const batch = host.querySelector('[data-test="batch"]')!
    expect([...batch.querySelectorAll('[data-test="step"]')].map((step) => step.querySelector('button')!.textContent)).toEqual(['base', 'ana', '01'])
    expect(batch.querySelector('[data-test="order"]')!.textContent).toContain('Fase 4 · agente fechado, com os triggers · 2')
    expect(batch.querySelector('[data-test="blocked"]')!.textContent).toContain('spec:base')
    expect(batch.querySelector('[data-test="estimate"]')!.textContent).toContain('3 conversa(s)')
    const marks = [...batch.querySelectorAll('[data-test="reach-row"]')].map((row) => row.querySelector('td')!.textContent)
    expect(marks).toEqual(['⚠️', '✅', '❌', '✅'])
    const widenings = batch.querySelector('[data-test="widenings"]')!.textContent!
    expect(widenings).toContain('terminal libera *')
    expect(widenings).toContain('skill libera *')
    expect(widenings).toContain('liberaria TODAS as skills')
    expect(batch.querySelector('[data-test="skills"]')!.textContent).toContain('akm-revisar')
    expect(batch.querySelector('[data-test="reach-row"].bg-amber-500\\/10')).not.toBeNull()
    // ⛔ Nada que grave no catálogo; o único "Importar" é o que abre a conversa do construtor (que não grava).
    const labels = [...host.querySelectorAll('button')].map((button) => button.textContent!.trim()).filter((label) => !label.startsWith('Importar com o construtor'))
    for (const word of ['Gravar', 'Transformar', 'Aplicar', 'Importar']) expect(labels.some((label) => label.includes(word))).toBe(false)
  })

  it('o prefixo recalcula o lote e o mapa mostra os ids novos', async () => {
    const host = await mount([...SMALL, item({ key: 'agent:ana', kind: 'agent', catalog: 'new' })])
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="row"]')].find((row) => row.textContent!.includes('ana'))!.click()
    await flush()
    host.querySelector<HTMLButtonElement>('[data-test="plan"]')!.click()
    await flush()
    const input = host.querySelector<HTMLInputElement>('[data-test="prefix"]')!
    input.value = 'AKM-'
    input.dispatchEvent(new Event('input'))
    await flush()
    input.form!.dispatchEvent(new Event('submit'))
    await flush()
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/import/plan', { method: 'POST', body: { repository: 'app', agent: 'agent:ana', prefix: 'akm-', job: 'j1' } })
    expect(host.querySelector('[data-test="id-map"]')!.textContent).toContain('akm-ana')
    // Prefixo inválido não recalcula.
    input.value = 'a b'
    input.dispatchEvent(new Event('input'))
    await flush()
    expect(host.querySelector<HTMLButtonElement>('[data-test="replan"]')!.disabled).toBe(true)
  })

  it('seleciona na lista e pelo filtro; "Montar lote da seleção" mostra a ordem, o fora da seleção e a estimativa; salvar grava só o lote', async () => {
    const host = await mount(SMALL)
    expect(host.querySelector<HTMLButtonElement>('[data-test="build-batch"]')!.disabled).toBe(true)
    // Caixa a caixa.
    const pick = (text: string) =>
      [...host.querySelectorAll('[data-test="row"]')].find((row) => row.textContent!.includes(text))!.parentElement!.querySelector<HTMLInputElement>('[data-test="pick"]')!
    pick('ship').click()
    await flush()
    expect(host.querySelector('[data-test="picked-count"]')!.textContent).toContain('1 selecionado')
    // Todos do filtro atual: as skills.
    choose(host, 'kind', 'skill')
    await flush()
    host.querySelector<HTMLButtonElement>('[data-test="pick-filtered"]')!.click()
    await flush()
    expect(host.querySelector('[data-test="picked-count"]')!.textContent).toContain('2 selecionado')
    choose(host, 'kind', '')
    await flush()
    expect(pick('deploy').checked).toBe(true)
    expect(pick('notes/x.md').checked).toBe(false)

    host.querySelector<HTMLButtonElement>('[data-test="build-batch"]')!.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/jobs/j1/batches/plan', { method: 'POST', body: { keys: ['skill:deploy', 'command:ship'] } })
    const batch = host.querySelector('[data-test="selection-batch"]')!
    expect([...batch.querySelectorAll('[data-test="step"]')].map((step) => step.querySelector('button')!.textContent)).toEqual(['deploy', 'ship'])
    expect(batch.querySelector('[data-test="step-done"]')!.textContent).toContain('já no catálogo')
    expect(batch.querySelector('[data-test="selection-estimate"]')!.textContent).toContain('1 conversa(s)')
    expect(batch.querySelector('[data-test="selection-estimate"]')!.textContent).toContain('1 passo(s) já no catálogo')
    expect(batch.querySelector('[data-test="selection-cycles"]')!.textContent).toContain('spec:a, spec:b')
    const outside = batch.querySelector('[data-test="outside"]')!.textContent!
    expect(outside).toContain('citação quebrada (1)')
    expect(outside).toContain('em outro lote (1)')
    expect(outside).toContain('docs')
    expect(host.querySelector('[data-test="batches"]')).toBeNull()

    const name = batch.querySelector<HTMLInputElement>('[data-test="batch-name"]')!
    expect(name.value).toBe('Seleção (2)')
    name.value = 'Deploy'
    name.dispatchEvent(new Event('input'))
    await flush()
    batch.querySelector<HTMLFormElement>('[data-test="save-batch"]')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/import/jobs/j1/batches', { method: 'POST', body: { name: 'Deploy', keys: ['skill:deploy', 'command:ship'] } })
    expect(host.querySelector('[data-test="batch-meta"]')!.textContent).toContain('root@x.test')
    expect(host.querySelector('[data-test="batches"]')!.textContent).toContain('Deploy')
    expect(host.querySelector('[data-test="save-batch"]')).toBeNull()

    // ⛔ Nada que grave no catálogo; o único "Importar" é o que abre a conversa do construtor (que não grava).
    const labels = [...host.querySelectorAll('button')].map((button) => button.textContent!.trim()).filter((label) => !label.startsWith('Importar com o construtor'))
    for (const word of ['Gravar', 'Transformar', 'Aplicar', 'Importar', 'Disparar']) expect(labels.some((label) => label.includes(word))).toBe(false)

    host.querySelector<HTMLButtonElement>('[data-test="pick-clear"]')!.click()
    await flush()
    expect(host.querySelector('[data-test="picked-count"]')!.textContent).toContain('0 selecionado')
  })

  it('o prefixo recalcula a prévia com as mesmas chaves', async () => {
    const host = await mount(SMALL)
    host.querySelector<HTMLButtonElement>('[data-test="pick-filtered"]')!.click()
    await flush()
    host.querySelector<HTMLButtonElement>('[data-test="build-batch"]')!.click()
    await flush()
    const input = host.querySelector<HTMLInputElement>('[data-test="selection-prefix"]')!
    input.value = 'akm-'
    input.dispatchEvent(new Event('input'))
    await flush()
    input.form!.dispatchEvent(new Event('submit'))
    await flush()
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/import/jobs/j1/batches/plan', {
      method: 'POST',
      body: { keys: ['skill:deploy', 'command:ship', 'unknown:notes/x.md'], prefix: 'akm-' },
    })
    expect(host.querySelector('[data-test="selection-order"]')!.textContent).toContain('akm-ship')
  })

  it('os lotes salvos do trabalho aparecem ao abrir; abrir um mostra o detalhe recalculado', async () => {
    const plan = selectionPlan(['skill:deploy', 'command:ship'])
    const stored: IImportBatchView = {
      id: 'b9',
      jobId: 'j7',
      name: 'Commands',
      prefix: '',
      keys: ['skill:deploy', 'command:ship'],
      order: ['skill:deploy', 'command:ship'],
      by: 'bia@x.test',
      at: '2026-10-30T11:00:00.000Z',
      plan,
    }
    const host = await mount(SMALL, { jobs: [savedJob('j7', SMALL)], analyze: false, batches: { j7: [stored] } })
    host.querySelector<HTMLButtonElement>('[data-test="job"]')!.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/jobs/j7/batches')
    const entry = host.querySelector<HTMLButtonElement>('[data-test="batch-entry"]')!
    expect(entry.textContent).toContain('Commands')
    expect(entry.textContent).toContain('bia@x.test')
    entry.click()
    await flush()
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/import/jobs/j7/batches/b9')
    const batch = host.querySelector('[data-test="selection-batch"]')!
    expect(batch.textContent).toContain('Lote Commands')
    expect(batch.querySelectorAll('[data-test="step"]')).toHaveLength(2)
    expect(batch.querySelector('[data-test="save-batch"]')).toBeNull()
  })

  it('"Importar com o construtor": uma conversa por construtor, para a seleção ou para o lote salvo; o item fica em drafting', async () => {
    const stored: IImportBatchView = {
      id: 'b9',
      jobId: 'j7',
      name: 'Misto',
      prefix: '',
      keys: ['skill:deploy', 'command:ship'],
      order: ['skill:deploy', 'command:ship'],
      by: 'bia@x.test',
      at: '2026-10-30T11:00:00.000Z',
      plan: selectionPlan(['skill:deploy', 'command:ship']),
    }
    const host = await mount(SMALL, { jobs: [savedJob('j7', SMALL)], analyze: false, batches: { j7: [stored] } })
    const base = vi.mocked(api).getMockImplementation()!
    vi.mocked(api).mockImplementation(async (path: string, request?: { method?: string; body?: unknown }) => {
      if (path.endsWith('/builder')) {
        const body = request!.body as { keys?: string[]; kind?: string }
        return { conversationId: 'conv-1', kind: body.kind ?? 'skill', agentId: 'builder-import-skill', keys: body.keys ?? ['skill:deploy'] }
      }
      return base(path, request as never)
    })
    host.querySelector<HTMLButtonElement>('[data-test="job"]')!.click()
    await flush()
    // A seleção mistura skill e command: um botão por construtor.
    for (const box of host.querySelectorAll<HTMLInputElement>('[data-test="pick"]')) if (!box.closest('li')!.textContent!.includes('notes')) box.click()
    await flush()
    const picked = [...host.querySelectorAll<HTMLButtonElement>('[data-test="build-picked"]')].map((button) => button.textContent!.trim())
    expect(picked).toEqual(['Importar com o construtor (skill, 1)', 'Importar com o construtor (command, 1)'])
    host.querySelector<HTMLButtonElement>('[data-test="build-picked"]')!.click()
    await flush()
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/import/jobs/j7/builder', { method: 'POST', body: { keys: ['skill:deploy'] } })
    // A skill já tem conversa: sai dos botões.
    expect([...host.querySelectorAll('[data-test="build-picked"]')].map((button) => button.textContent!.trim())).toEqual(['Importar com o construtor (command, 1)'])
    // O lote salvo aberto: o que dele ainda vai ao construtor, pelo id do lote e o construtor.
    host.querySelector<HTMLButtonElement>('[data-test="batch-entry"]')!.click()
    await flush()
    const saved = host.querySelectorAll<HTMLButtonElement>('[data-test="build-saved-batch"]')
    expect([...saved].map((button) => button.textContent!.trim())).toEqual(['Importar com o construtor (command, 1)'])
    saved[0].click()
    await flush()
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/import/jobs/j7/builder', { method: 'POST', body: { batchId: 'b9', kind: 'command' } })
  })

  it('⛔ no trabalho antigo a prévia vale, mas o lote não é salvo', async () => {
    const host = await mount(SMALL, { jobs: [savedJob('j2', SMALL), savedJob('j1', SMALL, { latest: false })], analyze: false })
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="job"]')].find((button) => button.textContent!.includes('registro'))!.click()
    await flush()
    host.querySelector<HTMLButtonElement>('[data-test="pick-filtered"]')!.click()
    await flush()
    host.querySelector<HTMLButtonElement>('[data-test="build-batch"]')!.click()
    await flush()
    expect(host.querySelector('[data-test="selection-batch"]')).not.toBeNull()
    expect(host.querySelector('[data-test="save-batch"]')).toBeNull()
  })
})
