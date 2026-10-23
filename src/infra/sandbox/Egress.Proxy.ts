/**
 * O proxy de egresso dos MCPs em contêiner: a ÚNICA porta de saída de um contêiner com rede `allowlist`.
 *
 * ⛔ DUAS TRAVAS, nesta ordem:
 * 1. o host tem de estar na lista (o domínio ou um subdomínio dele) — IP literal só se listado;
 * 2. DEPOIS de resolver o DNS, nenhum endereço pode ser privado, loopback ou link-local. É o que fecha o
 *    caminho para o host do gateway (`host.docker.internal`), para a LAN e para o DNS rebinding (um domínio
 *    permitido que resolve para 127.0.0.1).
 *
 * As funções abaixo são PURAS e testadas aqui; o script do contêiner as embute pelo próprio código-fonte.
 */

export const EGRESS_PORT = 3128
const ALLOWED_PORTS = [80, 443]

/** O host bate com a lista? `exemplo.com` (ou `*.exemplo.com`) aceita o domínio e qualquer subdomínio. */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
  if (!name) return false
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
    return !!pattern && (name === pattern || name.endsWith(`.${pattern}`))
  })
}

/** Endereço que um contêiner NUNCA pode alcançar: privado, loopback, link-local, CGNAT, multicast, reservado. */
export function isPrivateAddress(address: string): boolean {
  const ip = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mapped) return isPrivateAddress(mapped[1])

  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }

  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return true
    const groups = ip.split(':')
    const first = Number.parseInt(groups[0] || '0', 16)
    const second = Number.parseInt(groups[1] || '0', 16)
    // Túneis que embutem um IPv4 (e com ele a rede interna): 6to4 `2002::/16`, Teredo `2001:0::/32`,
    // NAT64 `64:ff9b::/96`.
    if (first === 0x2002 || (first === 0x2001 && second === 0) || (first === 0x64 && second === 0xff9b)) return true
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
  }
  // Não é IP: quem decide é a lista e, depois, o DNS.
  return false
}

export function portAllowed(port: number): boolean {
  return ALLOWED_PORTS.includes(port)
}

/** O script que roda no contêiner do proxy (`node -e`). A lista chega por `ALLOWED_HOSTS` (JSON). */
export function egressProxySource(): string {
  return `
const http = require('http'), net = require('net'), dns = require('dns').promises
const ALLOWED = JSON.parse(process.env.ALLOWED_HOSTS || '[]')
const hostAllowed = ${hostAllowed.toString()}
const isPrivateAddress = ${isPrivateAddress.toString()}
const portAllowed = (port) => ${JSON.stringify(ALLOWED_PORTS)}.includes(port)
async function resolveSafe(host, port) {
  if (!hostAllowed(host, ALLOWED) || !portAllowed(port)) throw new Error('blocked')
  const addresses = await dns.lookup(host.replace(/^\\[|\\]$/g, ''), { all: true })
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error('blocked')
  return addresses[0].address
}
const deny = (res) => { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('blocked by the gateway egress policy') }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url)
    if (url.protocol !== 'http:') return deny(res)
    const port = Number(url.port || 80)
    const ip = await resolveSafe(url.hostname, port)
    const upstream = http.request({ host: ip, port, method: req.method, path: url.pathname + url.search, headers: { ...req.headers, host: url.host } }, (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  } catch { deny(res) }
})
server.on('connect', async (req, socket, head) => {
  try {
    const match = /^\\[?([^\\]]+?)\\]?:(\\d+)$/.exec(req.url || '')
    if (!match) throw new Error('bad target')
    const port = Number(match[2])
    const ip = await resolveSafe(match[1], port)
    const upstream = net.connect(port, ip, () => {
      socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n')
      if (head && head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  } catch { socket.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n') }
})
server.listen(${EGRESS_PORT}, () => console.log('egress ready'))
`
}

/**
 * Os domínios de UMA conversa: `{meta:chave}` vira o valor de `metadata[chave]` (ex.: o domínio do cliente).
 * Placeholder sem valor some — nunca vira "libera tudo".
 */
export function resolveAllowedHosts(patterns: readonly string[], metadata: Record<string, unknown> | undefined): string[] {
  const resolved: string[] = []
  for (const pattern of patterns) {
    const match = /^\{meta:([A-Za-z0-9_]+)\}$/.exec(pattern.trim())
    if (!match) {
      if (pattern.trim()) resolved.push(pattern.trim())
      continue
    }
    const value = metadata?.[match[1]]
    const values = Array.isArray(value) ? value : [value]
    for (const entry of values) if (typeof entry === 'string' && isMetaHost(entry.trim())) resolved.push(entry.trim())
  }
  return [...new Set(resolved)]
}

/**
 * ⛔ O valor de um `{meta:…}` tem que ser UM HOST de verdade, com pelo menos dois rótulos e TLD de letras.
 * A lista casa subdomínios: `com` sozinho liberaria todo `*.com`.
 */
export function isMetaHost(value: string): boolean {
  const labels = value.toLowerCase().split('.')
  if (labels.length < 2 || value.length > 253) return false
  if (!labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false
  return /^[a-z]{2,63}$/.test(labels[labels.length - 1])
}

/** As chaves de `metadata` que um conjunto de padrões cita (`{meta:chave}`). */
export function metaPlaceholderKeys(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => /^\{meta:([A-Za-z0-9_]+)\}$/.exec(pattern.trim())?.[1]).filter((key): key is string => !!key)
}
