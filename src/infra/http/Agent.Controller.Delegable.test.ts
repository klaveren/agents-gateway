import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IAgent } from '@domain/models/Agent.Model'
import { delegable } from './Agent.Controller'

describe('delegable', () => {
  const agents = (runnable: boolean) => ({
    get: (id: string) => (['builder-skill', 'pesquisa'].includes(id) ? ({ id } as IAgent) : undefined),
    isRunnable: () => runnable,
  })

  it('o construtor do core vale mesmo sem modelo ativo (o Atlas sem modelo salvava contra ele); o agente comum, só rodando', () => {
    assert.strictEqual(delegable('builder-skill', agents(false)), true)
    assert.strictEqual(delegable('pesquisa', agents(false)), false)
    assert.strictEqual(delegable('pesquisa', agents(true)), true)
    assert.strictEqual(delegable('nao-existe', agents(true)), false)
  })
})
