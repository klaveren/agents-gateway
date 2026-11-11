import { IRemoteCatalog, IRemoteChanges, IRemotePackage, RemoteUnauthorizedError, RemoteUnavailableError } from '@domain/ports/RemoteCatalog.Port'

const TIMEOUT_MS = 30_000
const PACKAGE_TIMEOUT_MS = 120_000

/**
 * 🔌 O CLIENTE DA ORIGEM (as rotas `/connect/<projeto>/*` do outro gateway), com o token de conexão no
 * `X-Tool-Authorization`. A conexão sai DAQUI: a origem (a .4) não alcança a máquina do dev.
 */
export class RemoteClient implements IRemoteCatalog {
  private readonly base: string

  constructor(
    url: string,
    private readonly projectId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${apiBase(url)}/connect/${encodeURIComponent(projectId)}`
  }

  async version(): Promise<number> {
    return (await this.get<{ version: number }>('/version')).version
  }

  changes(since: number): Promise<IRemoteChanges> {
    return this.get(`/changes?since=${since}`)
  }

  package(since?: number): Promise<IRemotePackage> {
    return this.get(`/package${since === undefined ? '' : `?since=${since}`}`, PACKAGE_TIMEOUT_MS)
  }

  async file(sha256: string): Promise<Buffer> {
    const { base64 } = await this.get<{ base64: string }>(`/files/${sha256}`)
    return Buffer.from(base64, 'base64')
  }

  async events(onVersion: (version: number) => void, signal: AbortSignal): Promise<void> {
    const res = await this.request('/events', signal)
    if (!res.body) throw new RemoteUnavailableError('the origin closed the event stream')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = /^data: (.*)$/m.exec(frame)?.[1]
        if (/^event: catalog\.version$/m.test(frame) && data) {
          const version = Number((JSON.parse(data) as { version?: unknown }).version)
          if (Number.isInteger(version)) onVersion(version)
        }
        end = buffer.indexOf('\n\n')
      }
    }
  }

  private async get<T>(path: string, timeoutMs = TIMEOUT_MS): Promise<T> {
    const res = await this.request(path, AbortSignal.timeout(timeoutMs))
    const body = (await res.json().catch(() => undefined)) as { ok?: boolean; result?: T; message?: string } | undefined
    if (!body?.ok) throw new RemoteUnavailableError(body?.message ?? `the origin answered ${res.status}`)
    return body.result as T
  }

  private async request(path: string, signal: AbortSignal): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        headers: { 'X-Tool-Authorization': `Bearer ${this.token}`, Accept: path === '/events' ? 'text/event-stream' : 'application/json' },
        signal,
      })
    } catch (error) {
      throw new RemoteUnavailableError(`the origin did not answer: ${error instanceof Error ? error.message : String(error)}`)
    }
    // ⚖️ 404 também é credencial: o token de outro projeto, ou a conta que saiu dele, ouve o mesmo que projeto inexistente.
    if (res.status === 401 || res.status === 404) {
      await res.body?.cancel().catch(() => undefined)
      throw new RemoteUnauthorizedError(
        res.status === 401 ? 'the connection token is invalid, expired or revoked' : `the origin does not give this token the project ${this.projectId}`,
      )
    }
    if (!res.ok && path === '/events') throw new RemoteUnavailableError(`the origin answered ${res.status}`)
    return res
  }
}

/** A URL do gateway (com ou sem `/v1`, com ou sem barra no fim) → a base da API. */
export function apiBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}
