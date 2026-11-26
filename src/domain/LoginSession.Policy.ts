/**
 * ⚖️ QUANTO DURA O LOGIN DE UMA PESSOA (a sessão da tela).
 *
 * · Sem "Manter conectado": 12 h (`AUTH_TOKEN_TTL_HOURS`), sem renovação — como sempre foi.
 * · Com "Manter conectado": 30 dias (`AUTH_KEEP_SIGNED_IN_DAYS`) que DESLIZAM com o uso: a cada uso pelo navegador,
 *   a validade volta a 30 dias a partir de agora. Para não regravar cookie e token a cada requisição, renova no
 *   máximo uma vez por hora (`AUTH_SESSION_RENEW_MINUTES`).
 *
 * ⛔ Só a sessão de LOGIN de pessoa. O token de acesso (`agw_`) e o JWT derivado dele não renovam nem duram mais.
 */
export const SESSION_TTL_HOURS = 12
export const KEEP_SIGNED_IN_DAYS = 30
export const SESSION_RENEW_MINUTES = 60

/** O rótulo do aparelho guardado com a sessão: curto, nunca o user-agent inteiro. */
const DEVICE_LABEL_MAX = 80

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function sessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return positive(env.AUTH_TOKEN_TTL_HOURS, SESSION_TTL_HOURS) * 3_600_000
}

export function keepSignedInTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return positive(env.AUTH_KEEP_SIGNED_IN_DAYS, KEEP_SIGNED_IN_DAYS) * 86_400_000
}

export function sessionRenewIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return positive(env.AUTH_SESSION_RENEW_MINUTES, SESSION_RENEW_MINUTES) * 60_000
}

/**
 * O aparelho e o navegador, resumidos do user-agent (`Safari · iPhone`). ⚖️ O app instalado no iPhone (PWA) não traz
 * `Safari` no user-agent: vira `App · iPhone`. Desconhecido vira `Navegador`.
 */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = (userAgent ?? '').slice(0, 512)
  if (!ua.trim()) return 'Desconhecido'

  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : undefined

  const ios = device === 'iPhone' || device === 'iPad'
  const browser = /Electron\//.test(ua)
    ? 'App'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : ios
                ? 'App'
                : /curl\//i.test(ua)
                  ? 'curl'
                  : 'Navegador'

  return (device ? `${browser} · ${device}` : browser).slice(0, DEVICE_LABEL_MAX)
}
