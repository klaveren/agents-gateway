import { describe, expect, it } from 'vitest'
import { kindLabel, languageOf, TEXT_VIEW_MAX_BYTES, viewable, viewerOf } from './fileViewer'

describe('fileViewer — o visualizador pelo tipo', () => {
  it('imagem, PDF, HTML e código pela extensão', () => {
    expect(['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg'].map((name) => viewerOf({ name, mime: '' }))).toEqual(Array(6).fill('image'))
    expect(viewerOf({ name: 'relatorio.pdf', mime: 'application/pdf' })).toBe('pdf')
    expect(viewerOf({ name: 'pagina.html', mime: 'text/html' })).toBe('html')
    expect(['a.csv', 'a.json', 'a.md', 'a.xml', 'a.yaml', 'a.ts', 'a.txt', 'Dockerfile'].map((name) => viewerOf({ name, mime: 'application/octet-stream' }))).toEqual(
      Array(8).fill('code'),
    )
  })

  it('pelo tipo, quando a extensão não diz', () => {
    expect(viewerOf({ name: 'sem-extensao', mime: 'image/png' })).toBe('image')
    expect(viewerOf({ name: 'sem-extensao', mime: 'text/plain' })).toBe('code')
    expect(viewerOf({ name: 'sem-extensao', mime: 'application/pdf' })).toBe('pdf')
  })

  it('o resto só baixa (zip, xlsx, docx…)', () => {
    for (const name of ['a.zip', 'a.xlsx', 'a.docx', 'a.pptx', 'a.bin']) {
      expect(viewerOf({ name, mime: 'application/octet-stream' })).toBe('none')
      expect(viewable({ name, mime: 'application/octet-stream', size: 1 })).toBe(false)
    }
  })

  it('texto grande demais não abre; imagem e PDF não têm esse teto', () => {
    expect(viewable({ name: 'a.json', mime: '', size: TEXT_VIEW_MAX_BYTES + 1 })).toBe(false)
    expect(viewable({ name: 'a.json', mime: '', size: TEXT_VIEW_MAX_BYTES })).toBe(true)
    expect(viewable({ name: 'a.pdf', mime: '', size: TEXT_VIEW_MAX_BYTES * 5 })).toBe(true)
  })

  it('a linguagem do Monaco e o rótulo do tipo', () => {
    expect([languageOf('a.ts'), languageOf('a.yml'), languageOf('a.csv'), languageOf('x')]).toEqual(['typescript', 'yaml', 'plaintext', 'plaintext'])
    expect(kindLabel({ name: 'grafico.png', mime: 'image/png' })).toBe('PNG')
  })
})
