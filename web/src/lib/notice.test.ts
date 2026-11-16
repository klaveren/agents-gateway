import { describe, expect, it } from 'vitest'
import { agentReply, gatewayNotice } from './notice'

describe('gatewayNotice', () => {
  it('separa o que aconteceu do resto do aviso', () => {
    const request =
      '[Aviso do gateway, não é mensagem da pessoa: a vigia "servidor [4] voltar" que você armou nesta conversa disparou.]\nComando conferido: test -f pronto\nO que você anotou para fazer agora: avisar'
    expect(gatewayNotice(request)).toEqual({
      what: 'A vigia "servidor [4] voltar" que você armou nesta conversa disparou.',
      detail: 'Comando conferido: test -f pronto\nO que você anotou para fazer agora: avisar',
    })
  })

  it('o aviso de uma linha só não tem detalhe', () => {
    expect(gatewayNotice('[Aviso do gateway, não é mensagem da pessoa: chegou a hora.]')).toEqual({ what: 'Chegou a hora.', detail: '' })
  })

  it('a fala da pessoa não é aviso, nem quando cita um', () => {
    expect(gatewayNotice('olá')).toBeUndefined()
    expect(gatewayNotice('veja: [Aviso do gateway, não é mensagem da pessoa: x]')).toBeUndefined()
    expect(gatewayNotice(undefined)).toBeUndefined()
  })
})

describe('agentReply — a resposta de outro agente entregue como mensagem', () => {
  it('lê quem respondeu, a conversa e o texto; a falha vira erro', () => {
    expect(agentReply('[Resposta de agent-god (conversation gw_01ABC), que você pediu sem esperar: leia e continue de onde parou.]\n\n**Pronto**\n- um')).toEqual({
      agentId: 'agent-god',
      conversationId: 'gw_01ABC',
      ok: true,
      body: '**Pronto**\n- um',
    })
    expect(agentReply('[Resposta de x (conversation c1), que chegou depois do fim do seu turno: leia e continue de onde parou.]\n\n')?.body).toBe('(sem texto)')
    expect(
      agentReply(
        '[A conversa com tradutor (conversation c2) falhou, que você pediu sem esperar: tempo esgotado. Decida: tentar de novo (talk com a conversation, para continuar a mesma), outro caminho, ou avisar a pessoa.]',
      ),
    ).toEqual({ agentId: 'tradutor', conversationId: 'c2', ok: false, body: 'tempo esgotado' })
  })

  it('fala da pessoa não vira cartão, nem quando cita o formato no meio', () => {
    expect(agentReply('oi, tudo bem?')).toBeUndefined()
    expect(agentReply('olha isso: [Resposta de x (conversation c1), que você pediu sem esperar: leia e continue de onde parou.]')).toBeUndefined()
  })
})
