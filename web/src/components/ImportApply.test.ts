import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import type { IApplyPreview, IApplyResult } from '@/lib/importApply'
import { useAuthStore } from '@/stores/auth'
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

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(admin = true, target: { batchId?: string; keys?: string[]; label: string } = { batchId: 'b1', label: 'lote docs' }): Promise<HTMLElement> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.isAdmin = admin
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
  await router.push('/import')
  await router.isReady()
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(ImportApply, { projectId: 'alfa', jobId: 'j1', target, onApplied: (result: IApplyResult) => appliedEvents.push(result) }) })
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
})
