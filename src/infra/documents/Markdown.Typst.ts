import { marked, type Token, type Tokens } from 'marked'

/**
 * 📄 MARKDOWN → TYPST, para o PDF do `render_document`. ⛔ Todo texto do agente vira STRING Typst (`#"…"`, com `\` e `"`
 * escapados): nada do que ele escreve é lido como código — nem `#import`, nem `#read`, nem `@pacote`. Os links só levam a
 * URL (como string); imagem não entra (o compilador não alcança arquivo nenhum).
 */
export function markdownToTypst(markdown: string): string {
  return blocks(marked.lexer(markdown, { gfm: true })).join('\n\n')
}

/** Uma string Typst: o texto exato, nunca código. */
export function typstString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`
}

const text = (value: string) => (value ? `#${typstString(value)}` : '')

function blocks(tokens: readonly Token[]): string[] {
  return tokens.map(block).filter((item) => item.length > 0)
}

function block(token: Token): string {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading
      return `#heading(level: ${Math.min(Math.max(heading.depth, 1), 6)})[${inline(heading.tokens)}]`
    }
    case 'paragraph':
      return `#par[${inline((token as Tokens.Paragraph).tokens)}]`
    case 'text': {
      const item = token as Tokens.Text
      return item.tokens?.length ? inline(item.tokens) : text(item.text)
    }
    case 'list': {
      const list = token as Tokens.List
      const items = list.items.map((item) => `[${blocks(item.tokens).join(' ')}]`).join(', ')
      return list.ordered ? `#enum(start: ${Number(list.start) || 1}, ${items})` : `#list(${items})`
    }
    case 'code': {
      const code = token as Tokens.Code
      const lang = (code.lang ?? '').trim().split(/\s/)[0]
      return `#raw(block: true, ${/^[a-z0-9+#-]{1,20}$/i.test(lang) ? `lang: ${typstString(lang)}, ` : ''}${typstString(code.text)})`
    }
    case 'blockquote':
      return `#quote(block: true)[${blocks((token as Tokens.Blockquote).tokens).join(' ')}]`
    case 'hr':
      return '#line(length: 100%, stroke: 0.5pt + luma(180))'
    case 'table': {
      const table = token as Tokens.Table
      const header = table.header.map((cell) => `table.cell(fill: luma(235))[#strong[${inline(cell.tokens)}]]`)
      const rows = table.rows.flatMap((row) => row.map((cell) => `[${inline(cell.tokens)}]`))
      return `#table(columns: ${Math.max(table.header.length, 1)}, stroke: 0.5pt + luma(200), inset: 6pt, ${[...header, ...rows].join(', ')})`
    }
    case 'space':
      return ''
    case 'html':
      return text((token as Tokens.HTML).text.trim())
    default:
      return 'raw' in token && typeof token.raw === 'string' ? text(token.raw.trim()) : ''
  }
}

function inline(tokens: readonly Token[] | undefined): string {
  return (tokens ?? []).map(span).join('')
}

function span(token: Token): string {
  switch (token.type) {
    case 'text':
    case 'escape': {
      const item = token as Tokens.Text
      return item.tokens?.length ? inline(item.tokens) : text(decode(item.text))
    }
    case 'strong':
      return `#strong[${inline((token as Tokens.Strong).tokens)}]`
    case 'em':
      return `#emph[${inline((token as Tokens.Em).tokens)}]`
    case 'del':
      return `#strike[${inline((token as Tokens.Del).tokens)}]`
    case 'codespan':
      return `#raw(${typstString(decode((token as Tokens.Codespan).text))})`
    case 'br':
      return '#linebreak()'
    case 'link': {
      const link = token as Tokens.Link
      return /^(https?:|mailto:)/i.test(link.href) ? `#link(${typstString(link.href)})[${inline(link.tokens)}]` : inline(link.tokens)
    }
    case 'image':
      // ⛔ Sem imagem: o compilador não alcança arquivo nem rede. Fica o texto alternativo.
      return text((token as Tokens.Image).text)
    default:
      return 'raw' in token && typeof token.raw === 'string' ? text(token.raw) : ''
  }
}

/** O `marked` devolve o texto com as entidades HTML do Markdown (`&amp;`): volta ao caractere. */
function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
