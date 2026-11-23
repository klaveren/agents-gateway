import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { api } from '@/lib/api'
import { useAgentCommands } from '@/lib/commands'
import { CATALOG_SYNC_MS, catalogChanged } from './catalogSync'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const flush = async () => {
  for (let i = 0; i < 4; i++) await nextTick()
  await Promise.resolve()
}

/** Uma tela que mostra o `/` do agente e do projeto dados (como a conversa aberta). */
function screen(agent: ReturnType<typeof ref<string | undefined>>, project: ReturnType<typeof ref<string | undefined>>) {
  const pinia = createPinia()
  setActivePinia(pinia)
  let commands: ReturnType<typeof useAgentCommands> | undefined
  createApp(defineComponent({ setup: () => (void (commands = useAgentCommands(agent, project)), () => h('div')) }))
    .use(pinia)
    .mount(document.createElement('div'))
  return () => commands!.value
}

const commandCalls = () => vi.mocked(api).mock.calls.filter(([path]) => String(path).endsWith('/commands'))

describe('slashResources — o `/` da caixa guardado por agente e projeto', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async () => [{ id: 'resumir', kind: 'skill', description: 'Resume' }] as never)
  })
  afterEach(() => vi.useRealTimers())

  it('trocar de conversa (mesmo agente e projeto, ou voltar a um par já lido) não relê', async () => {
    const agent = ref<string | undefined>('dev')
    const project = ref<string | undefined>('xpto')
    const commands = screen(agent, project)
    await flush()
    expect(commandCalls()).toHaveLength(1)

    // Outra conversa do mesmo agente e projeto: a mesma cópia.
    agent.value = 'dev'
    await flush()
    // Outro agente: lê pela primeira vez. Voltar ao primeiro: já está lido.
    agent.value = 'outro'
    await flush()
    expect(commandCalls()).toHaveLength(2)
    agent.value = 'dev'
    await flush()
    expect(commandCalls()).toHaveLength(2)
    expect(commands().map((item) => item.id)).toEqual(['resumir'])
  })

  it('o aviso do catálogo (skill, command ou documento) faz o par que está na tela reler; regra não', async () => {
    vi.useFakeTimers()
    const commands = screen(ref<string | undefined>('dev'), ref<string | undefined>('xpto'))
    await flush()
    expect(commandCalls()).toHaveLength(1)

    catalogChanged([{ kind: 'rule', id: 'r', projectId: 'xpto', op: 'update' }])
    await vi.advanceTimersByTimeAsync(CATALOG_SYNC_MS)
    expect(commandCalls()).toHaveLength(1)

    vi.mocked(api).mockImplementation(async () => [{ id: 'novo', kind: 'command', description: 'Novo' }] as never)
    catalogChanged([{ kind: 'skill', id: 's', projectId: 'xpto', op: 'create' }])
    await vi.advanceTimersByTimeAsync(CATALOG_SYNC_MS)
    expect(commandCalls()).toHaveLength(2)
    expect(commands().map((item) => item.id)).toEqual(['novo'])
  })

  it('o par que não está na tela só fica velho: relê quando for mostrado de novo', async () => {
    vi.useFakeTimers()
    const agent = ref<string | undefined>('dev')
    screen(agent, ref<string | undefined>('xpto'))
    await flush()
    agent.value = 'outro'
    await flush()
    expect(commandCalls()).toHaveLength(2)

    catalogChanged([{ kind: 'spec', id: 'd', op: 'update' }])
    await vi.advanceTimersByTimeAsync(CATALOG_SYNC_MS)
    // Só o `outro` (na tela) relê; o `dev` espera.
    expect(commandCalls()).toHaveLength(3)
    agent.value = 'dev'
    await flush()
    expect(commandCalls()).toHaveLength(4)
  })
})
