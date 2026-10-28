import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('tabela com cabeçalho, e o texto das células passa pelo inline', () => {
    const html = renderMarkdown('Veja:\n\n| Item | Valor |\n|---|:--:|\n| **Hora** | `13:07` |\n| Oi | ok |\n\nFim')
    expect(html).toContain('<table><thead><tr><th>Item</th><th>Valor</th></tr></thead>')
    expect(html).toContain('<td><strong>Hora</strong></td><td><code>13:07</code></td>')
    expect(html).toMatch(/^Veja:<div class="table-wrap">/)
    expect(html).toMatch(/<\/div>Fim$/)
  })

  it('listas numeradas e com marcador, títulos e citação', () => {
    expect(renderMarkdown('1. um\n2. dois')).toBe('<ol><li>um</li><li>dois</li></ol>')
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('## Título\ntexto')).toBe('<h3>Título</h3>texto')
    expect(renderMarkdown('> citação')).toBe('<blockquote>citação</blockquote>')
  })

  it('linhas de texto seguidas viram <br>; código cercado fica intacto', () => {
    expect(renderMarkdown('a\nb\n\nc')).toBe('a<br>b<br><br>c')
    expect(renderMarkdown('```ts\nconst a = 1\n```')).toBe('<pre><code data-lang="ts">const a = 1</code></pre>')
  })

  it('escapa antes de marcar: HTML do modelo não vira markup, nem dentro da tabela', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n| a |\n|---|\n| <b>x</b> |')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})
