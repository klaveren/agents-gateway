import { randomBytes } from 'node:crypto'

/**
 * ⚖️ O ID DA CONVERSA: `gw_` + 26 caracteres (ULID: 48 bits de tempo + 80 aleatórios, em base32 de Crockford). Curto,
 * ordenável pelo momento em que nasceu, e no mesmo formato do `ses_` + 26 do AKM — é ele que vira a sessão de auditoria
 * do lado de lá (ver `Agent.Identity`). ⛔ O id não diz provedor nem lane: a conversa troca de provedor (cota, troca
 * à mão) e um prefixo como `claudesub-agent-` passaria a mentir. Os ids antigos continuam valendo como estão.
 */
export const SESSION_ID_PREFIX = 'gw_'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newSessionId(now: number = Date.now(), random: Buffer = randomBytes(10)): string {
  let time = ''
  let rest = now
  for (let index = 0; index < 10; index++) {
    time = CROCKFORD[rest % 32] + time
    rest = Math.floor(rest / 32)
  }
  let tail = ''
  // 80 bits = 16 caracteres de 5 bits.
  let bits = 0n
  for (const byte of random) bits = (bits << 8n) | BigInt(byte)
  for (let index = 0; index < 16; index++) {
    tail = CROCKFORD[Number(bits & 31n)] + tail
    bits >>= 5n
  }
  return `${SESSION_ID_PREFIX}${time}${tail}`
}
