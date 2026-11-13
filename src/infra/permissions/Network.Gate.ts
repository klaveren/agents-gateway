import { classifyAddress, isAlwaysBlockedKind } from '@domain/Address.Policy'
import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createServer, IncomingMessage, request as httpRequest, Server, ServerResponse } from 'node:http'
import { isIP, connect, createServer as createTcpServer, Server as TcpServer, Socket } from 'node:net'
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
 * ⛔ Sempre negado, sem exceção: as portas do próprio gateway, endereços de link-local e o de metadados da nuvem
 * (169.254.169.254). Serviço no loopback (`localhost:<porta>`) e rede local (10/8, 172.16/12, 192.168/16, fc00::/7) só
 * com regra EXATA, nunca por curinga.
 * Fala HTTP (URL absoluta) e CONNECT (HTTPS, e SSH por um auxiliar de ProxyCommand). Token desconhecido: 407.
 * ⚖️ E SOCKS5, na MESMA porta (o primeiro byte diz o protocolo), com usuário e senha: o usuário é o token. É o que deixa o
 * cliente que só fala SOCKS (o driver do Mongo, pelo `ALL_PROXY=socks5://…`) passar pelo portão sem abrir porta local nenhuma.
 */
export class NetworkGate {
  private server?: TcpServer
  private http?: Server
  private port?: number
  private readonly runs = new Map<string, TNetworkDecide>()

  /** As portas do loopback que nenhum comando alcança: a do gateway (`PORT`) e a deste portão. */
  private protectedPorts(): number[] {
    return [Number(process.env.PORT) || 3000, ...(this.port ? [this.port] : [])]
  }

  async start(): Promise<number> {
    if (this.port) return this.port
    const http = createServer((req, res) => void this.forward(req, res).catch(() => res.destroy()))
    http.on('connect', (req, socket, head) => void this.tunnel(req, socket, head).catch(() => socket.destroy()))
    // ⛔ Um cliente que cai no meio (o comando morreu, o curl desistiu) nunca derruba o gateway.
    http.on('clientError', (_error, socket) => socket.destroy())
    this.http = http
    // O primeiro byte separa os dois: 0x05 é o SOCKS5; o resto vai, intacto, para o HTTP.
    this.server = createTcpServer((socket) => {
      socket.on('error', () => socket.destroy())
      socket.once('data', (first: Buffer) => {
        if (first[0] === SOCKS_VERSION) return void this.socks(socket, first).catch(() => socket.destroy())
        socket.pause()
        socket.unshift(first)
        http.emit('connection', socket)
        socket.resume()
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    // A porta não segura o processo de pé: ela serve aos comandos, e cada comando já segura o seu.
    this.server.unref()
    this.port = (this.server.address() as { port: number }).port
    return this.port
  }

  stop(): void {
    this.server?.close()
    this.http?.close()
    this.server = undefined
    this.http = undefined
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
    const raw = host.replace(/^\[|\]$/g, '').toLowerCase()
    if (raw === 'metadata.google.internal' || raw.endsWith('.localhost')) return { allowed: false, reason: `${raw} é sempre negado` }
    // O loopback tem um nome só para as regras: `localhost` (127.0.0.1 e ::1 também chegam aqui).
    // ⛔ Pelo endereço lido em binário, não pelo texto: `::ffff:7f00:1` e `0:0:0:0:0:0:0:1` também são o loopback.
    const loopbackName = raw === 'localhost' || (isIP(raw) !== 0 && classifyAddress(raw) === 'loopback')
    const name = loopbackName ? 'localhost' : raw
    if (loopbackName && this.protectedPorts().includes(port)) return { allowed: false, reason: `localhost:${port} é do próprio gateway: sempre negado` }
    const verdict = decide(name, port)
    if (!verdict.allowed) return verdict
    if (loopbackName) {
      // ⛔ Serviço LOCAL (o Mongo, o Redis, a API no mesmo host) só com a regra EXATA dele: `localhost:<porta>`.
      if (verdict.pattern !== `localhost:${port}` && verdict.pattern !== `127.0.0.1:${port}`)
        return { allowed: false, reason: `localhost:${port} só com a regra exata localhost:${port}` }
      return { ...verdict, address: '127.0.0.1' }
    }
    let address: string
    try {
      address = isIP(name) ? name : preferredAddress(await lookup(name, { all: true }))
    } catch {
      return { allowed: false, reason: `não resolveu ${name}` }
    }
    const kind = addressKind(address)
    if (kind === 'blocked') return { allowed: false, reason: `${name} aponta para ${address}, sempre negado` }
    // ⛔ As portas do gateway valem pelo ENDEREÇO resolvido também: o IP da LAN da própria máquina não é um atalho.
    if (kind === 'private' && this.protectedPorts().includes(port)) return { allowed: false, reason: `${name}:${port} é do próprio gateway: sempre negado` }
    if (kind === 'private' && (!verdict.pattern || verdict.pattern.includes('*'))) return { allowed: false, reason: `${name} é rede local: só com regra exata` }
    return { ...verdict, address }
  }

  private async tunnel(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy())
    const [host, rawPort] = splitTarget(req.url ?? '')
    const port = Number(rawPort ?? 443)
    const verdict = await this.decide(tokenOf(req), host, port)
    if (!verdict.allowed) {
      // O cliente TCP (ssh, mongosh) só vê "Connection refused": o motivo fica no log do serviço.
      if (tokenOf(req)) console.warn(`[portão] negado ${host}:${port}: ${verdict.reason}`)
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

  /**
   * ⚖️ O SOCKS5 (RFC 1928), só com usuário e senha (RFC 1929): o usuário é o token do comando, e sem ele nada passa. Só
   * CONNECT; o destino passa pela MESMA decisão do CONNECT do HTTP (as regras, os bloqueios fixos, o endereço resolvido).
   */
  private async socks(socket: Socket, first: Buffer): Promise<void> {
    const reader = new ByteReader(socket, first)
    const deadline = setTimeout(() => socket.destroy(), SOCKS_HANDSHAKE_MS)
    const reply = (code: number) => Buffer.from([SOCKS_VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0])
    try {
      const [, methods] = await reader.take(2)
      if (!(await reader.take(methods)).includes(SOCKS_USER_PASSWORD)) return void socket.end(Buffer.from([SOCKS_VERSION, 0xff]))
      socket.write(Buffer.from([SOCKS_VERSION, SOCKS_USER_PASSWORD]))
      const [, userLength] = await reader.take(2)
      const token = (await reader.take(userLength)).toString('utf8')
      const [passwordLength] = await reader.take(1)
      await reader.take(passwordLength)
      if (!this.runs.has(token)) return void socket.end(Buffer.from([1, 1]))
      socket.write(Buffer.from([1, 0]))
      const [, command, , type] = await reader.take(4)
      let host: string
      if (type === 1) host = [...(await reader.take(4))].join('.')
      else if (type === 3) host = (await reader.take((await reader.take(1))[0])).toString('utf8')
      else if (type === 4) host = ipv6Of(await reader.take(16))
      else return void socket.end(reply(0x08))
      const port = (await reader.take(2)).readUInt16BE(0)
      if (command !== 1) return void socket.end(reply(0x07))
      clearTimeout(deadline)
      const verdict = await this.decide(token, host, port)
      if (!verdict.allowed) {
        // O cliente só vê "conexão não permitida": o motivo fica no log do serviço, como no CONNECT.
        console.warn(`[portão] negado ${host}:${port}: ${verdict.reason}`)
        return void socket.end(reply(0x02))
      }
      const rest = reader.release()
      const upstream: Socket = connect(port, verdict.address!, () => {
        socket.write(reply(0x00))
        if (rest.length) upstream.write(rest)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', () => (upstream.connecting ? socket.end(reply(0x05)) : socket.destroy()))
      socket.on('close', () => upstream.destroy())
    } finally {
      clearTimeout(deadline)
    }
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

const SOCKS_VERSION = 0x05
const SOCKS_USER_PASSWORD = 0x02
/** O cliente SOCKS tem este tempo para dizer quem é e aonde vai; depois, a conexão cai. */
const SOCKS_HANDSHAKE_MS = 15_000

/** Lê do socket os bytes do aperto de mão do SOCKS, na quantidade pedida, venham em quantos pedaços vierem. */
class ByteReader {
  private buffer: Buffer
  private wake?: () => void
  private closed = false
  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.wake?.()
  }
  private readonly onClose = () => {
    this.closed = true
    this.wake?.()
  }

  constructor(
    private readonly socket: Socket,
    first: Buffer,
  ) {
    this.buffer = first
    socket.on('data', this.onData)
    socket.on('close', this.onClose)
  }

  async take(count: number): Promise<Buffer> {
    while (this.buffer.length < count) {
      if (this.closed) throw new Error('socks: o cliente fechou no meio')
      await new Promise<void>((resolve) => (this.wake = resolve))
    }
    const out = this.buffer.subarray(0, count)
    this.buffer = this.buffer.subarray(count)
    return out
  }

  /** Para de ler: o que sobrou já é do túnel. */
  release(): Buffer {
    this.socket.off('data', this.onData)
    this.socket.off('close', this.onClose)
    return this.buffer
  }
}

/** Os 16 bytes de um IPv6 do SOCKS, no texto que o `connect` entende. */
function ipv6Of(bytes: Buffer): string {
  const groups: string[] = []
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16))
  return groups.join(':')
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
 * ⚖️ O endereço do túnel: o IPv4 antes do IPv6. O DNS pode responder o IPv6 primeiro (Cloudflare) e o host sem rota
 * IPv6 deixava a conexão morrer ("Proxy CONNECT aborted"). O túnel liga no endereço conferido aqui, nunca no nome.
 */
export function preferredAddress(found: ReadonlyArray<{ address: string; family: number }>): string {
  const first = found.find((one) => one.family === 4) ?? found[0]
  if (!first) throw new Error('no address')
  return first.address
}

/**
 * `blocked`: loopback, link-local (inclui o de metadados), não especificado — nunca; `private`: o resto do que o
 * `classifyAddress` fecha (LAN, CGNAT, multicast, reservados, túneis) — só com regra exata; `public`: o resto.
 */
export function addressKind(address: string): 'blocked' | 'private' | 'public' {
  const kind = classifyAddress(address)
  if (isAlwaysBlockedKind(kind)) return 'blocked'
  return kind === 'public' ? 'public' : 'private'
}

let shared: NetworkGate | undefined
/** A porta do processo (uma só, como o cerco). */
export function networkGate(): NetworkGate {
  shared ??= new NetworkGate()
  return shared
}
