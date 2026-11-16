import { describe, expect, it } from 'vitest'
import { applyAccent, PALETTES, PROJECT_COLORS, projectGradient } from './projectColors'

describe('projectColors — o destaque da tela na cor do projeto', () => {
  it('⚖️ troca as variáveis do emerald pela paleta escolhida; sem cor (ou esmeralda) volta ao tema', () => {
    const root = document.createElement('div')
    applyAccent('violet', root)
    expect(root.style.getPropertyValue('--color-emerald-500')).toBe(PALETTES.violet['500'])
    expect(root.style.getPropertyValue('--color-emerald-950')).toBe(PALETTES.violet['950'])
    expect(root.style.getPropertyValue('--color-accent-end')).toBe(PALETTES.violet['700'])
    applyAccent(undefined, root)
    expect(root.style.getPropertyValue('--color-emerald-500')).toBe('')
    expect(root.style.getPropertyValue('--color-accent-end')).toBe('')
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

  it('o degradê de UM projeto vai do tom claro ao escuro da paleta dele; sem cor, nenhum (fica o do tema)', () => {
    expect(projectGradient('sky')).toBe(`linear-gradient(to bottom right, ${PALETTES.sky['400']}, ${PALETTES.sky['700']})`)
    expect(projectGradient('sky', 0.3)).toContain(' / 0.3)')
    expect(projectGradient(undefined)).toBeUndefined()
  })
})
