/**
 * Markdown mínimo para a resposta do agente: títulos, listas (com marcador e numeradas), tabelas, citações, código e
 * links.
 *
 * ⛔ ESCAPA PRIMEIRO, marca depois: nenhum texto do modelo ou nome de tool vira markup. É o que
 * permite o `v-html` sem sanitizador — a única marcação que sai é a que este arquivo escreve.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** O que vale dentro de uma linha: código, negrito, itálico e link. */
function inline(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const BULLET = /^\s*[-*]\s+(.+)$/
const NUMBERED = /^\s*\d+[.)]\s+(.+)$/
const QUOTE = /^&gt;\s?(.*)$/
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => inline(cell.trim()))

export function renderMarkdown(text: string): string {
  const fences: string[] = []
  const escaped = escapeHtml(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    fences.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`)
    return `[[fence:${fences.length - 1}]]`
  })

  // Cada item é um bloco (título, lista, tabela…) ou uma linha de texto; só linhas de texto vizinhas levam `<br>`.
  const parts: Array<{ block: boolean; html: string }> = []
  const lines = escaped.split('\n')
  const run = (index: number, pattern: RegExp) => {
    const taken: string[] = []
    while (index + taken.length < lines.length && pattern.test(lines[index + taken.length])) taken.push(lines[index + taken.length])
    return taken
  }
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? '')) {
      const rows = run(index + 2, TABLE_ROW)
      const head = cells(line)
        .map((cell) => `<th>${cell}</th>`)
        .join('')
      const body = rows
        .map(
          (row) =>
            `<tr>${cells(row)
              .map((cell) => `<td>${cell}</td>`)
              .join('')}</tr>`,
        )
        .join('')
      parts.push({ block: true, html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` })
      index += 2 + rows.length
    } else if (heading) {
      const level = heading[1].length + 1
      parts.push({ block: true, html: `<h${level}>${inline(heading[2])}</h${level}>` })
      index += 1
    } else if (RULE.test(line)) {
      parts.push({ block: true, html: '<hr>' })
      index += 1
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line)
      const items = run(index, ordered ? NUMBERED : BULLET)
      const tag = ordered ? 'ol' : 'ul'
      parts.push({ block: true, html: `<${tag}>${items.map((item) => `<li>${inline((ordered ? NUMBERED : BULLET).exec(item)![1])}</li>`).join('')}</${tag}>` })
      index += items.length
    } else if (QUOTE.test(line)) {
      const quoted = run(index, QUOTE)
      parts.push({ block: true, html: `<blockquote>${quoted.map((item) => inline(QUOTE.exec(item)![1])).join('<br>')}</blockquote>` })
      index += quoted.length
    } else {
      parts.push({ block: false, html: inline(line) })
      index += 1
    }
  }

  let html = ''
  let previous: (typeof parts)[number] | undefined
  parts.forEach((part, index) => {
    // Linha vazia colada num bloco não vira espaço extra: o bloco já tem a margem dele.
    if (!part.block && !part.html && (parts[index - 1]?.block || parts[index + 1]?.block)) return
    if (previous && !part.block && !previous.block) html += '<br>'
    html += part.html
    previous = part
  })
  return html.replace(/\[\[fence:(\d+)\]\]/g, (_match, index: string) => fences[Number(index)] ?? '')
}
