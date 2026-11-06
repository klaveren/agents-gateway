import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import type { IApplyPreview, IApplyResult } from '@/lib/importApply'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import ImportApply from './ImportApply.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const WIDENINGS = [
  { key: 'agent/maya@alfa#allowedTools+cap:terminal', description: 'O agente maya ganha o terminal' },
  { key: 'agent/maya@alfa#permissions+allow:skill:revisar', description: 'O agente maya libera a skill revisar' },
]

function preview(patch: Partial<IApplyPreview['plan']> = {}): IApplyPreview {
  return {
    jobId: 'j1',
    repository: 'app',
    scope: 'project:alfa',
    items: [
      { key: 'spec:arq', kind: 'spec', refs: ['spec/arq'] },
      { key: 'agent:maya', kind: 'agent', refs: ['agent/maya'] },
    ],
    skipped: [{ key: 'spec:outro', reason: 'estado pending: só o aprovado é gravado' }],
    agents: [
      {
        key: 'agent:maya',
        id: 'maya',
        exists: false,
        rules: [
          { key: 'terminal allow *', rule: { category: 'terminal', pattern: '*', decision: 'allow' }, wide: 'terminal amplo: qualquer comando', included: false },
          { key: 'skill allow revisar', rule: { category: 'skill', pattern: 'revisar', decision: 'allow' }, included: true },
        ],
        allowedTools: ['cap:terminal'],
        skills: ['revisar'],
        pendingSkills: [],
        commands: [],
        reach: 'opencode',
        notes: [],
      },
    ],
    models: [{ provider: 'google', models: ['gemini-3.7-flash'] }],
    plan: {
      scope: 'project:alfa',
      planHash: 'h1',
      items: [
        { ref: 'spec/arq', kind: 'spec', id: 'arq', op: 'create', diff: { hunks: [] }, widenings: [], attentions: [], issues: [], brokenRefs: [] },
        { ref: 'agent/maya', kind: 'agent', id: 'maya', op: 'create', widenings: WIDENINGS, attentions: [], issues: [], brokenRefs: [] },
      ],
      order: [
        { ref: 'spec/arq', phase: 'docs', widens: false },
        { ref: 'agent/maya', phase: 'agents', part: 'record', widens: false },
        { ref: 'agent/maya', phase: 'reach', part: 'reach', widens: true },
      ],
      widenings: WIDENINGS,
      attentions: [],
      brokenRefs: [],
      missingSecrets: [],
      summary: { create: 2, update: 0, unchanged: 0 },
      ...patch,
    },
  }
}

const RESULT: IApplyResult = {
  planHash: 'h1',
  batch: { id: 'lote-7', status: 'applied' },
  applied: [],
  pending: [],
  entersDisabled: [],
  missingSecrets: [],
  items: { applied: ['spec:arq', 'agent:maya'], notApplied: [] },
}

let app: App | undefined
let next: IApplyPreview
const appliedEvents: IApplyResult[] = []
const events: Array<[string, unknown]> = []

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(admin = true, target: { batchId?: string; keys?: string[]; label: string } = { batchId: 'b1', label: 'lote docs' }): Promise<HTMLElement> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  // `admin` = administra o PROJETO (o papel vem do projeto, não do gateway).
  auth.isAdmin = false
  const projects = useProjectsStore()
  projects.list = [{ id: 'alfa', name: 'Alfa', role: admin ? 'admin' : 'member', createdAt: '', updatedAt: '' }]
  projects.current = 'alfa'
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
  await router.push('/import')
  await router.isReady()
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(ImportApply, {
        projectId: 'alfa',
        jobId: 'j1',
        target,
        onApplied: (result: IApplyResult) => appliedEvents.push(result),
        onSelect: (key: string) => events.push(['select', key]),
        onBuild: (keys: string[]) => events.push(['build', keys]),
        onInclude: (keys: string[]) => events.push(['include', keys]),
      }),
  })
    .use(pinia)
    .use(router)
  app.mount(host)
  await flush()
  return host
}

async function click(element: Element | null | undefined) {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}

const bodies = (path: string) =>
  vi
    .mocked(api)
    .mock.calls.filter(([called]) => called === path)
    .map(([, request]) => request?.body)

describe('ImportApply — gravar no catálogo', () => {
  beforeEach(() => {
    next = preview()
    appliedEvents.length = 0
    events.length = 0
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.endsWith('/apply/plan')) return next
      if (path.endsWith('/apply')) return RESULT
      return undefined
    })
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('mostra o plano: o que fica de fora, o agente com a regra ampla DESMARCADA e a ordem com o alcance por último', async () => {
    const host = await mount()
    expect(bodies('/projects/alfa/import/jobs/j1/apply/plan')).toEqual([{ batchId: 'b1' }])
    expect(host.querySelector('[data-test="apply-skipped"]')?.textContent).toContain('spec:outro')
    const wide = host.querySelector<HTMLInputElement>('[data-rule="terminal allow *"]')!
    expect([wide.checked, wide.disabled]).toEqual([false, false])
    const narrow = host.querySelector<HTMLInputElement>('[data-rule="skill allow revisar"]')!
    expect([narrow.checked, narrow.disabled]).toEqual([true, true])
    const order = host.querySelector('[data-test="apply-order"]')!.textContent!
    expect(order).toContain('agentes (fechados): agent/maya (registro)')
    expect(order).toContain('alcance dos agentes: agent/maya (alcance)')

    // Incluir a regra ampla e escolher o modelo refazem o plano com a escolha.
    await click(wide)
    const select = host.querySelector<HTMLSelectElement>('[data-test="apply-model"]')!
    select.value = 'google|gemini-3.7-flash'
    select.dispatchEvent(new Event('change'))
    await flush()
    expect(bodies('/projects/alfa/import/jobs/j1/apply/plan').slice(1)).toEqual([
      { batchId: 'b1', wide: { 'agent:maya': ['terminal allow *'] } },
      { batchId: 'b1', wide: { 'agent:maya': ['terminal allow *'] }, models: { 'agent:maya': { provider: 'google', model: 'gemini-3.7-flash' } } },
    ])
  })

  it('gravar com ampliação: uma caixa por ampliação, todas obrigatórias; manda o planHash e o confirm; o lote abre no histórico', async () => {
    const host = await mount()
    expect(bodies('/projects/alfa/import/jobs/j1/apply')).toEqual([])
    await click(host.querySelector('[data-test="apply-write"]'))
    expect(bodies('/projects/alfa/import/jobs/j1/apply')).toEqual([])
    const submit = host.querySelector<HTMLButtonElement>('[data-test="widening-submit"]')!
    const boxes = host.querySelectorAll<HTMLInputElement>('[data-test="widening-confirm"] input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    await click(boxes[0])
    expect(submit.disabled).toBe(true)
    await click(boxes[1])
    expect(submit.disabled).toBe(false)
    await click(submit)
    expect(bodies('/projects/alfa/import/jobs/j1/apply')).toEqual([{ batchId: 'b1', planHash: 'h1', confirm: WIDENINGS.map((widening) => widening.key) }])
    const result = host.querySelector('[data-test="apply-result"]')!
    expect(result.textContent).toContain('2 item(ns) gravado(s)')
    expect(host.querySelector('[data-test="apply-history"]')?.getAttribute('href')).toBe('/catalog/history?lote=lote-7')
    expect(appliedEvents.map((event) => event.items.applied)).toEqual([['spec:arq', 'agent:maya']])
  })

  it('item com erro bloqueia o botão; quem não administra não vê o botão', async () => {
    next = preview({
      items: [
        { ref: 'agent/maya', kind: 'agent', id: 'maya', op: 'error', widenings: [], attentions: [], issues: [{ field: 'providers', message: 'pick a model' }], brokenRefs: [] },
      ],
    })
    const host = await mount()
    expect(host.querySelector<HTMLButtonElement>('[data-test="apply-write"]')!.disabled).toBe(true)
    expect(host.querySelector('[data-test="apply-items"]')?.textContent).toContain('providers: pick a model')
    app?.unmount()
    document.body.innerHTML = ''
    next = preview()
    const member = await mount(false)
    expect(member.querySelector('[data-test="apply-write"]')).toBeNull()
  })

  it('"Corrigir com o construtor": só o recusado por problema dele; confirma (tokens), manda as chaves e relê o plano', async () => {
    next = preview({
      items: [
        { ref: 'spec/arq', kind: 'spec', id: 'arq', op: 'error', widenings: [], attentions: [], issues: [{ field: 'summary', message: 'at most 300 characters' }], brokenRefs: [] },
        {
          ref: 'agent/maya',
          kind: 'agent',
          id: 'maya',
          op: 'error',
          widenings: [],
          attentions: [],
          issues: [{ field: 'providers', message: 'at least one provider' }],
          brokenRefs: [],
        },
      ],
    })
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.endsWith('/apply/plan')) return next
      if (path.endsWith('/apply/fix')) return { reopened: [{ key: 'spec:arq', issues: ['x'] }], skipped: [], started: ['c1'] }
      return undefined
    })
    const host = await mount()
    expect(host.querySelectorAll('[data-test="apply-fix-one"]')).toHaveLength(1)
    await click(host.querySelector('[data-test="apply-fix-all"]'))
    expect(bodies('/projects/alfa/import/jobs/j1/apply/fix')).toEqual([])
    await click(host.querySelector('[data-test="apply-fix-start"]'))
    expect(bodies('/projects/alfa/import/jobs/j1/apply/fix')).toEqual([{ batchId: 'b1', keys: ['spec:arq'] }])
    expect(host.querySelector('[data-test="apply-fix-result"]')!.textContent).toContain('1 item(ns) voltaram ao construtor (1 conversa(s) rodando)')
    expect(bodies('/projects/alfa/import/jobs/j1/apply/plan')).toHaveLength(2)
  })

  it('"Gravar só os prontos": refaz o plano sem os bloqueados, lista o que ficou de fora e libera o botão; volta a ver todos', async () => {
    next = preview({
      items: [
        { ref: 'agent/maya', kind: 'agent', id: 'maya', op: 'error', widenings: [], attentions: [], issues: [{ field: 'providers', message: 'pick a model' }], brokenRefs: [] },
      ],
    })
    const host = await mount()
    expect(host.querySelector('[data-test="apply-held"]')).toBeNull()
    next = { ...preview({ widenings: [] }), heldBack: [{ key: 'agent:maya', ref: 'agent/maya', reason: 'pick a model' }] }
    await click(host.querySelector('[data-test="apply-ready"]'))
    expect(bodies('/projects/alfa/import/jobs/j1/apply/plan').at(-1)).toEqual({ batchId: 'b1', ready: true })
    expect(host.querySelector('[data-test="apply-held-item"]')!.textContent).toContain('agent:maya — pick a model')
    expect(host.querySelector('[data-test="apply-ready-offer"]')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>('[data-test="apply-write"]')!.disabled).toBe(false)
    await click(host.querySelector('[data-test="apply-ready-off"]'))
    expect(bodies('/projects/alfa/import/jobs/j1/apply/plan').at(-1)).toEqual({ batchId: 'b1' })
  })

  it('o que falta diz o tipo e o estado; vem deste repositório: "Adicionar à migração" (uma ou todas) e "Ver no inventário"', async () => {
    const item = (key: string, kind: string, state: string) => ({ key, kind, state, path: `.agents/${key}.md` })
    next = {
      ...preview(),
      missing: [
        { target: 'doc', id: 'plan-arq', from: ['knowledge/guia'], item: item('spec:plan-arq', 'spec', 'pending') },
        { target: 'doc', id: 'pronta', from: ['knowledge/guia'], item: item('spec:pronta', 'spec', 'approved') },
        { target: 'doc', id: 'sumiu', from: ['knowledge/guia'] },
        { target: 'doc', id: 'drain', from: ['knowledge/guia'], fromKeys: ['knowledge:guia'], wrongKind: { key: 'command:drain', kind: 'command' } },
      ],
    } as IApplyPreview
    const host = await mount(true, { batchId: 'b1', label: 'migração guia' })
    const rows = [...host.querySelectorAll('[data-test="missing-ref"]')]
    expect(rows[0].querySelector('[data-test="missing-kind"]')?.textContent).toContain('a importar')
    expect(rows.map((row) => !!row.querySelector('[data-test="missing-include"]'))).toEqual([true, true, false, false])
    expect(rows[2].querySelector('[data-test="missing-none"]')).not.toBeNull()
    expect(rows[3].querySelector('[data-test="missing-wrong-kind"]')?.textContent).toContain('Command')
    expect(rows[0].querySelector('[data-test="missing-view"]')!.textContent).toBe('Ver no inventário')
    await click(rows[0].querySelector('[data-test="missing-view"]'))
    await click(rows[1].querySelector('[data-test="missing-include"]'))
    await click(host.querySelector('[data-test="missing-include-all"]'))
    await click(rows[3].querySelector('[data-test="missing-view-from"]'))
    expect(events).toEqual([
      ['select', 'spec:plan-arq'],
      ['include', ['spec:pronta']],
      ['include', ['spec:plan-arq', 'spec:pronta']],
      ['select', 'knowledge:guia'],
    ])
  })

  it('numa migração salva, a falta aprovada também grava junto (entra nela); em "todos os aprovados", só se vê', async () => {
    next = {
      ...preview(),
      missing: [{ target: 'doc', id: 'pronta', from: ['knowledge/guia'], item: { key: 'spec:pronta', kind: 'spec', state: 'approved', path: 'x.md' } }],
    } as IApplyPreview
    const host = await mount()
    await click(host.querySelector('[data-test="missing-include"]'))
    expect(events).toContainEqual(['include', ['spec:pronta']])
    app?.unmount()
    const all = await mount(true, { label: 'todos os aprovados do trabalho' })
    expect(all.querySelector('[data-test="missing-include"]')).toBeNull()
    expect(all.querySelector('[data-test="missing-view"]')).not.toBeNull()
  })
})

describe('ImportApply — os problemas com que cada item entra (não bloqueiam)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('a lista amarela por documento, separada dos erros; o que volta (vínculo pendente) aparece à parte', async () => {
    const base = preview()
    next = {
      ...base,
      items: [{ ...base.items[0], issues: [{ code: 'link-pending', message: 'vínculo com api pendente', target: 'api', link: 'attach', ref: 'spec/arq' }] }, base.items[1]],
      resolved: [{ ref: 'skill/revisar', issues: [{ code: 'link-pending', message: 'vínculo com arq pendente', target: 'arq', link: 'attach' }] }],
    }
    vi.mocked(api).mockImplementation(async () => next as never)
    const host = await mount()
    const rows = [...host.querySelectorAll('[data-test="apply-items"] > li')]
    expect(rows[0].querySelector('[data-test="apply-item-issues"]')?.textContent).toContain('vínculo com api pendente')
    expect(rows[1].querySelector('[data-test="apply-item-issues"]')).toBeNull()
    expect(host.querySelector('[data-test="apply-resolved"]')?.textContent).toContain('skill/revisar')
    // Não bloqueia: o botão de gravar continua ativo.
    expect(host.querySelector('[data-test="apply-write"]')!.hasAttribute('disabled')).toBe(false)
  })

  it('a delegação a quem não existe: a regra diz que fica de fora, e o problema entra na lista amarela do agente', async () => {
    const base = preview()
    const held = 'permite delegar a agent-sre, que ainda não existe: a regra fica guardada e volta quando agent-sre for importado'
    next = {
      ...base,
      items: [base.items[0], { ...base.items[1], issues: [{ code: 'delegate-missing', message: held, target: 'agent-sre', link: 'reach', ref: 'agent/maya' }] }],
      agents: [
        {
          ...base.agents[0],
          rules: [...base.agents[0].rules, { key: 'delegate allow agent-sre', rule: { category: 'delegate', pattern: 'agent-sre', decision: 'allow' }, included: true, held }],
        },
      ],
    }
    vi.mocked(api).mockImplementation(async () => next as never)
    const host = await mount()
    expect([...host.querySelectorAll('[data-test="apply-rule-held"]')].map((one) => one.textContent)).toEqual([` — fica de fora: ${held}`])
    const rows = [...host.querySelectorAll('[data-test="apply-items"] > li')]
    expect(rows[1].querySelector('[data-test="apply-item-issues"]')?.textContent).toContain('permite delegar a agent-sre')
  })
})
