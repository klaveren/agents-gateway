import { describe, expect, it } from 'vitest'
import { defaultLanes, findOrphans, isUsableProvider, pruneModels, pruneNatives, summarizeIssues, unionLanes, unionLevels } from './agentForm'

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
