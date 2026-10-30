import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import type { IImportPlan, IImportScan, IInventoryItem } from '@/lib/importer'
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

let ignoreStored: string[] = []

async function mount(items: IInventoryItem[]): Promise<HTMLElement> {
  ignoreStored = ['.agents/benchmark']
  vi.mocked(api).mockImplementation(async (path: string, request?: { method?: string; body?: unknown }) => {
    if (path.endsWith('/repositories'))
      return [
        { name: 'app', worktrees: [] },
        { name: 'lib', worktrees: [] },
      ]
    if (path.endsWith('/import/scan')) return scan(items)
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

  it('analisa o repositório escolhido e mostra o topo', async () => {
    const host = await mount(SMALL)
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/scan', { method: 'POST', body: { repository: 'app' } })
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

  it('reclassificar muda o tipo só na tela, sem chamar a API', async () => {
    const host = await mount(SMALL)
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="row"]')].find((row) => row.textContent!.includes('notes/x.md'))!.click()
    await flush()
    const calls = vi.mocked(api).mock.calls.length
    choose(host, 'reclassify', 'spec')
    await flush()
    expect(vi.mocked(api).mock.calls.length).toBe(calls)
    choose(host, 'kind', 'spec')
    await flush()
    expect(rows(host)).toHaveLength(1)
    expect(rows(host)[0]).toContain('Spec')
    expect(host.querySelector('[data-test="summary"]')!.textContent).toContain('1 reclassificado(s)')
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
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/plan', { method: 'POST', body: { repository: 'app', agent: 'agent:ana' } })
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
    const labels = [...host.querySelectorAll('button')].map((button) => button.textContent!.trim())
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
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/import/plan', { method: 'POST', body: { repository: 'app', agent: 'agent:ana', prefix: 'akm-' } })
    expect(host.querySelector('[data-test="id-map"]')!.textContent).toContain('akm-ana')
    // Prefixo inválido não recalcula.
    input.value = 'a b'
    input.dispatchEvent(new Event('input'))
    await flush()
    expect(host.querySelector<HTMLButtonElement>('[data-test="replan"]')!.disabled).toBe(true)
  })
})
