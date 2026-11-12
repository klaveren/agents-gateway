import { describe, expect, it } from 'vitest'
import { disabledTools, layerTools, originHasTool, shownTools } from './localLayer'

const ORIGIN = ['run_bash', 'mcp:agents/tickets', 'off:read_doc', 'off:deliver_file']

describe('camada local: as ferramentas', () => {
  it('mostra a origem com a camada por cima; a automática religada perde a marca', () => {
    expect(shownTools(ORIGIN, ['agent:ajudante', 'read_doc'])).toEqual(['run_bash', 'mcp:agents/tickets', 'off:deliver_file', 'agent:ajudante'])
  })

  it('não repete o que a origem já tem, nem aceita marca de desligar na camada', () => {
    expect(shownTools(ORIGIN, ['run_bash', 'off:ledger_read'])).toEqual(ORIGIN)
  })

  it('grava só o que o formulário tem a mais; a marca que saiu vira o pedido de religar', () => {
    const form = ['run_bash', 'mcp:agents/tickets', 'off:deliver_file', 'agent:ajudante', 'mcp:local/*']
    expect(layerTools(ORIGIN, form)).toEqual(['agent:ajudante', 'mcp:local/*', 'read_doc'])
  })

  it('o que saiu do formulário e veio da origem é o que esta máquina desligou; a automática vai pelo nome', () => {
    // Tirou `run_bash` e o MCP, e desligou `ledger_read`: nada disso é "a mais", tudo é "desligado aqui".
    const form = ['off:read_doc', 'off:deliver_file', 'off:ledger_read']
    expect(layerTools(ORIGIN, form)).toEqual([])
    expect(disabledTools(ORIGIN, form)).toEqual(['run_bash', 'mcp:agents/tickets', 'ledger_read'])
    // O que a origem já desligou não entra, e o que é só daqui também não.
    expect(disabledTools(ORIGIN, [...ORIGIN, 'agent:ajudante'])).toEqual([])
  })

  it('mostra sem o que foi desligado aqui; a automática desligada ganha a marca', () => {
    expect(shownTools(ORIGIN, ['agent:ajudante'], ['mcp:agents/tickets', 'ledger_read'])).toEqual([
      'run_bash',
      'off:read_doc',
      'off:deliver_file',
      'agent:ajudante',
      'off:ledger_read',
    ])
  })

  it('ida e volta: o que a camada grava é o que o formulário mostra', () => {
    const layer = ['agent:ajudante', 'read_doc']
    const disabled = ['run_bash', 'ledger_read']
    const form = shownTools(ORIGIN, layer, disabled)
    expect(layerTools(ORIGIN, form)).toEqual(layer)
    expect(disabledTools(ORIGIN, form)).toEqual(disabled)
  })

  it('o que veio ligado da origem: a entrada dela e a automática que ela não desligou', () => {
    expect(originHasTool(ORIGIN, 'run_bash')).toBe(true)
    expect(originHasTool(ORIGIN, 'search_web')).toBe(false)
    expect(originHasTool(ORIGIN, 'ledger_read')).toBe(true)
    expect(originHasTool(ORIGIN, 'read_doc')).toBe(false)
  })
})
