/**
 * 📄 O DOCUMENTO QUE O AGENTE GERA (`render_document`): PDF e DOCX a partir de Markdown, XLSX a partir de abas e linhas,
 * PPTX a partir de slides. O gateway monta o arquivo e o entrega na conversa, como o `deliver_file`.
 *
 * ⛔ SÓ MARKDOWN, NUNCA TYPST CRU: o compilador do PDF lê arquivos e baixa pacotes da internet a partir do código. O texto do
 * agente vira Typst escapado (cada trecho como string), então ele não tem como mandar `#import`, `#read` nem nada que rode.
 */
export const RENDER_DOCUMENT_TOOL = 'render_document'

export const DOCUMENT_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx'] as const
export type TDocumentFormat = (typeof DOCUMENT_FORMATS)[number]

export const DOCUMENT_LIMITS = { markdown: 500_000, sheets: 20, cells: 200_000, slides: 200, bullets: 30, name: 120 } as const

export type TCell = string | number | boolean | null

export interface IDocumentSheet {
  name: string
  rows: TCell[][]
  /** A primeira linha é cabeçalho (negrito, congelada). Padrão: sim. */
  header?: boolean
}

export interface IDocumentSlide {
  title?: string
  /** Texto corrido (Markdown simples: negrito e itálico). */
  text?: string
  bullets?: string[]
  table?: TCell[][]
  notes?: string
}

export interface IDocumentInput {
  format: TDocumentFormat
  /** O nome do arquivo, sem a extensão (ela vem do formato). */
  name: string
  title?: string
  subtitle?: string
  /** PDF e DOCX. */
  markdown?: string
  /** XLSX. */
  sheets?: IDocumentSheet[]
  /** PPTX. */
  slides?: IDocumentSlide[]
}

/** O que há de errado no pedido, em frases curtas (o agente lê e corrige). */
export function documentIssues(input: IDocumentInput): string[] {
  const issues: string[] = []
  if (!DOCUMENT_FORMATS.includes(input.format)) issues.push(`format must be one of: ${DOCUMENT_FORMATS.join(', ')}`)
  if (!input.name?.trim()) issues.push('name is required')
  if (input.format === 'pdf' || input.format === 'docx') {
    if (!input.markdown?.trim()) issues.push(`${input.format} needs markdown`)
    else if (input.markdown.length > DOCUMENT_LIMITS.markdown) issues.push(`markdown is larger than ${DOCUMENT_LIMITS.markdown} characters`)
  }
  if (input.format === 'xlsx') {
    if (!input.sheets?.length) issues.push('xlsx needs sheets: [{ name, rows }]')
    else {
      if (input.sheets.length > DOCUMENT_LIMITS.sheets) issues.push(`at most ${DOCUMENT_LIMITS.sheets} sheets`)
      const cells = input.sheets.reduce((total, sheet) => total + (sheet.rows ?? []).reduce((sum, row) => sum + (Array.isArray(row) ? row.length : 0), 0), 0)
      if (cells > DOCUMENT_LIMITS.cells) issues.push(`at most ${DOCUMENT_LIMITS.cells} cells`)
      if (input.sheets.some((sheet) => !Array.isArray(sheet.rows) || sheet.rows.some((row) => !Array.isArray(row)))) issues.push('every sheet needs rows: an array of arrays')
    }
  }
  if (input.format === 'pptx') {
    if (!input.slides?.length) issues.push('pptx needs slides: [{ title, bullets, text, table, notes }]')
    else if (input.slides.length > DOCUMENT_LIMITS.slides) issues.push(`at most ${DOCUMENT_LIMITS.slides} slides`)
  }
  return issues
}
