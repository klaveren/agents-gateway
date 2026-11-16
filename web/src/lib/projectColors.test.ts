import { describe, expect, it } from 'vitest'
import { applyAccent, PALETTES, PROJECT_COLORS } from './projectColors'

describe('projectColors — o destaque da tela na cor do projeto', () => {
  it('⚖️ troca as variáveis do emerald pela paleta escolhida; sem cor (ou esmeralda) volta ao tema', () => {
    const root = document.createElement('div')
    applyAccent('violet', root)
    expect(root.style.getPropertyValue('--color-emerald-500')).toBe(PALETTES.violet['500'])
    expect(root.style.getPropertyValue('--color-emerald-950')).toBe(PALETTES.violet['950'])
    applyAccent(undefined, root)
    expect(root.style.getPropertyValue('--color-emerald-500')).toBe('')
    applyAccent('emerald', root)
    expect(root.style.getPropertyValue('--color-emerald-500')).toBe('')
    // Cor desconhecida não pinta nada.
    applyAccent('red', root)
    expect(root.style.getPropertyValue('--color-emerald-500')).toBe('')
  })

  it('⛔ vermelho e amarelo (erro e alerta) não estão entre as cores', () => {
    expect(PROJECT_COLORS).not.toContain('red')
    expect(PROJECT_COLORS).not.toContain('rose')
    expect(PROJECT_COLORS).not.toContain('amber')
    expect(PROJECT_COLORS).not.toContain('yellow')
  })
})
