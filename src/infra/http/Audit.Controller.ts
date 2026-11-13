import { NextFunction, Request, RequestHandler, Response } from 'express'
import { IDENTITY_HEADERS } from '@domain/Agent.Identity'
import { AUDIT_PAGE_MAX, IAuditQuery } from '@domain/models/Audit.Model'
import { IAuditRepository } from '@domain/ports/AuditRepository.Port'
import { caller } from '@infra/mcp/Caller.Identity'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { clientIp } from './Security.Middleware'

/**
 * ⚖️ O QUE ENTRA NA AUDITORIA: toda rota que MUDA algo (POST, PUT, PATCH, DELETE) e a leitura de uma conversa
 * compartilhada por link (quem abriu o que foi exposto). As leituras comuns não: seriam milhares por sessão.
 * ⛔ Fica de fora o MCP do próprio gateway: cada ferramenta dele chama a API, e a chamada da API já é o evento. E o
 * tráfego das ferramentas dos agentes (o proxy dos MCPs, as ferramentas dos CLIs) e o acompanhar da caixa de entrada:
 * a chamada de ferramenta já fica no turno gravado, e o resto é ruído.
 */
const AUDITED_METHODS: ReadonlySet<string> = new Set(['post', 'put', 'patch', 'delete'])
const AUDITED_READS: ReadonlySet<string> = new Set(['/shared/:id'])
const SKIPPED: ReadonlySet<string> = new Set(['/mcp', '/mcp-proxy/:serverId', '/turn-tools', '/conversations/events/:streamId/follow'])
/** As rotas em que o e-mail digitado é o que identifica a tentativa (a conta ainda não está na credencial). */
const EMAIL_ROUTES: ReadonlySet<string> = new Set(['/auth/login', '/auth/setup'])

/** O status de verdade de uma resposta em stream (a recusa sai como evento depois do 200): quem responde grava aqui. */
export const AUDIT_STATUS_LOCAL = 'auditStatus'
/** E a mensagem dessa recusa (o corpo do stream não é JSON). */
export const AUDIT_ERROR_LOCAL = 'auditError'
/** O tamanho máximo da mensagem de erro guardada. */
const ERROR_MAX = 500

/**
 * A mensagem de uma resposta de erro da API (`{ ok: false, message, details }`): a mensagem e, num 422, cada campo com o
 * problema dele. ⛔ Só o envelope de erro — o corpo de quem deu certo nunca entra.
 */
export function errorOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== false) return undefined
  const { message, details } = body as { message?: unknown; details?: unknown }
  const fields = Array.isArray(details)
    ? details
        .filter((item): item is { field?: unknown; message?: unknown } => !!item && typeof item === 'object')
        .map((item) => `${typeof item.field === 'string' ? `${item.field}: ` : ''}${String(item.message ?? '')}`)
        .filter(Boolean)
    : []
  const text = [typeof message === 'string' ? message : '', ...fields].filter(Boolean).join(' — ')
  return text ? text.slice(0, ERROR_MAX) : undefined
}

export interface IAuditControllerDeps {
  repository: IAuditRepository
  proof?: ICallerProof
  now?: () => Date
}

/** A auditoria: grava (o `trail` de cada rota) e mostra (`GET /audit`, só para quem administra o gateway). */
export class AuditController {
  constructor(private readonly deps: IAuditControllerDeps) {
    this.list = this.list.bind(this)
  }

  /** O registro da rota: anota no fim da resposta quem, o quê, em quê e como terminou. Nada para quem não é auditado. */
  trail(method: string, routePath: string): RequestHandler | undefined {
    if (SKIPPED.has(routePath) || (!AUDITED_METHODS.has(method) && !AUDITED_READS.has(routePath))) return undefined
    const action = `${method.toUpperCase()} ${routePath}`
    return (req: Request, res: Response, next: NextFunction) => {
      const started = Date.now()
      // A identidade é a do escopo da credencial (rótulo do token): lida agora, o `finish` já não está nele.
      const who = caller()
      const header = (name: string) => (typeof req.headers[name] === 'string' && req.headers[name] ? String(req.headers[name]).slice(0, 120) : undefined)
      const agentId = header(IDENTITY_HEADERS.agent)
      const conversationId = header(IDENTITY_HEADERS.conversation)
      // A resposta de erro da API passa por aqui: a mensagem fica para o registro (a de sucesso, não).
      let failure: string | undefined
      const json = res.json.bind(res)
      res.json = (body: unknown) => {
        if (res.statusCode >= 400) failure = errorOf(body)
        return json(body)
      }
      res.on('finish', () => {
        const email = EMAIL_ROUTES.has(routePath) && typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 200) : undefined
        const target = Object.fromEntries(Object.entries(req.params ?? {}).map(([key, value]) => [key, String(value).slice(0, 200)]))
        this.deps.repository.append({
          at: new Date(started),
          ...(who?.id ? { actorId: who.id } : {}),
          ...(who?.email ? { actorEmail: who.email } : {}),
          ...(agentId ? { agentId } : {}),
          ...(conversationId ? { conversationId } : {}),
          action,
          ...(Object.keys(target).length ? { target } : {}),
          status: typeof res.locals[AUDIT_STATUS_LOCAL] === 'number' ? (res.locals[AUDIT_STATUS_LOCAL] as number) : res.statusCode,
          durationMs: Date.now() - started,
          ip: clientIp(req),
          ...(email ? { detail: email } : {}),
          ...(() => {
            const streamed = typeof res.locals[AUDIT_ERROR_LOCAL] === 'string' ? (res.locals[AUDIT_ERROR_LOCAL] as string).slice(0, ERROR_MAX) : undefined
            const error = streamed ?? failure
            return error ? { error } : {}
          })(),
        })
      })
      next()
    }
  }

  /** Os eventos, do mais novo para o mais antigo, com o cursor da próxima página. Só quem administra o gateway. */
  async list(req: Request, res: Response) {
    try {
      const access = await checkAdminAccess(this.deps.proof)
      if (!access.allowed) throw new HttpError(404, 'not_found', 'Not found')
      const query = req.query as Record<string, unknown>
      const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined)
      const date = (value: unknown) => {
        const parsed = typeof value === 'string' && value ? new Date(value) : undefined
        return parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined
      }
      const number = (value: unknown) => {
        const parsed = Number.parseInt(String(value ?? ''), 10)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
      }
      const limit = Math.min(number(query.limit) ?? 50, AUDIT_PAGE_MAX)
      const filter: IAuditQuery = {
        since: date(query.since),
        until: date(query.until),
        actor: text(query.actor),
        action: text(query.action),
        failed: query.failed === '1' || query.failed === 'true',
        before: number(query.before),
        offset: number(query.offset),
        limit,
      }
      const events = this.deps.repository.query(filter)
      // `total`: quantos o recorte tem (a tela pagina por `offset`); `next`: o cursor, para quem pagina por `before`.
      const total = this.deps.repository.count?.(filter)
      res.status(200).json(ok({ events, ...(total !== undefined ? { total } : {}), next: events.length === limit ? events[events.length - 1]?.id : undefined }))
    } catch (error) {
      const failure = toHttpFailure(error)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}
