import { describe, expect, it } from 'vitest'
import { layerTools, originLocksTool, shownTools } from './localLayer'

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

  it('⛔ o que a origem tem não sai, e a camada não desliga automática', () => {
    // Tirou `run_bash` e desligou `ledger_read` no formulário: nada disso vai para a camada.
    expect(layerTools(ORIGIN, ['off:read_doc', 'off:deliver_file', 'off:ledger_read'])).toEqual([])
  })

  it('ida e volta: o que a camada grava é o que o formulário mostra', () => {
    const layer = ['agent:ajudante', 'read_doc']
    expect(layerTools(ORIGIN, shownTools(ORIGIN, layer))).toEqual(layer)
  })

  it('trava o que é da origem: a entrada dela e a automática ligada; a desligada por ela pode ser religada', () => {
    expect(originLocksTool(ORIGIN, 'run_bash')).toBe(true)
    expect(originLocksTool(ORIGIN, 'search_web')).toBe(false)
    expect(originLocksTool(ORIGIN, 'ledger_read')).toBe(true)
    expect(originLocksTool(ORIGIN, 'read_doc')).toBe(false)
  })
})
