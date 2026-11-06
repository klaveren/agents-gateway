/**
 * A CLASSIFICAÇÃO ÚNICA de endereço IP: o portão de rede dos comandos, o proxy de egresso dos MCPs em contêiner, o
 * filtro de URL e a conexão de MCP/aviso de turno decidem por aqui. Nunca por texto: o endereço é lido em binário, então
 * `::ffff:7f00:1`, `::ffff:127.0.0.1` e `0:0:0:0:0:ffff:7f00:1` são o mesmo loopback.
 */

/**
 * - `loopback`: 127/8, `::1` (e o mesmo mapeado em IPv6);
 * - `linklocal`: 169.254/16 (inclui o metadado da nuvem), `fe80::/10`, `fd00:ec2::/32` (metadado da AWS);
 * - `unspecified`: `0.0.0.0/8`, `::`;
 * - `private`: RFC1918, CGNAT, ULA, multicast, reservados e os túneis que embutem um IPv4 (6to4, NAT64, Teredo, v4-compat);
 * - `public`: o resto; `invalid`: não é um IP.
 */
export type TAddressKind = 'loopback' | 'linklocal' | 'unspecified' | 'private' | 'public' | 'invalid'

/**
 * ⛔ SEM referência a nada fora dela: o script do contêiner do proxy a embute pelo `toString()`.
 */
export function classifyAddress(address: string): TAddressKind {
  const text = String(address)
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')

  const octets = (value: string): number[] | undefined => {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
    if (!match) return undefined
    const parts = match.slice(1).map(Number)
    return parts.every((part) => part <= 255) ? parts : undefined
  }
  const fromV4 = (v4: number[]): 'loopback' | 'linklocal' | 'unspecified' | 'private' | 'public' => {
    const [a, b, c] = v4
    if (a === 0) return 'unspecified'
    if (a === 127) return 'loopback'
    if (a === 169 && b === 254) return 'linklocal'
    if (
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
      return 'private'
    return 'public'
  }

  const v4 = octets(text)
  if (v4) return fromV4(v4)
  if (!text.includes(':')) return 'invalid'

  // IPv6: 8 grupos de 16 bits, com `::` expandido e o rabo em IPv4 (`::ffff:1.2.3.4`) convertido.
  let body = text
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(body)
  if (tail) {
    const parts = octets(tail[1])
    if (!parts) return 'invalid'
    body = body.slice(0, tail.index) + ((parts[0] << 8) | parts[1]).toString(16) + ':' + ((parts[2] << 8) | parts[3]).toString(16)
  }
  const halves = body.split('::')
  if (halves.length > 2) return 'invalid'
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return 'invalid'
  const groups = [...head, ...(halves.length === 2 ? new Array<string>(missing).fill('0') : []), ...rest]
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return 'invalid'
  const g = groups.map((group) => Number.parseInt(group, 16))

  const embedded = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255]
  // Um túnel que embute IPv4 nunca é `public`: no mínimo rede local (só com regra exata).
  const tunnel = (v4Parts: number[]): TAddressKind => {
    const kind = fromV4(v4Parts)
    return kind === 'public' ? 'private' : kind
  }

  if (g.every((group) => group === 0)) return 'unspecified'
  if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) return 'loopback'
  // ::ffff:0:0/96 (IPv4 mapeado): vale o que o IPv4 vale.
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff) return fromV4(embedded(g[6], g[7]))
  // ::/96 (IPv4-compatível, em desuso) e ::ffff:0:0:0/96 (SIIT).
  if (g.slice(0, 6).every((group) => group === 0)) return tunnel(embedded(g[6], g[7]))
  if (g.slice(0, 4).every((group) => group === 0) && g[4] === 0xffff && g[5] === 0) return tunnel(embedded(g[6], g[7]))
  // NAT64 64:ff9b::/96 e 64:ff9b:1::/48 (local).
  if (g[0] === 0x64 && g[1] === 0xff9b) return g.slice(2, 6).every((group) => group === 0) ? tunnel(embedded(g[6], g[7])) : 'private'
  // 6to4 2002::/16 (o IPv4 vem logo depois) e Teredo 2001:0::/32.
  if (g[0] === 0x2002) return tunnel(embedded(g[1], g[2]))
  if (g[0] === 0x2001 && g[1] === 0) return 'private'
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return 'linklocal'
  if ((g[0] & 0xffc0) === 0xfe80) return 'linklocal'
  // fec0::/10 (site-local), fc00::/7 (ULA), ff00::/8 (multicast).
  if ((g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff00) === 0xff00) return 'private'
  return 'public'
}

/** `loopback`, `linklocal` (metadado incluso) e `unspecified`: nunca por curinga, nunca por cadastro de projeto. */
export function isAlwaysBlockedKind(kind: TAddressKind): boolean {
  return kind === 'loopback' || kind === 'linklocal' || kind === 'unspecified'
}
