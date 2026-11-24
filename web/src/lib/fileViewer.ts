/**
 * 👁️ O VISUALIZADOR dos arquivos que o agente entregou na conversa (`deliver_file`, `render_document`, `generate_image`).
 *
 * ⛔ A regra: VER sem nunca EXECUTAR o conteúdo do arquivo. Imagem vai num `<img>` (SVG como imagem não roda script);
 * PDF vai pelo pdf.js em canvas, sem formulário nem anotação; texto e código vão no Monaco somente leitura; HTML abre como
 * código, e a prévia (só no clique) é um `iframe` com `sandbox=""` via `srcdoc`. O resto só baixa. Os bytes vêm por
 * `fetch` com a credencial e viram blob: a URL do arquivo nunca abre no documento do gateway.
 */
import { apiBlob, url } from './api'

export type TFileViewer = 'image' | 'pdf' | 'code' | 'html' | 'none'

/** O arquivo como a lista do gateway o devolve (`GET /conversations/:id/files`). */
export interface IDeliveredFile {
  id: string
  conversationId: string
  name: string
  mime: string
  size: number
  turn?: number
  agentId?: string
  createdAt: string
}

/** Texto acima disso não abre no Monaco (o navegador sofre): baixa. */
export const TEXT_VIEW_MAX_BYTES = 2 * 1024 * 1024

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const HTML = new Set(['html', 'htm'])

/** A linguagem do Monaco por extensão; o que estiver aqui abre como código/texto. */
const LANGUAGE: Record<string, string> = {
  txt: 'plaintext',
  log: 'plaintext',
  csv: 'plaintext',
  tsv: 'plaintext',
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  jsonl: 'json',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'plaintext',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'html',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  graphql: 'graphql',
  dockerfile: 'dockerfile',
}

const extensionOf = (name: string): string => {
  const base = name.toLowerCase().split('/').pop() ?? ''
  if (base === 'dockerfile') return 'dockerfile'
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1)
}

/** Qual visualizador abre o arquivo: pela extensão, e pelo tipo quando a extensão não diz. */
export function viewerOf(file: Pick<IDeliveredFile, 'name' | 'mime'>): TFileViewer {
  const extension = extensionOf(file.name)
  const mime = (file.mime || '').toLowerCase()
  if (IMAGE.has(extension) || /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(mime)) return 'image'
  if (extension === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (HTML.has(extension) || mime === 'text/html') return 'html'
  if (extension in LANGUAGE || mime.startsWith('text/') || /^application\/(json|xml|yaml|x-yaml)$/.test(mime)) return 'code'
  return 'none'
}

/** A linguagem do Monaco (o texto puro quando não se sabe). */
export function languageOf(name: string): string {
  return LANGUAGE[extensionOf(name)] ?? 'plaintext'
}

/** Se abre na tela: o tipo e, para texto, o tamanho. */
export function viewable(file: Pick<IDeliveredFile, 'name' | 'mime' | 'size'>): boolean {
  const viewer = viewerOf(file)
  if (viewer === 'none') return false
  if ((viewer === 'code' || viewer === 'html') && file.size > TEXT_VIEW_MAX_BYTES) return false
  return true
}

/** O nome do tipo que a lista mostra. */
export function kindLabel(file: Pick<IDeliveredFile, 'name' | 'mime'>): string {
  const extension = extensionOf(file.name)
  return extension ? extension.toUpperCase() : file.mime || 'arquivo'
}

const filePath = (conversationId: string, id: string) => `/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(id)}`

/** O link de baixar (anexo): o navegador manda o cookie sozinho. */
export const downloadUrl = (conversationId: string, id: string): string => url(filePath(conversationId, id))

/** Os bytes para o visualizador, com a credencial (`fetch`, nunca a URL no documento). */
export function fetchFileBlob(conversationId: string, id: string, signal?: AbortSignal): Promise<Blob> {
  return apiBlob(`${filePath(conversationId, id)}/view`, { signal })
}
