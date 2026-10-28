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
    expect(latestDraft(turns)).toEqual({
      id: 'segunda',
      title: '',
      summary: '',
      description: 'Revisa',
      body: 'passos',
      docIds: ['api'],
      global: true,
      initialContext: [],
      saved: false,
    })
  })

  it('os campos de doc e de rule; gravado = um save que deu certo DEPOIS do último rascunho', () => {
    const spec = { tool: 'propose_draft', args: { id: 'api', title: 'API', summary: 'Padrões', body: '# API' } }
    expect(latestDraft([turn(0, [spec])])).toMatchObject({ id: 'api', title: 'API', summary: 'Padrões', saved: false })
    expect(latestDraft([turn(0, [spec]), turn(1, [{ tool: 'save_doc', error: 'recusado' }])])?.saved).toBe(false)
    expect(latestDraft([turn(0, [spec]), turn(1, [{ tool: 'mcp__mcp_gateway__save_doc', result: 'ok' }])])?.saved).toBe(true)
    // Um rascunho novo depois de gravar volta a "não gravado".
    expect(latestDraft([turn(0, [spec, { tool: 'save_doc' }]), turn(1, [{ tool: 'propose_draft', args: { title: 'Dados', body: 'Nunca apague.' } }])])).toMatchObject({
      id: '',
      title: 'Dados',
      saved: false,
    })
  })

  it('agente: id, nome, soul e prompt saem do registro; o contexto inicial e os recursos vêm junto; save_agent conta como gravado', () => {
    const call = {
      tool: 'propose_draft',
      args: {
        agent: { id: 'revisor', name: 'Revisor', soul: 'Direto.', systemPrompt: 'Revise.', projectId: 'xpto' },
        initialContext: ['api'],
        resources: { skills: ['*'], commands: [] },
      },
    }
    expect(latestDraft([turn(0, [call])])).toMatchObject({
      id: 'revisor',
      title: 'Revisor',
      description: 'Direto.',
      body: 'Revise.',
      global: false,
      initialContext: ['api'],
      resources: { skills: ['*'], commands: [] },
      saved: false,
    })
    expect(latestDraft([turn(0, [call, { tool: 'save_agent', result: 'ok' }])])?.saved).toBe(true)
  })

  it('sem chamada, ou com argumentos ilegíveis, não há rascunho', () => {
    expect(latestDraft([])).toBeUndefined()
    expect(latestDraft([turn(0, [{ tool: 'propose_draft', args: '{quebrado' }])])).toBeUndefined()
    expect(latestDraft([turn(0, [{ tool: 'propose_draft', args: { description: 'sem corpo' } }])])).toBeUndefined()
  })
})

describe('coreAgentName', () => {
  it('nomeia os construtores; o resto não', () => {
    expect([coreAgentName('builder-command'), coreAgentName('builder-adr'), coreAgentName('atlas'), coreAgentName(undefined)]).toEqual([
      'Construtor de commands',
      'Construtor de ADRs',
      undefined,
      undefined,
    ])
  })
})
