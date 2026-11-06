import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns'
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { classifyAddress } from '@domain/Address.Policy'

/**
 * Devolve o MOTIVO da recusa, ou nada se o endereço serve. Decide sobre o endereço JÁ RESOLVIDO (não sobre o nome).
 */
export type TGuardPolicy = (url: URL, address: string) => string | undefined

/** Quantos redirecionamentos seguimos (cada salto é conferido de novo, como se fosse uma URL nova). */
const MAX_REDIRECTS = 5

/**
 * ⛔ A política de saída das URLs que o GATEWAY conecta por conta própria (MCP remoto, aviso de turno):
 * - `linklocal` (metadado da nuvem incluso) e `unspecified`: nunca, nem na lista;
 * - `loopback` e `private` (LAN, CGNAT, ULA…): se `allowPrivate` (quem cadastrou é o admin do gateway) ou se a lista
 *   (`listed`) citar o host ou o endereço;
 * - público: sempre.
 */
export function egressPolicy(options: { allowPrivate: boolean; listed: (url: URL, address: string) => boolean }): TGuardPolicy {
  return (url, address) => {
    const kind = classifyAddress(address)
    if (kind === 'public') return undefined
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (kind === 'linklocal' || kind === 'unspecified') return `${host} aponta para ${address} (link-local/metadado): sempre negado`
    if (kind === 'invalid') return `${host} não resolveu para um endereço válido`
    if (options.listed(url, address)) return undefined
    if (options.allowPrivate) return undefined
    return kind === 'loopback'
      ? `${host} aponta para ${address} (loopback): só se estiver listado na variável de ambiente do recurso`
      : `${host} aponta para ${address} (rede local): só se estiver listado na variável de ambiente do recurso`
  }
}

/**
 * A lista de uma variável de ambiente (`MCP_PRIVATE_HOSTS`, `TURN_CALLBACK_HOSTS`): `host`, `host:porta`, IP ou faixa
 * CIDR (`10.20.0.0/16`), separados por vírgula. Casa pelo NOME da URL ou pelo endereço resolvido.
 */
export function hostListed(entries: readonly string[], url: URL, address: string): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return entries.some((raw) => {
    const entry = raw
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
    if (!entry) return false
    if (entry.includes('/')) return inCidr(entry, address)
    return entry === host || entry === `${host}:${port}` || entry === address.toLowerCase()
  })
}

function inCidr(cidr: string, address: string): boolean {
  const [base, bits] = cidr.split('/')
  const family = isIP(base)
  const prefix = Number(bits)
  if (!family || !Number.isInteger(prefix)) return false
  try {
    const list = new BlockList()
    list.addSubnet(base, prefix, family === 4 ? 'ipv4' : 'ipv6')
    const target = isIP(address.replace(/%.*$/, ''))
    return target === 0 ? false : list.check(address.replace(/%.*$/, ''), target === 4 ? 'ipv4' : 'ipv6')
  } catch {
    return false
  }
}

export function listFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Um `fetch` que só conecta onde a política deixa, conferindo o endereço NO MOMENTO DE CONECTAR (a resolução da
 * conexão é a própria conferida: não há rebinding entre "conferir" e "conectar"), e que não segue redirect às cegas:
 * cada salto passa pela mesma conferência, e saltar para OUTRA origem tira as credenciais da requisição.
 * `redirect: 'error'`/`'manual'` valem como no `fetch`.
 */
export function guardedFetch(policy: TGuardPolicy): typeof fetch {
  // ⛔ Agente PRÓPRIO desta política: socket reaproveitado do agente global pularia a conferência de outra política.
  const agents = { 'http:': new HttpAgent({ keepAlive: true }), 'https:': new HttpsAgent({ keepAlive: true }) }
  return async (input, init) => {
    const source = input instanceof Request ? input : undefined
    let url = new URL(source ? source.url : String(input))
    let method = (init?.method ?? source?.method ?? 'GET').toUpperCase()
    let headers = new Headers(init?.headers ?? source?.headers)
    let body = await bodyOf(init?.body ?? (source && method !== 'GET' && method !== 'HEAD' ? await source.arrayBuffer() : undefined))
    const signal = init?.signal ?? source?.signal ?? undefined
    const redirect = init?.redirect ?? source?.redirect ?? 'follow'

    for (let hop = 0; ; hop += 1) {
      const response = await once(url, method, headers, body, signal, policy, agents)
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || !location || ![301, 302, 303, 307, 308].includes(response.status) || redirect === 'manual') return response
      await response.body?.cancel().catch(() => undefined)
      if (redirect === 'error') throw new TypeError(`redirecionamento recusado (${response.status}) para ${location}`)
      if (hop >= MAX_REDIRECTS) throw new TypeError('redirecionamentos demais')
      const next = new URL(location, url)
      if (next.origin !== url.origin) {
        // ⛔ Outra origem não recebe a credencial desta: só o que descreve o conteúdo.
        const kept = new Headers()
        for (const name of ['accept', 'content-type']) if (headers.has(name)) kept.set(name, headers.get(name)!)
        headers = kept
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = method === 'HEAD' ? 'HEAD' : 'GET'
        body = undefined
        headers.delete('content-type')
      }
      url = next
    }
  }
}

async function bodyOf(body: BodyInit | null | undefined): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  return Buffer.from(await new Response(body).arrayBuffer())
}

function once(
  url: URL,
  method: string,
  headers: Headers,
  body: Buffer | undefined,
  signal: AbortSignal | undefined,
  policy: TGuardPolicy,
  agents: { 'http:': HttpAgent; 'https:': HttpsAgent },
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new TypeError(`protocolo não suportado: ${url.protocol}`))
    const literal = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(literal)) {
      const refusal = policy(url, literal)
      if (refusal) return reject(new TypeError(refusal))
    }
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const outgoing: Record<string, string> = {}
    headers.forEach((value, name) => (outgoing[name] = value))
    outgoing['accept-encoding'] = 'identity'
    if (body) outgoing['content-length'] = String(body.length)
    delete outgoing.host
    const request = send(
      url,
      {
        method,
        headers: outgoing,
        agent: agents[url.protocol as 'http:' | 'https:'],
        ...(signal ? { signal } : {}),
        // ⛔ A conferência E a conexão usam a mesma resolução: o que passou é o que se liga.
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { ...options, all: true }, (error, found) => {
            const list = (found as unknown as Array<{ address: string; family: number }> | undefined) ?? []
            if (error || !list.length) return callback(error ?? new Error(`não resolveu ${hostname}`), '', 4)
            for (const one of list) {
              const refusal = policy(url, one.address)
              if (refusal) return callback(new Error(refusal), '', 4)
            }
            if (options.all) return (callback as unknown as (error: null, all: typeof list) => void)(null, list)
            return callback(null, list[0].address, list[0].family)
          })
        },
      },
      (answer) => {
        const reply = new Headers()
        for (const [name, value] of Object.entries(answer.headers)) {
          if (Array.isArray(value)) for (const one of value) reply.append(name, one)
          else if (value !== undefined) reply.set(name, value)
        }
        const status = answer.statusCode ?? 502
        const empty = method === 'HEAD' || status === 204 || status === 205 || status === 304
        if (empty) answer.resume()
        resolve(new Response(empty ? null : (Readable.toWeb(answer) as ReadableStream<Uint8Array>), { status, statusText: answer.statusMessage ?? '', headers: reply }))
      },
    )
    request.on('error', (error) => reject(error))
    request.end(body)
  })
}
