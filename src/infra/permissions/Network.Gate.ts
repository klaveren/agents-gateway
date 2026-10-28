import { isPrivateAddress } from '@infra/sandbox/Egress.Proxy'
import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createServer, IncomingMessage, request as httpRequest, Server, ServerResponse } from 'node:http'
import { isIP, connect, Socket } from 'node:net'
import { Duplex } from 'node:stream'

/** A decisão para um destino: o que as regras do agente dizem (ver `Permission.Policy`). */
export interface INetworkVerdict {
  allowed: boolean
  reason: string
  /** O padrão que decidiu. Destino na rede LOCAL só passa com padrão exato (sem `*`). */
  pattern?: string
}

export type TNetworkDecide = (host: string, port: number) => INetworkVerdict

/**
 * A PORTA DE REDE dos comandos cercados: o único endereço que o cerco deixa o comando alcançar (127.0.0.1:<porta>).
 * Cada comando recebe um TOKEN aleatório (no `HTTPS_PROXY` dele); cada conexão chega com o token e é decidida pelas
 * regras do agente daquele comando — o runtime do cerco só sabe aplicar UMA lista de destinos para o processo inteiro.
 *
 * ⛔ Sempre negado, sem exceção: o próprio servidor (loopback), endereços de link-local e o de metadados da nuvem
 * (169.254.169.254). Rede local (10/8, 172.16/12, 192.168/16, fc00::/7) só com regra exata, nunca por curinga.
 * Fala HTTP (URL absoluta) e CONNECT (HTTPS, e SSH por um auxiliar de ProxyCommand). Token desconhecido: 407.
 */
export class NetworkGate {
  private server?: Server
  private port?: number
  private readonly runs = new Map<string, TNetworkDecide>()

  async start(): Promise<number> {
    if (this.port) return this.port
    this.server = createServer((req, res) => void this.forward(req, res).catch(() => res.destroy()))
    this.server.on('connect', (req, socket, head) => void this.tunnel(req, socket, head).catch(() => socket.destroy()))
    // ⛔ Um cliente que cai no meio (o comando morreu, o curl desistiu) nunca derruba o gateway.
    this.server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    // A porta não segura o processo de pé: ela serve aos comandos, e cada comando já segura o seu.
    this.server.unref()
    this.port = (this.server.address() as { port: number }).port
    return this.port
  }

  stop(): void {
    this.server?.close()
    this.server = undefined
    this.port = undefined
  }

  /** Um comando que vai rodar: devolve o token dele. `release` ao terminar (sem token, nenhuma conexão passa). */
  register(decide: TNetworkDecide): string {
    const token = randomBytes(18).toString('base64url')
    this.runs.set(token, decide)
    return token
  }

  release(token: string): void {
    this.runs.delete(token)
  }

  /** A decisão completa para um destino, já com os bloqueios fixos e a checagem do endereço resolvido. */
  async decide(token: string | undefined, host: string, port: number): Promise<INetworkVerdict & { address?: string }> {
    const decide = token ? this.runs.get(token) : undefined
    if (!decide) return { allowed: false, reason: 'comando sem autorização de rede' }
    const name = host.replace(/^\[|\]$/g, '').toLowerCase()
    if (name === 'localhost' || name.endsWith('.localhost') || name === 'metadata.google.internal') return { allowed: false, reason: `${name} é sempre negado` }
    const verdict = decide(name, port)
    if (!verdict.allowed) return verdict
    let address: string
    try {
      address = isIP(name) ? name : (await lookup(name)).address
    } catch {
      return { allowed: false, reason: `não resolveu ${name}` }
    }
    const kind = addressKind(address)
    if (kind === 'blocked') return { allowed: false, reason: `${name} aponta para ${address}, sempre negado` }
    if (kind === 'private' && (!verdict.pattern || verdict.pattern.includes('*'))) return { allowed: false, reason: `${name} é rede local: só com regra exata` }
    return { ...verdict, address }
  }

  private async tunnel(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy())
    const [host, rawPort] = splitTarget(req.url ?? '')
    const port = Number(rawPort ?? 443)
    const verdict = await this.decide(tokenOf(req), host, port)
    if (!verdict.allowed) {
      client.end(`HTTP/1.1 ${tokenOf(req) ? 403 : 407} Forbidden\r\nContent-Type: text/plain\r\nProxy-Authenticate: Basic\r\n\r\n${verdict.reason}\n`)
      return
    }
    const upstream: Socket = connect(port, verdict.address!, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.on('error', () => res.destroy())
    res.on('error', () => req.destroy())
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end('proxy: URL absoluta esperada\n')
      return
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end('proxy: use CONNECT para HTTPS\n')
      return
    }
    const port = Number(target.port || 80)
    const verdict = await this.decide(tokenOf(req), target.hostname, port)
    if (!verdict.allowed) {
      res.writeHead(tokenOf(req) ? 403 : 407, { 'Content-Type': 'text/plain', 'Proxy-Authenticate': 'Basic' }).end(`${verdict.reason}\n`)
      return
    }
    const headers = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const upstream = httpRequest(
      { host: verdict.address, port, method: req.method, path: `${target.pathname}${target.search}`, headers: { ...headers, host: target.host } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end('proxy: falha ao conectar\n')))
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }
}

function tokenOf(req: IncomingMessage): string | undefined {
  const header = req.headers['proxy-authorization']
  const match = typeof header === 'string' ? /^Basic\s+(.+)$/i.exec(header) : undefined
  if (!match) return undefined
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  return decoded.split(':')[0] || undefined
}

function splitTarget(target: string): [string, string | undefined] {
  if (target.startsWith('[')) {
    const end = target.indexOf(']')
    return [target.slice(1, end), target.slice(end + 2) || undefined]
  }
  const at = target.lastIndexOf(':')
  return at > 0 ? [target.slice(0, at), target.slice(at + 1)] : [target, undefined]
}

/**
 * `blocked`: loopback, link-local (inclui o de metadados), não especificado — nunca; `private`: o resto do que o
 * `isPrivateAddress` dos contêineres fecha (LAN, CGNAT, multicast, reservados) — só com regra exata; `public`: o resto.
 */
export function addressKind(address: string): 'blocked' | 'private' | 'public' {
  const ip = address
    .trim()
    .toLowerCase()
    .replace(/^::ffff:(?=\d+\.)/, '')
  if (/^(127\.|0\.|169\.254\.)/.test(ip) || ip === '::1' || ip === '::' || ip.startsWith('fe80')) return 'blocked'
  return isPrivateAddress(ip) ? 'private' : 'public'
}

let shared: NetworkGate | undefined
/** A porta do processo (uma só, como o cerco). */
export function networkGate(): NetworkGate {
  shared ??= new NetworkGate()
  return shared
}
