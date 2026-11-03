import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { NextFunction, Request, RequestHandler, Response } from 'express'

const zip = promisify(gzip)

/** Abaixo disto, comprimir custa mais do que economiza. */
export const COMPRESS_MIN_BYTES = 1024
/** Os arquivos da tela que vão comprimidos (o resto — imagem, fonte — já vem comprimido). */
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.json', '.map', '.txt', '.webmanifest'])
/** O bundle tem hash no nome (`/assets/index-3f2a.js`): o conteúdo daquele nome nunca muda. */
const HASHED = /^\/assets\//

function acceptsGzip(req: Request): boolean {
  return /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
}

/**
 * As respostas JSON da API em GZIP, quando o navegador aceita e o corpo passa de 1 KB. O link até a VM é lento
 * (~128 KB/s): o JSON comprime 5–10×.
 *
 * ⛔ Só o `res.json`: o fluxo ao vivo (SSE, `res.write`) segue sem compressão — comprimido, ele chegaria em blocos, não
 * evento a evento. A compressão é assíncrona: não trava o servidor com uma resposta grande.
 */
export function compressJson(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!acceptsGzip(req)) return next()
    const json = res.json.bind(res)
    res.json = (body?: unknown) => {
      const text = JSON.stringify(body)
      if (text === undefined || Buffer.byteLength(text) < COMPRESS_MIN_BYTES) return json(body)
      zip(text).then(
        (zipped) => {
          if (res.headersSent) return
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Content-Encoding', 'gzip')
          res.setHeader('Content-Length', zipped.length)
          res.vary('Accept-Encoding')
          res.end(zipped)
        },
        () => {
          if (!res.headersSent) json(body)
        },
      )
      return res
    }
    next()
  }
}

/**
 * Os arquivos da tela (`web/dist`) em GZIP, comprimidos uma vez e guardados na memória (pela data do arquivo). O que
 * tem hash no nome (`/assets/`) vai com cache de um ano: recarregar a página não pergunta de novo por ele. O que não
 * serve aqui (sem gzip, outro tipo, fora da pasta, não existe) segue para o `express.static`.
 */
export function gzipStatic(root: string): RequestHandler {
  const base = path.resolve(root)
  const cache = new Map<string, { mtime: number; body: Buffer }>()
  return (req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !acceptsGzip(req) || !COMPRESSIBLE.has(path.extname(req.path))) return next()
    let file: string
    try {
      file = path.resolve(base, `.${decodeURIComponent(req.path)}`)
    } catch {
      return next()
    }
    if (!file.startsWith(base + path.sep)) return next()
    void (async () => {
      const info = await stat(file).catch(() => undefined)
      if (!info?.isFile()) return next()
      let entry = cache.get(file)
      if (!entry || entry.mtime !== info.mtimeMs) {
        entry = { mtime: info.mtimeMs, body: await zip(await readFile(file)) }
        cache.set(file, entry)
      }
      res.type(path.extname(file))
      res.setHeader('Content-Encoding', 'gzip')
      res.setHeader('Content-Length', entry.body.length)
      res.vary('Accept-Encoding')
      res.setHeader('Cache-Control', HASHED.test(req.path) ? 'public, max-age=31536000, immutable' : 'public, max-age=0')
      if (req.method === 'HEAD') return void res.end()
      res.end(entry.body)
    })().catch(next)
  }
}
