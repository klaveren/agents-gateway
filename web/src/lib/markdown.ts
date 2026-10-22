/**
 * Markdown mínimo para a resposta do agente.
 *
 * ⛔ ESCAPA PRIMEIRO, marca depois: nenhum texto do modelo ou nome de tool vira markup. É o que
 * permite o `v-html` sem sanitizador — a única marcação que sai é a que este arquivo escreve.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function renderMarkdown(text: string): string {
  const fences: string[] = []
  let html = escapeHtml(text)

  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    fences.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`)
    return `[[fence:${fences.length - 1}]]`
  })

  html = html
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>')

  html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
  html = html.replace(/\n/g, '<br>').replace(/<\/li><br>/g, '</li>')
  html = html.replace(/\[\[fence:(\d+)\]\]/g, (_match, index: string) => fences[Number(index)] ?? '')

  return html
}
