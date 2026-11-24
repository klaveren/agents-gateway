/**
 * 📖 LEITURA LONGA EM PARTES, SEM DEPENDER DO AGENTE PEDIR A PRÓXIMA.
 *
 * Uma spec grande lida pelo `cat`, pelo `read_file` ou pelo `fetch_url` chegava cortada, e o agente seguia com metade
 * achando que tinha o todo. Agora o gateway junta as partes ("Parte 1/3", "Parte 2/3"…) numa resposta só, até um TETO
 * TOTAL: 25% da janela de contexto do modelo. Passou do teto, para numa quebra de linha e diz exatamente como continuar.
 *
 * ⚖️ Mandar as partes em chamadas separadas ocuparia o mesmo contexto: o que protege a conversa é o teto, não o corte.
 */

/** Tamanho de cada parte, em caracteres. */
export const READ_PAGE_CHARS = 20_000
/** A fatia da janela de contexto que uma leitura pode ocupar. */
export const READ_WINDOW_SHARE = 0.25
/** Caracteres por token, por baixo (texto em português e código ficam entre 3 e 4). */
const CHARS_PER_TOKEN = 3
/** Janela desconhecida: o teto de uma janela de 128 mil tokens. */
const DEFAULT_WINDOW_TOKENS = 128_000

/** O teto total de uma leitura, em caracteres, para a janela do modelo (em tokens). */
export function readBudgetChars(windowTokens?: number): number {
  const window = windowTokens && windowTokens > 0 ? windowTokens : DEFAULT_WINDOW_TOKENS
  return Math.max(READ_PAGE_CHARS, Math.floor(window * READ_WINDOW_SHARE * CHARS_PER_TOKEN))
}

export interface IPagedText {
  text: string
  /** A leitura parou no teto: a primeira linha (1-based, do texto recebido) que ficou de fora. */
  stoppedAtLine?: number
}

/**
 * O texto inteiro se cabe numa parte; senão em partes de `READ_PAGE_CHARS`, quebradas em fim de linha, até o teto.
 * `continueHint(linha)` diz como ler o resto quando o teto corta.
 */
export function pagedText(text: string, budgetChars: number, continueHint: (line: number) => string): IPagedText {
  if (text.length <= READ_PAGE_CHARS) return { text }
  const pages = splitPages(text, READ_PAGE_CHARS)
  const kept: string[] = []
  let used = 0
  for (const page of pages) {
    if (kept.length && used + page.length > budgetChars) break
    kept.push(page)
    used += page.length
  }
  const total = pages.length
  const body = kept.map((page, index) => `── Parte ${index + 1}/${total} ──\n${page}${page.endsWith('\n') ? '' : '\n'}`).join('')
  if (kept.length === total) return { text: `${body}── Fim (${total} partes) ──` }
  const line = countLines(text.slice(0, used)) + 1
  const left = total - kept.length
  return {
    text: `${body}── Parou no teto da leitura (${budgetChars} caracteres, 25% da janela do modelo): faltam ${left} de ${total} partes. ${continueHint(line)} ──`,
    stoppedAtLine: line,
  }
}

/** Partes de até `size` caracteres, cortadas depois de uma quebra de linha quando há uma na segunda metade. */
function splitPages(text: string, size: number): string[] {
  const pages: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + size, text.length)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1)
      if (newline >= start + size / 2) end = newline + 1
    }
    pages.push(text.slice(start, end))
    start = end
  }
  return pages
}

function countLines(text: string): number {
  let count = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count++
  return count
}

/**
 * O comando do terminal que só LÊ um arquivo: `cat arq`, `head`/`tail -n N arq`, `sed -n 'a,bp' arq`. Sem pipe,
 * redirecionamento, substituição nem encadeamento. Devolve o caminho (o primeiro, se o `cat` tiver vários).
 */
export function plainFileRead(command: string): string | undefined {
  const line = command.trim()
  if (!line || /[|;&<>`$()\n\\]/.test(line)) return undefined
  const match =
    /^cat\s+(?:-[nA-Za-z]+\s+)*(['"]?)([^\s'"]+)\1(?:\s+(['"]?)[^\s'"]+\3)*$/.exec(line) ??
    /^(?:head|tail)\s+(?:-n\s*\d+\s+|-\d+\s+)?(['"]?)([^\s'"]+)\1$/.exec(line) ??
    /^sed\s+-n\s+(['"]?)\d+(?:,\d+)?p\1\s+(?:(['"]?)([^\s'"]+)\2)$/.exec(line)
  if (!match) return undefined
  return line.startsWith('sed') ? match[3] : match[2]
}
