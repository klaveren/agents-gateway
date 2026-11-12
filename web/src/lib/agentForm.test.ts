import { describe, expect, it } from 'vitest'
import {
  agentFacingTools,
  defaultLanes,
  envDuplicates,
  envRecord,
  envRows,
  findOrphans,
  homeProjectOf,
  isUsableProvider,
  mcpServersFor,
  pruneModels,
  pruneNatives,
  summarizeIssues,
  unionLanes,
  unionLevels,
} from './agentForm'

const natives = [
  { id: 'sdk:Read', protocol: 'claude' },
  { id: 'sdk:web_search', protocol: 'openai' },
]

describe('pruneModels', () => {
  it('mantém só os que o novo provider oferece', () => {
    expect(pruneModels(['a', 'b'], ['b', 'c'])).toEqual(['b'])
  })
  it('sem nenhum em comum, o primeiro ativado vira o padrão', () => {
    expect(pruneModels(['a'], ['x', 'y'])).toEqual(['x'])
    expect(pruneModels(['a'], [])).toEqual([])
  })
})

describe('pruneNatives', () => {
  it('tira as sdk: de família que nenhum provider tem e mantém locais, agent: e mcp:', () => {
    const allowed = ['run_bash', 'sdk:Read', 'sdk:web_search', 'agent:x', 'mcp:s/*', 'sdk:fantasma']
    expect(pruneNatives(allowed, natives, ['claude'])).toEqual(['run_bash', 'sdk:Read', 'agent:x', 'mcp:s/*'])
    // Com dois providers de famílias diferentes, as duas ficam.
    expect(pruneNatives(allowed, natives, ['claude', 'openai'])).toEqual(['run_bash', 'sdk:Read', 'sdk:web_search', 'agent:x', 'mcp:s/*'])
  })
  it('sem a família, não mexe', () => {
    expect(pruneNatives(['sdk:Read'], natives, undefined)).toEqual(['sdk:Read'])
  })
})

describe('defaultLanes', () => {
  it('assinatura: só agent', () => {
    expect(defaultLanes({ lanes: ['chat', 'agent'], subscription: true })).toEqual(['agent'])
  })
  it('API: as lanes do protocolo', () => {
    expect(defaultLanes({ lanes: ['chat', 'agent'], subscription: false })).toEqual(['chat', 'agent'])
    expect(defaultLanes({ lanes: ['agent'], subscription: false })).toEqual(['agent'])
  })
  it('protocolo desconhecido: as duas', () => {
    expect(defaultLanes(undefined)).toEqual(['chat', 'agent'])
  })
})

describe('findOrphans', () => {
  const offered = { natives: new Set(['sdk:Read']), agents: new Set(['b']), mcp: (entry: string) => entry === 'mcp:s/*' }

  it('acha sdk:, agent: e mcp: que nenhuma lista oferece', () => {
    const allowed = ['run_bash', 'sdk:Read', 'sdk:Bash', 'agent:b', 'agent:sumiu', 'mcp:s/*', 'mcp:z/t']
    expect(findOrphans(allowed, offered)).toEqual(['sdk:Bash', 'agent:sumiu', 'mcp:z/t'])
  })
  it('lista ainda não carregada: ninguém é órfão', () => {
    expect(findOrphans(['sdk:Bash', 'agent:x', 'mcp:a/b'], {})).toEqual([])
  })
})

describe('isUsableProvider', () => {
  const base = { enabled: true, credential: { configured: false, source: 'none' as const } }
  it('exige ligado e chave ou assinatura', () => {
    expect(isUsableProvider(base)).toBe(false)
    expect(isUsableProvider({ ...base, credential: { configured: true, source: 'stored' } })).toBe(true)
    expect(isUsableProvider({ ...base, subscription: true })).toBe(true)
    expect(isUsableProvider({ ...base, enabled: false, subscription: true })).toBe(false)
  })
})

describe('summarizeIssues', () => {
  it('rotula os campos e deixa sem rótulo o problema geral', () => {
    expect(summarizeIssues({ name: ['curto'], role: ['x', 'y'], _: ['geral'] }, { name: 'Nome' })).toBe('Nome (curto) · role (x; y) · geral')
  })
})

describe('unionLanes e unionLevels', () => {
  it('a lane vale se algum protocolo a roda; sem protocolo conhecido, as duas', () => {
    expect(unionLanes([{ lanes: ['agent'] }])).toEqual(['agent'])
    expect(unionLanes([{ lanes: ['agent'] }, { lanes: ['chat', 'agent'] }])).toEqual(['chat', 'agent'])
    expect(unionLanes([undefined])).toEqual(['chat', 'agent'])
  })
  it('os níveis de todos os protocolos, sem repetir', () => {
    expect(unionLevels([{ reasoningLevels: ['low', 'high'] }, { reasoningLevels: [] }, { reasoningLevels: ['none', 'low'] }])).toEqual(['low', 'high', 'none'])
  })
})

describe('variáveis de ambiente', () => {
  it('ida e volta entre o registro e as linhas da tela', () => {
    const env = { GIT_AUTHOR_NAME: 'Maya', GIT_AUTHOR_EMAIL: 'maya@x.test' }
    expect(envRows(env)).toEqual([
      { name: 'GIT_AUTHOR_NAME', value: 'Maya' },
      { name: 'GIT_AUTHOR_EMAIL', value: 'maya@x.test' },
    ])
    expect(envRecord(envRows(env))).toEqual(env)
    expect(envRows(undefined)).toEqual([])
  })
  it('linha sem nome não vai; nenhuma = null (apaga todas); o nome é aparado', () => {
    expect(envRecord([{ name: '  ', value: 'x' }])).toBeNull()
    expect(envRecord([{ name: ' LANG ', value: 'pt_BR' }])).toEqual({ LANG: 'pt_BR' })
  })
  it('acha os nomes repetidos', () => {
    expect(
      envDuplicates([
        { name: 'A', value: '1' },
        { name: 'B', value: '2' },
        { name: 'A ', value: '3' },
      ]),
    ).toEqual(['A'])
  })
})

describe('mcpServersFor', () => {
  const servers = [{ key: 'pw' }, { key: 'a.n8n', projectId: 'a' }, { key: 'b.n8n', projectId: 'b' }]
  it('⛔ agente de projeto: os globais e os do projeto dele; agente global: só os globais', () => {
    expect(mcpServersFor(servers, 'a').map((server) => server.key)).toEqual(['pw', 'a.n8n'])
    expect(mcpServersFor(servers, 'b').map((server) => server.key)).toEqual(['pw', 'b.n8n'])
    expect(mcpServersFor(servers, null).map((server) => server.key)).toEqual(['pw'])
    expect(mcpServersFor(servers, undefined).map((server) => server.key)).toEqual(['pw'])
  })
})

describe('homeProjectOf', () => {
  const here = { current: 'geral', projects: ['geral', 'logiccus'], listed: ['atlas', 'emprestado'] }
  it('agente de outro projeto: a tela troca para o projeto dele', () => {
    expect(homeProjectOf({ id: 'maya', projectId: 'logiccus' }, here)).toBe('logiccus')
  })
  it('fica onde está: o global, o do projeto atual e o compartilhado com ele', () => {
    expect(homeProjectOf({ id: 'atlas' }, here)).toBeUndefined()
    expect(homeProjectOf({ id: 'atlas', projectId: null }, here)).toBeUndefined()
    expect(homeProjectOf({ id: 'local', projectId: 'geral' }, here)).toBeUndefined()
    expect(homeProjectOf({ id: 'emprestado', projectId: 'logiccus' }, here)).toBeUndefined()
  })
  it('⛔ projeto que quem abriu não vê: não troca', () => {
    expect(homeProjectOf({ id: 'x', projectId: 'secreto' }, here)).toBeUndefined()
  })
})

describe('agentFacingTools', () => {
  it('⛔ do MCP do gateway, a tela do agente não oferece as ferramentas de conversa; dos outros, tudo', () => {
    const tools = [{ name: 'list_agents' }, { name: 'talk' }, { name: 'send_message' }, { name: 'start_conversation' }, { name: 'get_turn' }]
    expect(agentFacingTools('gateway', tools).map((tool) => tool.name)).toEqual(['list_agents'])
    expect(agentFacingTools('outro', tools)).toHaveLength(5)
  })
})
