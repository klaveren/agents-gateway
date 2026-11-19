import { ExternalHyperlink, HeadingLevel, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType, type ParagraphChild } from 'docx'
import { marked, type Token, type Tokens } from 'marked'

/**
 * 📄 MARKDOWN → DOCX, para o `render_document`. Títulos, parágrafos, negrito, itálico, código, listas (com níveis), tabelas,
 * citações e links. Imagem não entra (fica o texto alternativo).
 */
export function markdownToDocx(markdown: string): Array<Paragraph | Table> {
  return blocks(marked.lexer(markdown, { gfm: true }), 0)
}

type TMarks = { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean }

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]

function blocks(tokens: readonly Token[], depth: number): Array<Paragraph | Table> {
  return tokens.flatMap((token) => block(token, depth))
}

function block(token: Token, depth: number): Array<Paragraph | Table> {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading
      return [new Paragraph({ heading: HEADINGS[Math.min(Math.max(heading.depth, 1), 6) - 1], children: inline(heading.tokens, {}) })]
    }
    case 'paragraph':
      return [new Paragraph({ children: inline((token as Tokens.Paragraph).tokens, {}), spacing: { after: 120 } })]
    case 'text': {
      const item = token as Tokens.Text
      return [new Paragraph({ children: item.tokens?.length ? inline(item.tokens, {}) : [new TextRun(decode(item.text))] })]
    }
    case 'list': {
      const list = token as Tokens.List
      return list.items.flatMap((item, index) => {
        const [first, ...rest] = item.tokens
        const lead = first && (first.type === 'text' || first.type === 'paragraph') ? inline((first as Tokens.Text).tokens ?? [], {}) : []
        const marker = list.ordered ? `${(Number(list.start) || 1) + index}. ` : ''
        const head = new Paragraph({
          children: [...(marker ? [new TextRun(marker)] : []), ...(lead.length ? lead : [new TextRun(decode(first && 'text' in first ? String(first.text) : ''))])],
          ...(list.ordered ? { indent: { left: 360 * (depth + 1) } } : { bullet: { level: Math.min(depth, 8) } }),
        })
        const nested = (first && (first.type === 'text' || first.type === 'paragraph') ? rest : item.tokens).flatMap((child) =>
          child.type === 'list' ? block(child, depth + 1) : block(child, depth),
        )
        return [head, ...nested]
      })
    }
    case 'code':
      return (token as Tokens.Code).text
        .split('\n')
        .map(
          (line) =>
            new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Courier New', size: 18 })], shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } }),
        )
    case 'blockquote':
      // A citação: os parágrafos dela recuados e em itálico (o resto entra como viria).
      return (token as Tokens.Blockquote).tokens.flatMap((inner) =>
        inner.type === 'paragraph'
          ? [new Paragraph({ children: inline((inner as Tokens.Paragraph).tokens, { italics: true }), indent: { left: 567 }, spacing: { after: 120 } })]
          : block(inner, depth),
      )
    case 'hr':
      return [new Paragraph({ border: { bottom: { color: 'BBBBBB', space: 1, style: 'single', size: 6 } }, children: [] })]
    case 'table': {
      const table = token as Tokens.Table
      const cell = (tokens: readonly Token[], header: boolean) =>
        new TableCell({
          children: [new Paragraph({ children: inline(tokens, header ? { bold: true } : {}) })],
          ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'EBEBEB', color: 'auto' } } : {}),
        })
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: table.header.map((item) => cell(item.tokens, true)) }),
            ...table.rows.map((row) => new TableRow({ children: row.map((item) => cell(item.tokens, false)) })),
          ],
        }),
        new Paragraph({ children: [] }),
      ]
    }
    case 'space':
      return []
    default:
      return 'raw' in token && typeof token.raw === 'string' && token.raw.trim() ? [new Paragraph({ children: [new TextRun(token.raw.trim())] })] : []
  }
}

function inline(tokens: readonly Token[], marks: TMarks): ParagraphChild[] {
  return tokens.flatMap((token) => span(token, marks))
}

function run(value: string, marks: TMarks): TextRun {
  return new TextRun({ text: value, bold: marks.bold, italics: marks.italics, strike: marks.strike, ...(marks.code ? { font: 'Courier New' } : {}) })
}

function span(token: Token, marks: TMarks): ParagraphChild[] {
  switch (token.type) {
    case 'text':
    case 'escape': {
      const item = token as Tokens.Text
      return item.tokens?.length ? inline(item.tokens, marks) : [run(decode(item.text), marks)]
    }
    case 'strong':
      return inline((token as Tokens.Strong).tokens, { ...marks, bold: true })
    case 'em':
      return inline((token as Tokens.Em).tokens, { ...marks, italics: true })
    case 'del':
      return inline((token as Tokens.Del).tokens, { ...marks, strike: true })
    case 'codespan':
      return [run(decode((token as Tokens.Codespan).text), { ...marks, code: true })]
    case 'br':
      return [new TextRun({ text: '', break: 1 })]
    case 'link': {
      const link = token as Tokens.Link
      if (!/^(https?:|mailto:)/i.test(link.href)) return inline(link.tokens, marks)
      return [new ExternalHyperlink({ link: link.href, children: [new TextRun({ text: decode(link.text), style: 'Hyperlink' })] })]
    }
    case 'image':
      return [run((token as Tokens.Image).text, marks)]
    default:
      return 'raw' in token && typeof token.raw === 'string' ? [run(token.raw, marks)] : []
  }
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
