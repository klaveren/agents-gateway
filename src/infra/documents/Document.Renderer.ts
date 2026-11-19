import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'
import { AlignmentType, Document, Footer, Header, Packer, PageNumber, Paragraph, TextRun } from 'docx'
import ExcelJS from 'exceljs'
import PptxGenJS from 'pptxgenjs'
import { IDocumentInput, IDocumentSlide, TCell, TDocumentFormat } from '@domain/models/Document.Model'
import { markdownToDocx } from './Markdown.Docx'
import { markdownToTypst, typstString } from './Markdown.Typst'

/**
 * 📄 O MODELO DO DOCUMENTO: o que vai no cabeçalho, no rodapé e na cor de destaque. O padrão já serve; o do projeto
 * (Projeto → Documentos) vem depois e só troca estes campos.
 */
export interface IDocumentTemplate {
  /** O nome que aparece no cabeçalho (a empresa, o projeto). */
  organization?: string
  /** O texto do rodapé (CNPJ, endereço, site). */
  footer?: string
  /** A cor de destaque, `#RRGGBB`. */
  color?: string
}

export const DEFAULT_TEMPLATE: IDocumentTemplate = { color: '#10B981' }

export interface IRenderedDocument {
  data: Buffer
  extension: TDocumentFormat
}

/** Gera o arquivo. ⚠️ O pedido já foi conferido (`documentIssues`): aqui só monta. */
export async function renderDocument(input: IDocumentInput, template: IDocumentTemplate = DEFAULT_TEMPLATE): Promise<IRenderedDocument> {
  const color = /^#[0-9a-f]{6}$/i.test(template.color ?? '') ? template.color! : DEFAULT_TEMPLATE.color!
  switch (input.format) {
    case 'pdf':
      return { data: renderPdf(input, { ...template, color }), extension: 'pdf' }
    case 'docx':
      return { data: await renderDocx(input, { ...template, color }), extension: 'docx' }
    case 'xlsx':
      return { data: await renderXlsx(input, color), extension: 'xlsx' }
    case 'pptx':
      return { data: await renderPptx(input, { ...template, color }), extension: 'pptx' }
  }
}

/**
 * ⛔ O PDF compila numa pasta VAZIA e descartada: sem ela, o Typst lê os arquivos de onde o gateway roda (o `.env`
 * inclusive). E o texto do agente só entra como string (ver `Markdown.Typst`), então ele não chega a `#read` nem a `#import`.
 */
function renderPdf(input: IDocumentInput, template: IDocumentTemplate): Buffer {
  const workspace = mkdtempSync(join(tmpdir(), 'gw-doc-'))
  try {
    const compiler = NodeCompiler.create({ workspace })
    const head = [template.organization, input.title].filter(Boolean).join(' · ')
    const source = [
      `#set document(title: ${typstString(input.title ?? input.name)})`,
      `#set page(paper: "a4", margin: (x: 2.2cm, y: 2.5cm),`,
      `  header: ${head ? `align(right, text(size: 8pt, fill: luma(110))[#${typstString(head)}])` : 'none'},`,
      `  footer: context grid(columns: (1fr, auto), text(size: 8pt, fill: luma(110))[#${typstString(template.footer ?? '')}], text(size: 8pt, fill: luma(110))[#counter(page).display("1 / 1", both: true)]))`,
      '#set text(size: 10.5pt, lang: "pt")',
      '#set par(justify: true, leading: 0.65em)',
      `#show heading: set text(fill: rgb(${typstString(template.color!)}))`,
      '#show link: set text(fill: rgb("#2563EB"))',
      ...(input.title
        ? [
            `#block(below: 1.2em)[#text(size: 20pt, weight: "bold")[#${typstString(input.title)}]${input.subtitle ? `#linebreak()#text(size: 12pt, fill: luma(90))[#${typstString(input.subtitle)}]` : ''}]`,
          ]
        : []),
      markdownToTypst(input.markdown ?? ''),
    ].join('\n')
    return Buffer.from(compiler.pdf({ mainFileContent: source }))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function renderDocx(input: IDocumentInput, template: IDocumentTemplate): Promise<Buffer> {
  const head = [template.organization, input.title].filter(Boolean).join(' · ')
  const hex = template.color!.slice(1)
  const document = new Document({
    title: input.title ?? input.name,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } }, heading1: { run: { color: hex } }, heading2: { run: { color: hex } }, heading3: { run: { color: hex } } },
    },
    sections: [
      {
        headers: {
          default: new Header({ children: head ? [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: head, size: 16, color: '6E6E6E' })] })] : [] }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: template.footer ? `${template.footer}    ` : '', size: 16, color: '6E6E6E' }),
                  new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 16, color: '6E6E6E' }),
                ],
              }),
            ],
          }),
        },
        children: [
          ...(input.title ? [new Paragraph({ children: [new TextRun({ text: input.title, bold: true, size: 40 })], spacing: { after: 80 } })] : []),
          ...(input.subtitle ? [new Paragraph({ children: [new TextRun({ text: input.subtitle, size: 24, color: '5A5A5A' })], spacing: { after: 240 } })] : []),
          ...markdownToDocx(input.markdown ?? ''),
        ],
      },
    ],
  })
  return Buffer.from(await Packer.toBuffer(document))
}

async function renderXlsx(input: IDocumentInput, color: string): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  book.creator = 'Agents Gateway'
  const used = new Set<string>()
  for (const [index, sheet] of (input.sheets ?? []).entries()) {
    // O Excel recusa nome com `\ / ? * [ ] :`, maior que 31 ou repetido.
    let name =
      (sheet.name || `Aba ${index + 1}`)
        .replace(/[\\/?*[\]:]/g, ' ')
        .slice(0, 31)
        .trim() || `Aba ${index + 1}`
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${index + 1}`
    used.add(name.toLowerCase())
    const header = sheet.header !== false
    const page = book.addWorksheet(name, header ? { views: [{ state: 'frozen', ySplit: 1 }] } : {})
    for (const row of sheet.rows) page.addRow(row.map(cellValue))
    if (header && sheet.rows.length) {
      const first = page.getRow(1)
      first.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      first.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color.slice(1).toUpperCase()}` } }
    }
    // Largura pelo maior conteúdo da coluna (com teto), para não abrir tudo espremido.
    page.columns.forEach((column, position) => {
      const widest = sheet.rows.reduce((max, row) => Math.max(max, String(row[position] ?? '').length), 8)
      column.width = Math.min(widest + 2, 60)
    })
  }
  return Buffer.from(await book.xlsx.writeBuffer())
}

/** Número fica número; `=` no começo vira fórmula; o resto, texto. */
function cellValue(value: TCell): ExcelJS.CellValue {
  if (typeof value === 'string' && value.startsWith('=') && value.length > 1) return { formula: value.slice(1) }
  return value ?? null
}

async function renderPptx(input: IDocumentInput, template: IDocumentTemplate): Promise<Buffer> {
  const deck = new PptxGenJS()
  deck.layout = 'LAYOUT_WIDE'
  deck.title = input.title ?? input.name
  const accent = template.color!.slice(1)
  const footer = [template.organization, template.footer].filter(Boolean).join(' · ')
  if (input.title) {
    const cover = deck.addSlide()
    cover.background = { color: accent }
    cover.addText(input.title, { x: 0.8, y: 2.6, w: 11.7, h: 1.2, fontSize: 40, bold: true, color: 'FFFFFF' })
    if (input.subtitle) cover.addText(input.subtitle, { x: 0.8, y: 3.8, w: 11.7, h: 0.8, fontSize: 20, color: 'FFFFFF' })
    if (footer) cover.addText(footer, { x: 0.8, y: 6.8, w: 11.7, h: 0.4, fontSize: 11, color: 'FFFFFF' })
  }
  for (const item of input.slides ?? []) addSlide(deck, item, accent, footer)
  return Buffer.from((await deck.write({ outputType: 'nodebuffer' })) as ArrayBuffer)
}

function addSlide(deck: PptxGenJS, item: IDocumentSlide, accent: string, footer: string): void {
  const slide = deck.addSlide()
  let y = 0.5
  if (item.title) {
    slide.addText(item.title, { x: 0.6, y, w: 12.1, h: 0.9, fontSize: 28, bold: true, color: accent })
    y += 1.1
  }
  if (item.text) {
    slide.addText(item.text, { x: 0.6, y, w: 12.1, h: 1.2, fontSize: 18, color: '333333', valign: 'top' })
    y += 1.3
  }
  if (item.bullets?.length) {
    const lines = item.bullets.slice(0, 30)
    slide.addText(
      lines.map((line) => ({ text: line, options: { bullet: true, breakLine: true } })),
      { x: 0.6, y, w: 12.1, h: Math.min(0.45 * lines.length + 0.3, 6.8 - y), fontSize: 18, color: '333333', valign: 'top' },
    )
    y += Math.min(0.45 * lines.length + 0.4, 6.8 - y)
  }
  if (item.table?.length) {
    const rows = item.table.map((row, index) =>
      row.map((value) => ({ text: String(value ?? ''), options: index === 0 ? { bold: true, color: 'FFFFFF', fill: { color: accent } } : {} })),
    )
    slide.addTable(rows, { x: 0.6, y, w: 12.1, fontSize: 12, border: { type: 'solid', pt: 0.5, color: 'BBBBBB' } })
  }
  if (footer) slide.addText(footer, { x: 0.6, y: 7.0, w: 12.1, h: 0.3, fontSize: 9, color: '888888' })
  if (item.notes) slide.addNotes(item.notes)
}
