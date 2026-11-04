import { describe, expect, it } from 'vitest'
import { filterList, matchesSearch, normalizeTag, tagCounts, tagNames } from './listFilter'

describe('listFilter', () => {
  it('a busca ignora acento e maiúscula, e cada palavra tem de aparecer em algum campo', () => {
    expect(matchesSearch('', ['qualquer'])).toBe(true)
    expect(matchesSearch('diagnostico rede', ['Diagnóstico', 'da REDE local'])).toBe(true)
    expect(matchesSearch('diagnostico vpn', ['Diagnóstico', 'da rede local'])).toBe(false)
    expect(matchesSearch('x', [undefined, 'x'])).toBe(true)
  })

  it('as tags: contagem por tag (uma vez por item) e o filtro por tag junto da busca; a tag também é buscada', () => {
    const items = [{ id: 'a', tags: ['infra', 'infra'] }, { id: 'b', tags: ['infra', 'logiccus'] }, { id: 'c' }]
    expect(tagCounts(items)).toEqual([
      { tag: 'infra', count: 2 },
      { tag: 'logiccus', count: 1 },
    ])
    expect(filterList(items, { query: '', tag: 'infra' }, (item) => [item.id]).map((item) => item.id)).toEqual(['a', 'b'])
    expect(filterList(items, { query: 'b', tag: 'infra' }, (item) => [item.id]).map((item) => item.id)).toEqual(['b'])
    expect(filterList(items, { query: 'logiccus' }, (item) => [item.id]).map((item) => item.id)).toEqual(['b'])
  })

  it('normalizeTag: sem acento, minúscula, espaço e sublinhado viram hífen, o resto cai, até 32', () => {
    expect(normalizeTag('  Integração_Logiccus  ')).toBe('integracao-logiccus')
    expect(normalizeTag('Infra  Rede')).toBe('infra-rede')
    expect(normalizeTag('-a!b#c-')).toBe('abc')
    expect(normalizeTag('a'.repeat(40))).toBe('a'.repeat(32))
    expect(normalizeTag('ab'.repeat(15) + '-xyz')).toBe('ab'.repeat(15) + '-x')
    expect(normalizeTag('!!! ---')).toBeUndefined()
    expect(normalizeTag('')).toBeUndefined()
  })

  it('tagNames: as tags distintas, em ordem', () => {
    expect(tagNames([{ tags: ['b', 'a'] }, { tags: ['a'] }, {}])).toEqual(['a', 'b'])
  })
})
