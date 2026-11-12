import { describe, expect, it } from 'vitest'
import { linkHost, linkKind } from './conversationPanel'

describe('conversationPanel — os links que o agente escreve', () => {
  it('endereço abre fora, `gw_…` é conversa, o resto é caminho', () => {
    expect([linkKind('https://a.test/x'), linkKind('gw_abc-1'), linkKind('src/a.ts'), linkKind(undefined)]).toEqual(['external', 'conversation', 'path', undefined])
  })

  it('⛔ o texto é do agente: o host de destino aparece quando o texto não é o próprio endereço', () => {
    expect(linkHost({ label: 'Reautenticar', href: 'https://evil.test/login?x=1' })).toBe('evil.test')
    expect(linkHost({ label: 'https://banco.test', href: 'https://evil.test/' })).toBe('evil.test')
    expect(linkHost({ label: 'https://a.test/x', href: 'https://a.test/x' })).toBe('')
    expect(linkHost({ label: 'a.test', href: 'https://a.test/x' })).toBe('')
    expect(linkHost({ label: 'arquivo', href: 'src/a.ts' })).toBe('')
    expect(linkHost({ label: 'conversa', href: 'gw_abc' })).toBe('')
    expect(linkHost({ label: 'sem destino' })).toBe('')
  })
})
