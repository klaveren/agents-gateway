import { describe, expect, it } from 'vitest'
import { isControlKey, keyCodeOf } from './keyCodes'

describe('keyCodeOf', () => {
  it('⛔ o ponto e a vírgula não viram Delete nem PrintScreen', () => {
    expect(keyCodeOf({ key: '.', code: 'Period' })).toBe(190)
    expect(keyCodeOf({ key: ',', code: 'Comma' })).toBe(188)
    expect(keyCodeOf({ key: '.', code: 'NumpadDecimal' })).toBe(110)
  })
  it('letras, números e o @ pela posição da tecla', () => {
    expect(keyCodeOf({ key: 'a', code: 'KeyA' })).toBe(65)
    expect(keyCodeOf({ key: '3', code: 'Digit3' })).toBe(51)
    expect(keyCodeOf({ key: '@', code: 'Digit2' })).toBe(50)
    expect(keyCodeOf({ key: ' ', code: 'Space' })).toBe(32)
  })
  it('teclas de controle pelo nome; sem code, só letra e número', () => {
    expect(keyCodeOf({ key: 'Backspace', code: 'Backspace' })).toBe(8)
    expect(isControlKey('Enter')).toBe(true)
    expect(keyCodeOf({ key: 'x', code: '' })).toBe(88)
    expect(keyCodeOf({ key: '.', code: '' })).toBeUndefined()
  })
})
