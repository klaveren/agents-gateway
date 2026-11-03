import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { api } from '@/lib/api'
import { useAgentCommands } from '@/lib/commands'
import type { IResource, IRule } from '@/lib/types'
import { useScopedDocs } from '@/composables/useCatalogLists'
import { useAccountsStore } from './accounts'
import { useAgentCatalogStore } from './agentCatalog'
import { useBuilderStore } from './builder'
import { useDocsStore } from './docs'
import { useResourcesStore } from './resources'
import { useRulesStore } from './rules'
import { useTokensStore } from './tokens'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const flush = async () => {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
}

/** Monta um componente que só roda `setup` (o composable), na pinia ativa. */
function mount(setup: () => unknown) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const host = document.createElement('div')
  createApp(defineComponent({ setup: () => (setup(), () => h('div')) }))
    .use(pinia)
    .mount(host)
}

const resource = (id: string, projectId?: string, kind: IResource['kind'] = 'skill'): IResource =>
  ({ id, kind, description: id, body: '', docIds: [], createdAt: '', updatedAt: '', ...(projectId ? { projectId } : {}) }) as IResource

describe('stores do catálogo', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  it('docs: duas telas com o mesmo escopo leem a mesma lista, numa chamada só', async () => {
    vi.mocked(api).mockImplementation(async (_path, options) => [{ id: `doc-${String((options as { query: { project: string } }).query.project)}` }])
    let first: ReturnType<typeof useScopedDocs> | undefined
    let second: ReturnType<typeof useScopedDocs> | undefined
    mount(() => {
      first = useScopedDocs('xpto', 'spec')
      second = useScopedDocs('xpto', 'spec')
    })
    await flush()
    expect(vi.mocked(api).mock.calls).toEqual([
      ['/docs', { query: { project: 'global', kind: 'spec' } }],
      ['/docs', { query: { project: 'xpto', kind: 'spec' } }],
    ])
    expect(first!.list.value.map((doc) => doc.id)).toEqual(['doc-xpto', 'doc-global'])
    expect(second!.list.value).toEqual(first!.list.value)
  })

  it('docs: gravar põe o documento na store e relê só as listas do escopo dele', async () => {
    const docs = useDocsStore()
    vi.mocked(api).mockResolvedValue([])
    await Promise.all([docs.lists.ensure(docs.listKey('global')), docs.lists.ensure(docs.listKey('xpto')), docs.lists.ensure(docs.listKey('xpto', 'spec'))])
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path) => (path === '/docs/nomes' ? { id: 'nomes', kind: 'spec', projectId: 'xpto', title: 'Nomes' } : []))

    await docs.update('nomes', { kind: 'spec', title: 'Nomes', summary: '', body: 'x', projectId: 'xpto', docIds: [], docRefs: [] })

    expect(docs.details.get('nomes')?.title).toBe('Nomes')
    expect(vi.mocked(api).mock.calls.map(([path, options]) => [path, (options as { query?: unknown }).query])).toEqual([
      ['/docs/nomes', undefined],
      ['/docs', { project: 'xpto' }],
      ['/docs', { project: 'xpto', kind: 'spec' }],
    ])
  })

  it('resources: criar e mover de escopo trocam a lista sem reler', async () => {
    const resources = useResourcesStore()
    vi.mocked(api).mockImplementation(async (_path, options) => ((options as { query: { project: string } }).query.project === 'global' ? [resource('b')] : []))
    await Promise.all([resources.lists.ensure(resources.listKey('global', 'skill')), resources.lists.ensure(resources.listKey('xpto'))])
    vi.mocked(api).mockReset()

    vi.mocked(api).mockResolvedValueOnce(resource('a'))
    await resources.create({ id: 'a', kind: 'skill', description: 'a', body: '', projectId: null, docIds: [], docRefs: [] })
    expect(resources.lists.get(resources.listKey('global', 'skill'))?.map((item) => item.id)).toEqual(['a', 'b'])

    vi.mocked(api).mockResolvedValueOnce(resource('b', 'xpto'))
    await resources.update('b', { description: 'b', body: '', projectId: 'xpto', docIds: [], docRefs: [] })
    expect(resources.lists.get(resources.listKey('global', 'skill'))?.map((item) => item.id)).toEqual(['a'])
    expect(resources.lists.get(resources.listKey('xpto'))?.map((item) => item.id)).toEqual(['b'])
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('rules: a nova vai para o fim, o move devolve a ordem nova, apagar tira — sem reler', async () => {
    const rules = useRulesStore()
    const rule = (id: string) => ({ id, title: id, body: id, enabled: true, position: 0 }) as IRule
    vi.mocked(api).mockResolvedValueOnce([rule('a')])
    await rules.lists.ensure('global')

    vi.mocked(api).mockResolvedValueOnce(rule('b'))
    await rules.create('global', { title: 'b', body: 'b' })
    vi.mocked(api).mockResolvedValueOnce([rule('b'), rule('a')])
    await rules.move(rule('b'), 'up')
    vi.mocked(api).mockResolvedValueOnce(null)
    await rules.remove(rule('a'))

    expect(rules.lists.get('global')?.map((item) => item.id)).toEqual(['b'])
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(['/rules', '/rules', '/rules/b/move', '/rules/a'])
  })

  it('o `/` do agente: as telas com o mesmo agente e projeto leem uma cópia; o catálogo mudou, relê', async () => {
    vi.mocked(api).mockResolvedValue([{ id: 'resumir', description: 'Resume' }])
    const agent = ref<string | undefined>('dev')
    const project = ref<string | undefined>('xpto')
    let a: ReturnType<typeof useAgentCommands> | undefined
    let b: ReturnType<typeof useAgentCommands> | undefined
    mount(() => {
      a = useAgentCommands(agent, project)
      b = useAgentCommands(agent, project)
    })
    await flush()
    expect(api).toHaveBeenCalledTimes(1)
    expect(api).toHaveBeenCalledWith('/agents/dev/commands', { query: { project: 'xpto' } })
    expect(a!.value.map((item) => item.id)).toEqual(['resumir'])
    expect(b!.value).toEqual(a!.value)

    useAgentCatalogStore().invalidate()
    await flush()
    expect(api).toHaveBeenCalledTimes(2)
    expect(a!.value.map((item) => item.id)).toEqual(['resumir'])
  })

  it('recursos do agente: salvar põe a resposta na store, sem reler', async () => {
    const catalog = useAgentCatalogStore()
    vi.mocked(api).mockResolvedValueOnce({ skills: ['*'], commands: ['*'] })
    await catalog.resources.ensure('dev')
    vi.mocked(api).mockResolvedValueOnce({ skills: ['a'], commands: [] })
    await catalog.saveResources('dev', { skills: ['a'], commands: [] })
    await catalog.resources.ensure('dev')
    expect(catalog.resources.get('dev')).toEqual({ skills: ['a'], commands: [] })
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('protocolo: o complemento global gravado vale nas chaves de projeto do tipo, sem reler', async () => {
    const builder = useBuilderStore()
    const core = { kind: 'skill', version: '1', title: 'Skill', body: '' } as const
    vi.mocked(api).mockResolvedValueOnce({ core, addenda: { project: { body: 'do projeto', updatedAt: '' } } })
    await builder.protocols.ensure(builder.key('skill', 'xpto'))
    vi.mocked(api).mockResolvedValueOnce({ core, addenda: { global: { body: 'global novo', updatedAt: '' } } })
    await builder.saveAddendum('skill', null, 'global novo')

    expect(builder.protocols.get(builder.key('skill', 'xpto'))?.addenda).toEqual({ global: { body: 'global novo', updatedAt: '' }, project: { body: 'do projeto', updatedAt: '' } })
    expect(builder.protocols.get(builder.key('skill'))?.addenda.global?.body).toBe('global novo')
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('tokens: o criado entra no topo, e o token nunca fica na store', async () => {
    const tokens = useTokensStore()
    vi.mocked(api).mockResolvedValueOnce([{ id: 'velho', name: 'CI', prefix: 'agw_v', createdAt: '' }])
    await tokens.lists.ensure('u1')
    vi.mocked(api).mockResolvedValueOnce({ id: 'novo', name: 'Claude Code', prefix: 'agw_n', createdAt: '', token: 'agw_segredo' })
    const created = await tokens.create('u1', { name: 'Claude Code' })

    expect(created.token).toBe('agw_segredo')
    expect(tokens.lists.get('u1')?.map((item) => item.id)).toEqual(['novo', 'velho'])
    expect(JSON.stringify(tokens.lists.get('u1'))).not.toContain('agw_segredo')
  })

  it('contas: a salva entra pelo id, a apagada sai — sem reler', async () => {
    const accounts = useAccountsStore()
    const account = (id: string) => ({ id, kind: 'secret-env', label: id, public: {}, exposesSecret: true, updatedAt: '' }) as const
    vi.mocked(api).mockResolvedValueOnce({ accounts: [account('a'), account('c')] })
    await accounts.lists.ensure('xpto')
    vi.mocked(api).mockResolvedValueOnce(account('b'))
    await accounts.save('xpto', 'b', { kind: 'secret-env', label: 'b', public: {} })
    vi.mocked(api).mockResolvedValueOnce({ removed: 'a' })
    await accounts.remove('xpto', 'a')

    expect(accounts.lists.get('xpto')?.map((item) => item.id)).toEqual(['b', 'c'])
    expect(api).toHaveBeenCalledTimes(3)
  })
})
