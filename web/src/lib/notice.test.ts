import { describe, expect, it } from 'vitest'
import { gatewayNotice } from './notice'

describe('gatewayNotice', () => {
  it('separa o que aconteceu do resto do aviso', () => {
    const request = '[Aviso do gateway, não é mensagem da pessoa: a vigia "servidor [4] voltar" que você armou nesta conversa disparou.]\nComando conferido: test -f pronto\nO que você anotou para fazer agora: avisar'
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
