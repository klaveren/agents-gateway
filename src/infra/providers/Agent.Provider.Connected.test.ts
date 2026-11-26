import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { ModelNotConfiguredError, AgentWithoutModelError } from '@domain/errors/Domain.Error'
import { IFallbackStep, IModelGroup, IModelGroupSettings } from '@domain/Fallback.Policy'
import { IAgent, IAgentTarget } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'

/** 🔌 O agente do projeto CONECTADO roda com os modelos desta máquina, pela cascata (ver `resolveConnected`). */
describe('AgentProvider — projeto conectado: a cascata de modelos desta máquina', () => {
  const PROTOCOL: Record<string, EProvider> = { claude: EProvider.CLAUDE, openai: EProvider.OPENAI }

  function setup(options: {
    connected?: boolean
    modelGroup?: string
    gateway?: IModelGroupSettings
    project?: IModelGroupSettings
    local?: IAgentTarget[]
    /** Os modelos desligados no catálogo (`provedor/modelo`). */
    off?: Set<string>
    /** Os alvos do agente (os que vieram da origem). */
    providers?: IAgentTarget[]
  }) {
    const agent: IAgent = {
      id: 'maya',
      name: 'Maya',
      projectId: 'logiccus',
      providers: options.providers ?? [{ provider: 'openai', models: ['gpt-5.6-sol'], sandbox: 'workspace-write' }],
      systemPrompt: 'p',
      modes: [EMode.CHAT],
      allowedTools: [],
      ...(options.modelGroup ? { modelGroup: options.modelGroup } : {}),
    }
    const store = new SessionStore()
    const adapter = (protocol: EProvider): IAgentAdapter => ({
      async createSession(created, input) {
        const record = store.create({ agentId: created.id, provider: input.provider!, protocol, mode: EMode.CHAT, model: input.model!, tools: false, systemPrompt: '' })
        return { id: record.id, provider: protocol, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(): AsyncIterable<IAgentEvent> {},
      async cancel() {},
    })
    const config = (id: string) =>
      PROTOCOL[id] ? { id, name: id, protocol: PROTOCOL[id], official: true, enabled: true, createdAt: new Date(), updatedAt: new Date() } : undefined
    const usable = (provider: string, model: string) => !options.off?.has(`${provider}/${model}`)
    const provider = new AgentProvider(
      new Map([
        [adapterKey(EProvider.CLAUDE, EMode.CHAT), adapter(EProvider.CLAUDE)],
        [adapterKey(EProvider.OPENAI, EMode.CHAT), adapter(EProvider.OPENAI)],
      ]),
      store,
      new NullSettingsRepository({ audience: 'all', ...(options.gateway ?? {}) }),
      {
        list: () => [agent],
        get: (id) =>
          id === agent.id
            ? { ...agent, providers: agent.providers.map((target) => ({ ...target, models: target.models.filter((model) => usable(target.provider, model)) })) }
            : undefined,
        isModelUsable: usable,
        localTargetsOf: () => options.local,
      },
      { list: () => [], get: config, connection: (id) => (config(id) ? { providerId: id, name: id, protocol: PROTOCOL[id], key: 'k' } : undefined) },
    )
    provider.useConnected((projectId) => !!options.connected && projectId === 'logiccus')
    provider.useProjectGroups(() => options.project)
    return provider
  }

  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const group = (id: string, ...steps: IFallbackStep[]): IModelGroup => ({ id, name: id, steps })
  const SONNET = { provider: 'claude', model: 'claude-sonnet-5' }
  const OPUS = { provider: 'claude', model: 'claude-opus-5' }
  const open = async (provider: AgentProvider) => {
    await settle()
    const session = await provider.createSession({ agentId: 'maya' })
    const described = provider.describe(session.id)
    return `${described.provider}/${described.model}`
  }

  it('1️⃣ o grupo do agente configurado AQUI roda; o modelo da origem nunca', async () => {
    const provider = setup({ connected: true, modelGroup: 'executor-low', project: { modelGroups: [group('executor-low', SONNET)] } })
    assert.strictEqual(await open(provider), 'claude/claude-sonnet-5')
  })

  it('o grupo do agente também vale quando está só no gateway', async () => {
    const provider = setup({ connected: true, modelGroup: 'executor-low', gateway: { modelGroups: [group('executor-low', OPUS)] } })
    assert.strictEqual(await open(provider), 'claude/claude-opus-5')
  })

  it('2️⃣ o grupo do agente não existe aqui: vale o grupo padrão do projeto, depois o do gateway', async () => {
    const project = { modelGroups: [group('rapido', OPUS)], defaultModelGroup: 'rapido' }
    assert.strictEqual(await open(setup({ connected: true, modelGroup: 'executor-low', project })), 'claude/claude-opus-5')
    const gateway = { modelGroups: [group('geral', SONNET)], defaultModelGroup: 'geral' }
    assert.strictEqual(await open(setup({ connected: true, modelGroup: 'executor-low', gateway })), 'claude/claude-sonnet-5')
  })

  it('⚖️ grupo sem nenhum passo que rode aqui não conta: cai para o próximo nível (os passos indisponíveis são pulados)', async () => {
    const project = { modelGroups: [group('executor-low', { provider: 'alibaba', model: 'qwen' }, OPUS), group('reserva', SONNET)], defaultModelGroup: 'reserva' }
    // O passo do provedor que não existe é pulado; o seguinte, do mesmo grupo, roda.
    assert.strictEqual(await open(setup({ connected: true, modelGroup: 'executor-low', project })), 'claude/claude-opus-5')
    // Com o único passo que roda desligado, o grupo não serve: vale o padrão.
    assert.strictEqual(await open(setup({ connected: true, modelGroup: 'executor-low', project, off: new Set(['claude/claude-opus-5']) })), 'claude/claude-sonnet-5')
  })

  it('3️⃣ sem grupo nenhum: o modelo padrão do projeto, depois o do gateway', async () => {
    const project = { defaultModel: OPUS }
    const gateway = { defaultModel: SONNET }
    assert.strictEqual(await open(setup({ connected: true, modelGroup: 'executor-low', project, gateway })), 'claude/claude-opus-5')
    assert.strictEqual(await open(setup({ connected: true, modelGroup: 'executor-low', gateway })), 'claude/claude-sonnet-5')
  })

  it('4️⃣ nada configurado aqui: a conversa NÃO abre e diz onde configurar', async () => {
    const provider = setup({ connected: true, modelGroup: 'executor-low' })
    await settle()
    await assert.rejects(
      provider.createSession({ agentId: 'maya' }),
      (error: unknown) => error instanceof ModelNotConfiguredError && /executor-low/.test(error.message) && /Projeto → Configurações/.test(error.message),
    )
  })

  it('🔌 os modelos que a máquina escolheu na camada local do agente valem antes do grupo', async () => {
    const provider = setup({
      connected: true,
      modelGroup: 'executor-low',
      local: [{ provider: 'claude', models: ['claude-opus-5'] }],
      project: { modelGroups: [group('executor-low', SONNET)] },
    })
    // O grupo é o que roda quando ninguém escolheu: o primeiro passo dele.
    assert.strictEqual(await open(provider), 'claude/claude-sonnet-5')
    // E a pessoa pode escolher o modelo local.
    await settle()
    const session = await provider.createSession({ agentId: 'maya', provider: 'claude', model: 'claude-opus-5' })
    assert.strictEqual(provider.describe(session.id).model, 'claude-opus-5')
  })

  it('projeto NÃO conectado: o de sempre (os modelos do agente); o modelo padrão do gateway só como último recurso', async () => {
    assert.strictEqual(await open(setup({ gateway: { defaultModel: SONNET } })), 'openai/gpt-5.6-sol')
    const off = new Set(['openai/gpt-5.6-sol'])
    assert.strictEqual(await open(setup({ gateway: { defaultModel: SONNET }, off })), 'claude/claude-sonnet-5')
    await settle()
    await assert.rejects(setup({ off }).createSession({ agentId: 'maya' }), AgentWithoutModelError)
  })
})
