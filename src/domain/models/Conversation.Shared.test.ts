/**
 * GUARD — o que um link público mostra, e o que ele NUNCA mostra.
 *
 * O registro de um turno carrega o retorno CRU das ferramentas, o raciocínio do modelo, os anexos e o
 * rótulo interno da conversa. Nada disso é assunto de quem abre um link. Este teste falha se alguém
 * acrescentar campo ao turno e a projeção passar a copiá-lo por acidente.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IConversationSession, IConversationTurn, toSharedConversation } from './Conversation.Model'

const SESSION: IConversationSession & { shareId: string } = {
  id: 'google-agent-abc',
  agentId: 'researcher-agent',
  provider: 'google',
  mode: 'agent',
  model: 'gemini-3.7-flash',
  title: 'Pedido do cliente Demonstração',
  createdAt: new Date('2026-09-01T10:00:00Z'),
  updatedAt: new Date('2026-09-01T10:05:00Z'),
  turns: 1,
  usage: { inputTokens: 100, outputTokens: 20 },
  metadata: { owner: { id: 'u1', email: 'dono@x.test', account: 'a1' } },
  classification: 'red',
  shared: true,
  shareId: 'Zm9vYmFyYmF6',
}

const TURN: IConversationTurn = {
  sessionId: SESSION.id,
  index: 0,
  at: new Date('2026-09-01T10:01:00Z'),
  request: 'Monte um pedido com o SKU-1',
  files: [{ name: 'cartao.png', mimeType: 'image/png', size: 2048 }],
  text: 'Montei o carrinho com 1 item.',
  reasoning: 'O usuário quer um pedido; vou resolver o SKU antes.',
  toolCalls: [{ tool: 'customer_search', args: { id: '37765628000198' }, result: { name: 'Demonstração', address: 'Rua X, 100' } }],
  usage: { inputTokens: 100, outputTokens: 20 },
  classification: 'amber',
}

describe('toSharedConversation', () => {
  const shared = toSharedConversation(SESSION, [TURN])

  it('entrega a pergunta e a resposta', () => {
    assert.deepEqual(shared.turns, [{ at: TURN.at, request: TURN.request, text: TURN.text }])
  })

  it('entrega o título e a data, para a página ter cabeçalho', () => {
    assert.equal(shared.title, SESSION.title)
    assert.equal(shared.createdAt, SESSION.createdAt)
  })

  it('o id público é o shareId, nunca o id interno da sessão', () => {
    assert.equal(shared.id, 'Zm9vYmFyYmF6')
    assert.equal(JSON.stringify(shared).includes(SESSION.id), false)
  })

  it('⛔ não vaza NADA do turno além de hora, pergunta e resposta', () => {
    assert.deepEqual(Object.keys(shared.turns[0]).sort(), ['at', 'request', 'text'])
  })

  it('⛔ não vaza o metadata (a identidade do dono), o consumo, o modelo, o provider nem o rótulo', () => {
    assert.deepEqual(Object.keys(shared).sort(), ['createdAt', 'id', 'title', 'turns'])
    assert.equal(JSON.stringify(shared).includes('dono@x.test'), false)
  })

  it('⛔ o retorno cru da ferramenta, o raciocínio e os anexos não aparecem em lugar nenhum', () => {
    const text = JSON.stringify(shared)

    for (const secret of ['37765628000198', 'Rua X, 100', 'customer_search', 'amber', 'cartao.png', TURN.reasoning!]) {
      assert.equal(text.includes(secret), false, `vazou: ${secret}`)
    }
  })
})
