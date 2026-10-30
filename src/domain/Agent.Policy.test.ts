import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentIssues, IAgentRules, targetFor } from './Agent.Policy'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { IAgent } from './models/Agent.Model'

describe('agentIssues', () => {
  const rules: IAgentRules = {
    takenIds: ['operador-teste'],
    knownTools: ['search_web'],
    providerOf: (model) => (model.startsWith('gemini') ? EProvider.GOOGLE : model.startsWith('gpt') ? EProvider.OPENAI : undefined),
  }

  const agent = (over: Partial<IAgent> = {}): IAgent => ({
    id: 'pesquisa-juridica',
    name: 'Pesquisa jurídica',
    providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }],
    systemPrompt: 'Você pesquisa jurisprudência.',
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['search_web'],
    ...over,
  })

  const fields = (issues: Array<{ field: string }>) => issues.map((issue) => issue.field)

  it('um agente certo não tem problema nenhum', () => {
    assert.deepStrictEqual(agentIssues(agent(), rules), [])
  })

  it('triggers: id em slug e único, "quando" numa linha só, corpo obrigatório', () => {
    const ok = { id: 'morning-brief', when: 'a pessoa diz bom dia', body: 'Briefing em bullets.' }
    assert.deepStrictEqual(agentIssues(agent({ triggers: [ok] }), rules), [])
    const messages = agentIssues(agent({ triggers: [ok, ok, { id: 'Ruim', when: 'a\nb', body: ' ' }] }), rules).map((issue) => issue.message)
    assert.deepStrictEqual(messages, [
      'id "morning-brief" listed twice',
      'id "Ruim": lowercase letters, digits and hyphens, 2 to 64',
      'Ruim: when is one line',
      'Ruim: body is required',
    ])
  })

  it('⚖️ o tamanho do prompt e da soul é de quem cria; só Codex e Antigravity têm o teto do argumento do Linux', () => {
    const big = 'x'.repeat(200_000)
    assert.deepStrictEqual(agentIssues(agent({ systemPrompt: big, soul: big }), rules), [], 'sem teto do sistema')
    const onCli = (protocol: EProvider, soul: string) =>
      agentIssues(agent({ providers: [{ provider: 'p', models: ['m'] }], modes: [EMode.AGENT], allowedTools: [], soul }), {
        ...rules,
        protocolOf: () => protocol,
        modelEnabled: () => true,
      }).map((issue) => issue.message)
    assert.match(onCli(EProvider.CODEX, big).join(' | '), /command-line argument.*128 KiB.*now 200 KB/)
    assert.match(onCli(EProvider.ANTIGRAVITY, big).join(' | '), /command-line argument/)
    assert.deepStrictEqual(onCli(EProvider.CODEX, 'x'.repeat(50_000)), [], 'abaixo do teto passa')
  })

  it('⛔ sandbox só no protocolo que o tem, e só nos níveis dele; rede só onde o sandbox a separa', () => {
    const on = (target: Partial<IAgent['providers'][number]>, protocol: EProvider) =>
      agentIssues(agent({ providers: [{ provider: 'p', models: ['m'], ...target }], modes: [EMode.AGENT], allowedTools: [] }), {
        ...rules,
        protocolOf: () => protocol,
        modelEnabled: () => true,
      }).map((issue) => issue.message)

    // ⛔ O Codex não tem nível nem rede a escolher: roda sempre só leitura (o terminal é o do gateway).
    assert.deepStrictEqual(on({ sandbox: 'full', network: true }, EProvider.CODEX), ['p: has no sandbox to set', 'p: has no sandbox network to open'])
    assert.deepStrictEqual(on({ sandbox: 'full' }, EProvider.ANTIGRAVITY), ['p: has no sandbox to set'])
    assert.deepStrictEqual(on({ network: true }, EProvider.ANTIGRAVITY), ['p: has no sandbox network to open'])
    assert.deepStrictEqual(on({ sandbox: 'read-only' }, EProvider.CLAUDE), ['p: has no sandbox to set'])
  })

  it('devolve TODOS os problemas de uma vez, campo a campo', () => {
    const issues = agentIssues(agent({ id: 'X', name: ' ', providers: [{ provider: EProvider.GOOGLE, models: [] }], modes: [], systemPrompt: '' }), rules)

    assert.deepStrictEqual(fields(issues), ['id', 'name', 'models', 'modes', 'systemPrompt'])
  })

  it('⚠️ nível de raciocínio tem de ser do protocolo; o Google não tem nenhum', () => {
    const claude = agent({ providers: [{ provider: EProvider.CLAUDE, models: ['claude-x'] }], allowedTools: [], reasoningEfforts: ['low', 'minimal'] })
    assert.deepStrictEqual(
      agentIssues(claude, { ...rules, modelEnabled: () => true }).map((issue) => [issue.field, issue.message]),
      [['reasoningEfforts', 'minimal is not a reasoning level of claude']],
    )
    assert.deepStrictEqual(fields(agentIssues(agent({ reasoningEfforts: ['low'] }), rules)), ['reasoningEfforts'])
    assert.deepStrictEqual(agentIssues(agent({ providers: [{ provider: EProvider.OPENAI, models: ['gpt-5'] }], reasoningEfforts: ['none', 'xhigh'] }), rules), [])
  })

  it('⛔ MCP: formato mcp:<servidor>/<ferramenta> e servidor existente (a ferramenta não é exigida)', () => {
    const withServers = { ...rules, mcpServerExists: (id: string) => id === 'crm' }
    assert.deepStrictEqual(agentIssues(agent({ allowedTools: ['mcp:crm/stats', 'mcp:crm/*'] }), withServers), [])
    assert.deepStrictEqual(
      agentIssues(agent({ allowedTools: ['mcp:outro/x', 'mcp:crm', 'mcp:/x'] }), withServers).map((issue) => issue.message.split(':')[0]),
      ['unknown MCP server', 'invalid MCP tool (use mcp', 'invalid MCP tool (use mcp'],
    )
    // Sem nenhum servidor cadastrado, qualquer MCP é recusado.
    assert.deepStrictEqual(fields(agentIssues(agent({ allowedTools: ['mcp:crm/x'] }), rules)), ['allowedTools'])
  })

  it('⛔ delegação: a um agente que existe, nunca a si mesmo', () => {
    const withAgents = { ...rules, agentExists: (id: string) => ['tradutor', 'pesquisa-juridica'].includes(id) }
    assert.deepStrictEqual(agentIssues(agent({ allowedTools: ['agent:tradutor'] }), withAgents), [])
    assert.deepStrictEqual(
      agentIssues(agent({ allowedTools: ['agent:pesquisa-juridica', 'agent:fantasma', 'agent:'] }), withAgents).map((issue) => issue.message),
      ['an agent cannot delegate to itself', 'unknown agent to delegate to: fantasma', 'invalid delegation (use agent:<id>): agent:'],
    )
  })

  it('recusa id que já existe', () => {
    assert.deepStrictEqual(fields(agentIssues(agent({ id: 'operador-teste' }), rules)), ['id'])
  })

  it('⚠️ recusa modelo de outro provider, e modelo que ninguém reconhece', () => {
    const issues = agentIssues(agent({ providers: [{ provider: EProvider.GOOGLE, models: ['gpt-5.6-sol', 'llama-9'] }] }), rules)

    assert.deepStrictEqual(
      issues.map((issue) => issue.message),
      ['gpt-5.6-sol is a openai model', 'unknown model: llama-9'],
    )
  })

  it('⛔ recusa tool fora do perímetro (ex.: run_bash fora do perímetro)', () => {
    assert.deepStrictEqual(fields(agentIssues(agent({ allowedTools: ['search_web', 'run_bash'] }), rules)), ['allowedTools'])
  })

  it('o problema de prompt do provider vira problema do campo', () => {
    const issues = agentIssues(agent(), { ...rules, promptIssue: () => 'chaves viram variável' })

    assert.deepStrictEqual(issues, [{ field: 'systemPrompt', message: 'chaves viram variável' }])
  })
  it('com catálogo, modelo não ativado é recusado — e o palpite pelo prefixo deixa de valer', () => {
    const withCatalog = { ...rules, protocolOf: () => EProvider.GOOGLE, modelEnabled: (_provider: string, model: string) => model === 'gemini-3.7-flash' }

    assert.deepStrictEqual(agentIssues(agent(), withCatalog), [])
    assert.deepStrictEqual(
      agentIssues(agent({ providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash', 'gemini-desligado'] }] }), withCatalog).map((item) => item.message),
      ['google: not enabled in Providers → Models: gemini-desligado'],
    )
  })

  it('⛔ assinatura só na lane agent; o Claude da assinatura usa as nativas do Claude', () => {
    const codex = agent({ providers: [{ provider: 'codex', models: ['gpt-6.1-sol'] }], modes: [EMode.CHAT, EMode.AGENT], allowedTools: [] })
    assert.deepStrictEqual(
      agentIssues(codex, { ...rules, modelEnabled: () => true }).map((issue) => [issue.field, issue.message]),
      [['modes', 'codex runs only in the agent lane']],
    )
    const claudeSub = agent({ providers: [{ provider: 'claude-sub', models: ['claude-opus-5-5'] }], modes: [EMode.AGENT], allowedTools: ['sdk:WebSearch'] })
    assert.deepStrictEqual(agentIssues(claudeSub, { ...rules, modelEnabled: () => true }), [])
  })
})

describe('agentIssues — vários providers', () => {
  const rules: IAgentRules = { takenIds: [], knownTools: [], modelEnabled: () => true }
  const agent = (over: Partial<IAgent> = {}): IAgent => ({
    id: 'hibrido',
    name: 'Híbrido',
    providers: [
      { provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] },
      { provider: 'codex', models: ['gpt-6.1-sol'] },
    ],
    systemPrompt: 'p',
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: [],
    ...over,
  })

  it('a lane vale se ALGUM provider a roda: chat com Claude + assinatura passa; só assinatura, não', () => {
    assert.deepStrictEqual(agentIssues(agent(), rules), [])
    assert.deepStrictEqual(
      agentIssues(agent({ providers: [{ provider: 'codex', models: ['gpt-6.1-sol'] }] }), rules).map((issue) => issue.field),
      ['modes'],
    )
  })

  it('nível e nativa valem se algum provider os aceita; nenhum provider, provider repetido e provider sem modelo são recusados', () => {
    // `minimal` é só do Codex, `max` só do Claude; `sdk:WebSearch` é da família Claude. `none` não é de nenhum dos dois.
    assert.deepStrictEqual(agentIssues(agent({ reasoningEfforts: ['minimal', 'max'], allowedTools: ['sdk:WebSearch'] }), rules), [])
    assert.deepStrictEqual(
      agentIssues(agent({ reasoningEfforts: ['none'] }), rules).map((issue) => issue.message),
      ['none is not a reasoning level of claude, codex'],
    )
    assert.deepStrictEqual(
      agentIssues(agent({ providers: [] }), rules).map((issue) => [issue.field, issue.message]),
      [['providers', 'at least one provider']],
    )
    assert.deepStrictEqual(
      agentIssues(
        agent({
          providers: [
            { provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] },
            { provider: EProvider.CLAUDE, models: [] },
          ],
        }),
        rules,
      ).map((issue) => issue.message),
      ['listed twice: claude', 'claude: at least one model'],
    )
  })

  it('o modelo é conferido no catálogo DO SEU provider', () => {
    const enabled = (provider: string, model: string) => (provider === 'codex' ? model === 'gpt-6.1-sol' : model === 'claude-sonnet-5')
    assert.deepStrictEqual(
      agentIssues(
        agent({
          providers: [
            { provider: EProvider.CLAUDE, models: ['gpt-6.1-sol'] },
            { provider: 'codex', models: ['gpt-6.1-sol'] },
          ],
        }),
        { ...rules, modelEnabled: enabled },
      ).map((issue) => issue.message),
      ['claude: not enabled in Providers → Models: gpt-6.1-sol'],
    )
  })
})

describe('targetFor', () => {
  const agent: IAgent = {
    id: 'pesquisa-teste',
    name: 'Pesquisa (teste)',
    providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash', 'gemini-3.6-flash'] }],
    systemPrompt: 'Você pesquisa.',
    modes: [EMode.CHAT],
    allowedTools: [],
  }
  const models = agent.providers[0].models

  it('mantém o modelo que o agente declara', () => {
    assert.strictEqual(targetFor(agent, undefined, models[1])?.model, models[1])
  })

  it('cai no primeiro do agente quando o modelo é de outro provider', () => {
    assert.strictEqual(targetFor(agent, undefined, 'um-modelo-de-outro-provider')?.model, models[0])
  })

  it('sem modelo pedido vale o padrão do agente (o primeiro): não há mais padrão no adapter', () => {
    assert.strictEqual(targetFor(agent, undefined, undefined)?.model, models[0])
    assert.strictEqual(targetFor(agent, undefined, '')?.model, models[0])
    assert.strictEqual(targetFor({ ...agent, providers: [{ provider: EProvider.GOOGLE, models: [] }] }, undefined, undefined), undefined)
  })

  it('com vários providers: o par pedido; só o modelo, o primeiro provider que o tem; o padrão pula o que não pode rodar', () => {
    const hybrid: IAgent = {
      ...agent,
      providers: [
        { provider: 'claude', models: ['opus', 'sonnet'] },
        { provider: 'claude-sub', models: ['opus'] },
      ],
    }

    assert.deepStrictEqual(targetFor(hybrid, 'claude-sub', 'opus'), { provider: 'claude-sub', model: 'opus' })
    assert.deepStrictEqual(targetFor(hybrid, undefined, 'opus'), { provider: 'claude', model: 'opus' })
    assert.deepStrictEqual(targetFor(hybrid, 'claude-sub'), { provider: 'claude-sub', model: 'opus' })
    assert.deepStrictEqual(targetFor(hybrid, 'claude-sub', 'sonnet'), { provider: 'claude', model: 'opus' })
    assert.deepStrictEqual(
      targetFor(hybrid, undefined, undefined, (target) => target.provider !== 'claude'),
      { provider: 'claude-sub', model: 'opus' },
    )
    assert.strictEqual(targetFor({ ...hybrid, providers: [] }), undefined)
  })
})
