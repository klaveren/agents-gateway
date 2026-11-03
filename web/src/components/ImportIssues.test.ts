import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { api } from '@/lib/api'
import type { IAgent, IAgentDetail, IImportIssue, IProjectDoc } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useDocsStore } from '@/stores/docs'
import ImportIssues from './ImportIssues.vue'
import ImportIssuesBadge from './ImportIssuesBadge.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const flush = async () => {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
}

const ISSUES: IImportIssue[] = [
  { code: 'link-not-document', message: 'cita lint, que é um command: não vira vínculo', target: 'lint', link: 'attach' },
  { code: 'link-pending', message: 'vínculo com api pendente', target: 'api', link: 'attach' },
]

function mount(component: unknown, props: Record<string, unknown>) {
  const host = document.createElement('div')
  document.body.append(host)
  createApp({ render: () => h(component as never, props) }).mount(host)
  return host
}

describe('ImportIssues — o bloco "Problemas da importação"', () => {
  it('lista cada problema; "Resolvido" chama a gravação com o problema; o erro aparece no bloco', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('não deu')
    })
    const host = mount(ImportIssues, { issues: ISSUES, resolve })
    await flush()
    expect(host.textContent).toContain('Problemas da importação (2)')
    expect([...host.querySelectorAll('[data-test="import-issue"]')].map((row) => row.textContent)).toEqual([
      expect.stringContaining('cita lint, que é um command'),
      expect.stringContaining('vínculo com api pendente'),
    ])
    ;(host.querySelectorAll('[data-test="import-issue-resolve"]')[1] as HTMLButtonElement).click()
    await flush()
    expect(resolve).toHaveBeenCalledWith(ISSUES[1])
    expect(host.querySelector('[data-test="import-issues-error"]')?.textContent).toBe('não deu')
  })

  it('pendente: "Descartar" (os outros, "Resolvido"); "Descartar todos os pendentes" pede confirmação e manda `{ pending: true }`', async () => {
    const resolve = vi.fn(async () => undefined)
    const issues: IImportIssue[] = [...ISSUES, { code: 'delegate-missing', message: 'permite delegar a agent-sre, que ainda não existe', target: 'agent-sre', link: 'reach' }]
    const host = mount(ImportIssues, { issues, resolve })
    await flush()
    expect([...host.querySelectorAll('[data-test="import-issue-resolve"]')].map((button) => button.textContent?.trim())).toEqual(['Resolvido', 'Descartar', 'Descartar'])
    ;(host.querySelector('[data-test="import-issues-discard-all"]') as HTMLButtonElement).click()
    await flush()
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('2 problema(s) pendente(s)')
    expect(resolve).not.toHaveBeenCalled()
    ;([...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Descartar') as HTMLButtonElement).click()
    await flush()
    expect(resolve).toHaveBeenCalledWith({ pending: true })
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    // Sem pendente, sem o botão de todos.
    const none = mount(ImportIssues, { issues: [ISSUES[0]], resolve })
    await flush()
    expect(none.querySelector('[data-test="import-issues-discard-all"]')).toBeNull()
  })

  it('sem problema, nada; o selo da lista diz quantos', async () => {
    expect(mount(ImportIssues, { issues: [], resolve: vi.fn() }).querySelector('[data-test="import-issues"]')).toBeNull()
    expect(mount(ImportIssuesBadge, { count: 0 }).querySelector('[data-test="import-issues-badge"]')).toBeNull()
    expect(mount(ImportIssuesBadge, { count: 2 }).querySelector('[data-test="import-issues-badge"]')?.textContent).toBe('2 problemas da importação')
  })
})

describe('o "Resolvido" nas stores: a resposta entra na store, sem reler', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  it('docs: o detalhe vira a resposta, e a lista troca só os problemas (fica o que só a lista tem)', async () => {
    const doc: IProjectDoc = { id: 'guia', kind: 'spec', title: 'Guia', summary: '', createdAt: '', updatedAt: '', importIssues: ISSUES }
    const docs = useDocsStore()
    docs.details.set('guia', doc)
    docs.lists.set(docs.listKey('alfa'), [{ ...doc, tokens: 12 }])
    vi.mocked(api).mockResolvedValue({ ...doc, importIssues: [ISSUES[1]] } as never)
    await docs.resolveIssue('guia', ISSUES[0])
    expect(api).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api).mock.calls[0]).toEqual(['/docs/guia/import-issues/resolve', { method: 'POST', body: { code: 'link-not-document', target: 'lint' } }])
    expect(docs.details.get('guia')?.importIssues).toEqual([ISSUES[1]])
    expect(docs.lists.get(docs.listKey('alfa'))).toEqual([{ ...doc, tokens: 12, importIssues: [ISSUES[1]] }])
  })

  it('agente: troca a lista no MESMO objeto do detalhe (o formulário aberto não se refaz) e a contagem da lista', async () => {
    const listed: IAgent = { id: 'maya', name: 'Maya', providers: [], modes: ['chat'], allowedTools: [], importIssueCount: 2 }
    const detail: IAgentDetail = { ...listed, systemPrompt: 'x', importIssues: ISSUES }
    const agents = useAgentsStore()
    agents.details.set('maya', detail)
    agents.lists.set('', [listed])
    vi.mocked(api).mockResolvedValue({ ...detail, importIssues: undefined } as never)
    await agents.resolveIssue('maya', ISSUES[1])
    expect(agents.details.get('maya')).toBe(detail)
    expect(detail.importIssues).toBeUndefined()
    expect(agents.lists.get('')?.[0].importIssueCount).toBeUndefined()
  })

  it('descartar todos os pendentes: um POST com `{ pending: true }`, e a resposta entra no detalhe e na contagem da lista', async () => {
    const listed: IAgent = { id: 'maya', name: 'Maya', providers: [], modes: ['chat'], allowedTools: [], importIssueCount: 2 }
    const detail: IAgentDetail = { ...listed, systemPrompt: 'x', importIssues: ISSUES }
    const agents = useAgentsStore()
    agents.details.set('maya', detail)
    agents.lists.set('', [listed])
    vi.mocked(api).mockResolvedValue({ ...detail, importIssues: [ISSUES[0]] } as never)
    await agents.resolveIssue('maya', { pending: true })
    expect(vi.mocked(api).mock.calls).toEqual([['/agents/maya/import-issues/resolve', { method: 'POST', body: { pending: true } }]])
    expect(agents.details.get('maya')).toBe(detail)
    expect(detail.importIssues).toEqual([ISSUES[0]])
    expect(agents.lists.get('')?.[0].importIssueCount).toBe(1)
  })
})
