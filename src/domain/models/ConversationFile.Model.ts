import { extname } from 'node:path'

/**
 * ⚖️ O ARQUIVO ENTREGUE: o que o agente criou na conversa e passa à pessoa (`deliver_file`), que o baixa na tela. A pasta
 * da conversa é temporária e a pessoa não a alcança; o gateway guarda uma CÓPIA, presa à conversa, que dura enquanto ela
 * existir (apagar a conversa apaga os arquivos).
 *
 * ⛔ Baixa quem vê a conversa (a mesma regra dela). O arquivo vai sempre como anexo, nunca aberto na página do gateway: um
 * HTML entregue não roda com a sessão de quem o baixa.
 */
export const DELIVER_FILE_TOOL = 'deliver_file'

export const DELIVERED_FILE_MAX_BYTES = 20 * 1024 * 1024
export const DELIVERED_FILES_PER_CONVERSATION = 50

export interface IConversationFile {
  id: string
  conversationId: string
  name: string
  mime: string
  size: number
  /** O turno em que foi entregue. */
  turn?: number
  agentId?: string
  createdAt: Date
}

const MIME: Record<string, string> = {
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export const mimeOf = (name: string): string => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'

/** O nome que a pessoa vê e com que o arquivo baixa: sem pasta, sem caractere de controle, até 120 caracteres. */
export function fileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim()
  return (clean || 'arquivo').slice(-120)
}

/** O resumo que volta ao agente e que a tela lê para mostrar o botão (o JSON no fim, como a delegação). */
export function deliveredNote(file: IConversationFile): string {
  return `Delivered ${file.name} (${file.size} bytes): the person now has a download button for it in the chat, and the gateway keeps this copy while the conversation exists (even after your working folder is gone). Mention it in your answer; do not paste the content or the server path. ${JSON.stringify({ deliveredFile: { id: file.id, name: file.name, size: file.size } })}`
}
