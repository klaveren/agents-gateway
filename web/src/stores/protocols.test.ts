import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentsStore } from './agents'
import { useProtocolsStore } from './protocols'

describe('protocols', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('levelsFor: só os níveis do protocolo, na ordem que o servidor manda', () => {
    const protocols = useProtocolsStore()
    protocols.list = [
      {
        id: 'claude',
        label: 'Anthropic',
        subscription: false,
        lanes: ['chat', 'agent'],
        reasoningLevels: ['low', 'medium', 'high', 'max'],
        nativeFamily: 'claude',
        brand: 'claude',
      },
      { id: 'google', label: 'Gemini', subscription: false, lanes: ['chat', 'agent'], reasoningLevels: [], nativeFamily: 'google', brand: 'google' },
    ]

    expect(protocols.levelsFor('claude', ['max', 'minimal', 'low'])).toEqual(['low', 'max'])
    expect(protocols.levelsFor('google', ['low'])).toEqual([])
    expect(protocols.levelsFor('desconhecido', ['low'])).toEqual([])
  })

  it('nome e cor do provider pelo que vem do servidor: o nome do banco no agente, a cor pela marca', () => {
    const protocols = useProtocolsStore()
    protocols.list = [{ id: 'codex', label: 'Codex', subscription: true, lanes: ['agent'], reasoningLevels: [], nativeFamily: 'codex', brand: 'openai' }]
    useAgentsStore().list = [
      {
        id: 'a',
        name: 'A',
        provider: 'chatgpt',
        models: [],
        pricing: {},
        modes: ['agent'],
        allowedTools: [],
        providerInfo: { id: 'chatgpt', name: 'ChatGPT da Ana', protocol: 'codex' },
      },
    ]

    expect(protocols.providerName('chatgpt')).toBe('ChatGPT da Ana')
    expect(protocols.providerColor('chatgpt')).toBe('bg-openai')
    expect(protocols.providerName('sumiu')).toBe('sumiu')
    expect(protocols.providerColor('sumiu')).toBe('bg-zinc-600')
  })
})
