import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIPv6 } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { load } from 'cheerio'
import type { IPermissionChecker } from '@application/Permissions.Service'
import { networkGate } from '@infra/permissions/Network.Gate'
import { askerOf } from './Local.Tools'
import { ILocalTool, IToolResult } from './Tool.Types'

export const FETCH_URL_TOOL = 'fetch_url'

const MAX_REDIRECTS = 5
const TIMEOUT_MS = 20_000
const MAX_BYTES = 3 * 1024 * 1024
const MAX_CHARS = 40_000
const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript))/

/**
 * 🌐 ABRIR PÁGINA, DO GATEWAY: a capacidade `web.fetch` nos provedores sem a nativa (OpenAI, Codex). Lê uma URL e devolve
 * o texto da página.
 *
 * ⛔ A MESMA TRAVA DO WEBFETCH E DO TERMINAL: o destino passa pela regra de rede (`network host:porta`) e pelo portão
 * (`NetworkGate`), que nega loopback, metadados e rede local sem regra exata. A conexão vai ao ENDEREÇO que o portão
 * resolveu (um DNS que muda entre a checagem e a conexão não desvia), e cada redirecionamento é decidido de novo.
 */
export function fetchUrlTool(permissions?: IPermissionChecker): ILocalTool {
  return {
    origin: 'local',
    name: FETCH_URL_TOOL,
    description:
      'Opens a web page (http/https) and returns its readable text (HTML is converted; JSON, XML and plain text come as they are). Long pages are cut. Use it to read a URL the person gave or a search result.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full URL, with http:// or https://' } },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      let target: URL
      try {
        target = new URL(String(args.url ?? '').trim())
      } catch {
        return { status: 'error', result: 'fetch_url: invalid URL.' }
      }
      const gate = networkGate()
      const asker = askerOf(context)
      const token = gate.register((host, port) => {
        if (!permissions) return { allowed: true, reason: 'sem regras' }
        const verdict = permissions.check(asker, { category: 'network', value: `${host}:${port}` }, { log: true })
        return { allowed: verdict.allowed, reason: verdict.reason, ...(verdict.rule ? { pattern: verdict.rule.pattern } : {}) }
      })
      try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          if (target.protocol !== 'http:' && target.protocol !== 'https:') return { status: 'error', result: 'fetch_url: only http and https.' }
          const port = Number(target.port || (target.protocol === 'http:' ? 80 : 443))
          const verdict = await gate.decide(token, target.hostname, port)
          if (!verdict.allowed || !verdict.address) return { status: 'error', result: `Not permitted: ${verdict.reason}.` }
          const response = await open(target, verdict.address)
          const location = response.headers.location
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
            response.resume()
            target = new URL(location, target)
            continue
          }
          return await answer(target, response)
        }
        return { status: 'error', result: `fetch_url: more than ${MAX_REDIRECTS} redirects.` }
      } catch (error) {
        return { status: 'error', result: `fetch_url: ${error instanceof Error ? error.message : String(error)}` }
      } finally {
        gate.release(token)
      }
    },
  }
}

/** A requisição presa ao endereço decidido (o nome segue no SNI e no `Host`). */
function open(target: URL, address: string): Promise<IncomingMessage> {
  const family = isIPv6(address) ? 6 : 4
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; agents-gateway)',
          Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
          options?.all ? callback(null, [{ address, family }]) : callback(null, address, family)) as never,
        timeout: TIMEOUT_MS,
      },
      resolve,
    )
    req.on('timeout', () => req.destroy(new Error(`no answer in ${TIMEOUT_MS / 1000} s`)))
    req.on('error', reject)
    req.end()
  })
}

async function answer(target: URL, response: IncomingMessage): Promise<IToolResult> {
  const status = response.statusCode ?? 0
  const type = String(response.headers['content-type'] ?? '').toLowerCase()
  if (type && !TEXTUAL.test(type)) {
    response.resume()
    return { status: 'error', result: `fetch_url: ${target.href} is ${type.split(';')[0]}, not a text page.` }
  }
  const { body, cut } = await readBody(response)
  const text = type.includes('html') || /^\s*<(!doctype html|html)/i.test(body) ? htmlText(body) : body.trim()
  const clipped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[… cut at ${MAX_CHARS} characters]` : text
  const head = `URL: ${target.href}\nStatus: ${status}${cut ? ' (body cut at 3 MB)' : ''}\n\n`
  return { status: status >= 400 ? 'error' : 'success', result: `${head}${clipped || '(empty page)'}` }
}

function readBody(response: IncomingMessage): Promise<{ body: string; cut: boolean }> {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
  const stream =
    encoding === 'gzip'
      ? response.pipe(createGunzip())
      : encoding === 'br'
        ? response.pipe(createBrotliDecompress())
        : encoding === 'deflate'
          ? response.pipe(createInflate())
          : response
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let cut = false
    stream.on('data', (chunk: Buffer) => {
      if (cut) return
      size += chunk.length
      chunks.push(chunk)
      if (size > MAX_BYTES) {
        cut = true
        response.destroy()
        resolve({ body: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8'), cut })
      }
    })
    stream.on('end', () => !cut && resolve({ body: Buffer.concat(chunks).toString('utf8'), cut }))
    stream.on('error', (error) => (cut ? undefined : reject(error)))
  })
}

/** O texto legível do HTML: sem script, estilo e navegação; blocos em linhas, links com o endereço. */
export function htmlText(html: string): string {
  const $ = load(html)
  const title = $('title').first().text().trim()
  $('script, style, noscript, svg, iframe, template, head, nav, footer').remove()
  $('a[href]').each((_, element) => {
    const anchor = $(element)
    const href = anchor.attr('href') ?? ''
    if (/^https?:/.test(href) && anchor.text().trim()) anchor.append(` (${href})`)
  })
  $('br').replaceWith('\n')
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote, section, article, header, table, ul, ol').each((_, element) => {
    $(element).append('\n')
  })
  $('h1, h2, h3').each((_, element) => {
    $(element).prepend('\n# ')
  })
  const text = $('body').length ? $('body').text() : $.root().text()
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, index, all) => line || all[index - 1])
  return [title ? `Title: ${title}\n` : '', lines.join('\n').trim()].join('')
}
