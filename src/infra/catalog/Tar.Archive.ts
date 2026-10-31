import { gunzipSync, gzipSync } from 'node:zlib'

/**
 * Um TAR (ustar, POSIX.1-1988) com gzip, SEM DEPENDÊNCIA: só arquivos regulares, o bastante para o pacote do catálogo
 * (`tar -xzf` abre). Caminho que não cabe nos 100 + 155 bytes do cabeçalho vai num cabeçalho PAX (`x`) antes do arquivo.
 *
 * ⚖️ Determinístico: dono 0, modo 0644, a mesma data em todos — o mesmo conteúdo dá o mesmo `.tar` (antes do gzip).
 */

export interface ITarEntry {
  path: string
  content: string | Buffer
}

const BLOCK = 512

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function header(name: string, prefix: string, size: number, mtime: number, type: '0' | 'x'): Buffer {
  const block = Buffer.alloc(BLOCK)
  block.write(name, 0, 100, 'utf8')
  block.write(octal(0o644, 8), 100, 8, 'ascii')
  block.write(octal(0, 8), 108, 8, 'ascii')
  block.write(octal(0, 8), 116, 8, 'ascii')
  block.write(octal(size, 12), 124, 12, 'ascii')
  block.write(octal(mtime, 12), 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write(type, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

function padded(data: Buffer): Buffer[] {
  const rest = data.length % BLOCK
  return rest ? [data, Buffer.alloc(BLOCK - rest)] : [data]
}

/** `name` (até 100 bytes) e `prefix` (até 155), cortando numa `/`; `undefined` = não cabe (vai por PAX). */
function split(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let cut = path.indexOf('/'); cut > 0; cut = path.indexOf('/', cut + 1)) {
    const prefix = path.slice(0, cut)
    const name = path.slice(cut + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix }
  }
  return undefined
}

/** Um registro PAX: `"<tamanho> chave=valor\n"`, em que o tamanho conta a si mesmo. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body)
  return `${length}${body}`
}

export function tarEntries(entries: readonly ITarEntry[], mtime: Date): Buffer {
  const seconds = Math.floor(mtime.getTime() / 1000)
  const parts: Buffer[] = []
  for (const entry of entries) {
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content
    let fit = split(entry.path)
    if (!fit) {
      const pax = Buffer.from(paxRecord('path', entry.path), 'utf8')
      parts.push(header('PaxHeader', '', pax.length, seconds, 'x'), ...padded(pax))
      fit = { name: entry.path.slice(-100).replace(/^[^/]*\//, ''), prefix: '' }
    }
    parts.push(header(fit.name, fit.prefix, data.length, seconds, '0'), ...padded(data))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

export function tarGz(entries: readonly ITarEntry[], mtime: Date): Buffer {
  return gzipSync(tarEntries(entries, mtime))
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end < 0 ? length : end).toString('utf8')
}

/** O inverso, para os testes e a CLI: só arquivos regulares e o `path` do PAX. */
export function untarEntries(tar: Buffer): ITarEntry[] {
  const entries: ITarEntry[] = []
  let offset = 0
  let paxPath: string | undefined
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK)
    if (block.every((byte) => byte === 0)) break
    const size = Number.parseInt(field(block, 124, 12).trim() || '0', 8)
    const type = field(block, 156, 1) || '0'
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size)
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    if (type === 'x') {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1]
      continue
    }
    if (type !== '0') continue
    const prefix = field(block, 345, 155)
    const name = field(block, 0, 100)
    entries.push({ path: paxPath ?? (prefix ? `${prefix}/${name}` : name), content: Buffer.from(data) })
    paxPath = undefined
  }
  return entries
}

export function untarGz(archive: Buffer): ITarEntry[] {
  return untarEntries(gunzipSync(archive))
}
