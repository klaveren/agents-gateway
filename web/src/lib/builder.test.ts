import { describe, expect, it } from 'vitest'
import { coreAgentName, latestDraft } from './builder'
import type { ITurn } from './types'

const turn = (index: number, toolCalls: ITurn['toolCalls']): ITurn => ({ sessionId: 's', index, at: '', request: '', text: '', toolCalls }) as ITurn

describe('latestDraft', () => {
  it('a última chamada que deu certo vence; a que voltou com problemas não conta', () => {
    const turns = [
      turn(0, [{ tool: 'propose_draft', args: { id: 'primeira', description: 'd', body: 'b' }, result: 'Draft delivered' }]),
      turn(1, [
        { tool: 'mcp__local__propose_draft', args: JSON.stringify({ id: 'segunda', description: ' Revisa ', body: 'passos', docIds: ['api', 3], global: true }) },
        { tool: 'propose_draft', args: { id: 'ruim', description: '', body: 'x' }, result: 'The draft has problems — fix and call again' },
        { tool: 'propose_draft', args: { id: 'falhou', description: 'd', body: 'b' }, error: 'boom' },
        { tool: 'read_doc', args: { id: 'api' } },
      ]),
    ]
    expect(latestDraft(turns)).toEqual({ id: 'segunda', description: 'Revisa', body: 'passos', docIds: ['api'], global: true })
  })

  it('sem chamada, ou com argumentos ilegíveis, não há rascunho', () => {
    expect(latestDraft([])).toBeUndefined()
    expect(latestDraft([turn(0, [{ tool: 'propose_draft', args: '{quebrado' }])])).toBeUndefined()
    expect(latestDraft([turn(0, [{ tool: 'propose_draft', args: { description: 'sem id' } }])])).toBeUndefined()
  })
})

describe('coreAgentName', () => {
  it('nomeia os construtores; o resto não', () => {
    expect([coreAgentName('builder-command'), coreAgentName('atlas'), coreAgentName(undefined)]).toEqual(['Construtor de commands', undefined, undefined])
  })
})
