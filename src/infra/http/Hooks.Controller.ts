import { createHmac, timingSafeEqual } from 'node:crypto'
import { Request, Response } from 'express'
import { z } from 'zod'
import { AgentHooksService } from '@application/AgentHooks.Service'
import { IAgentHook } from '@domain/models/AgentHook.Model'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'
import { selfApi, selfBase, TSelfApi } from './Self.Api'
import { openConversation as openSelfConversation, runTurn, SelfCallError } from './Self.Run'

export interface IHooksControllerDeps {
  hooks: AgentHooksService
  /** Uma sessão curta da conta, se ela ainda está ativa — é em nome dela que o hook roda. */
  sessionFor: (userId: string) => { token: string } | undefined
  proof?: ICallerProof
}

export const HOOK_PATH = '/hook/:agentId/:hookName'
/** O corpo do evento que vai na mensagem do turno: o resto é cortado, com aviso. */
const BODY_IN_PROMPT = 100_000
/** Headers que nunca vão para o agente: credenciais e o que o proxy põe. */
const HIDDEN_HEADERS = /^(authorization|cookie|x-hook-key|x-tool-authorization|x-forwarded-.*|x-real-ip)$/i

const hookFields = {
  prompt: z.string(),
  enabled: z.boolean().optional(),
  verify: z.enum(['key', 'hmac']).optional(),
  signatureHeader: z.string().max(64).optional(),
  signaturePrefix: z.string().max(32).optional(),
  signatureEncoding: z.enum(['hex', 'base64']).optional(),
  session: z.enum(['new', 'continuous']).optional(),
}
const createSchema = z.object({ name: z.string().max(64), ...hookFields })
const updateSchema = z.object({ ...hookFields, prompt: hookFields.prompt.optional() })

/**
 * Os hooks dos agentes: `POST /v1/hook/<agente>/<hook>` (público — a chave do hook é a credencial) e o cadastro
 * deles (só admin, 404 para os demais, como `/mcp-servers`).
 *
 * ⚖️ O EVENTO VIRA UMA CONVERSA PELA PRÓPRIA API, com uma sessão curta da conta que criou o hook: valem as
 * mesmas regras de quem abre a conversa pela tela (agente só para admin, audiência, teto de conversas, MCP
 * `caller`), e a conversa aparece na caixa de entrada dessa conta. Nada aqui reimplementa essas regras.
 */
export class HooksController {
  /** ⛔ Hook `continuous`: um turno por vez na mesma conversa (o gateway recusa dois ao mesmo tempo). */
  private readonly turns = new Map<string, Promise<unknown>>()
  /** E a conversa nasce uma vez só, mesmo com duas chamadas chegando juntas. */
  private readonly opening = new Map<string, Promise<string>>()

  constructor(private readonly deps: IHooksControllerDeps) {
    for (const name of ['receive', 'list', 'create', 'update', 'remove', 'rotate', 'deliveries'] as const) this[name] = this[name].bind(this)
  }

  async receive(req: Request, res: Response): Promise<void> {
    const deny = (status: number, code: 'not_found' | 'hook_unauthorized' | 'hook_owner_inactive', message: string) => res.status(status).json(fail(message, code))
    const agentId = req.params.agentId as string
    const name = req.params.hookName as string

    const hook = this.deps.hooks.active(agentId, name)
    if (!hook) return void deny(404, 'not_found', 'Not found')
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const secret = this.deps.hooks.secretOf(agentId, name)
    if (!secret || !verified(hook, secret, req, raw))
      return void deny(401, 'hook_unauthorized', hook.verify === 'hmac' ? `Missing or wrong signature in ${hook.signatureHeader}` : 'Missing or wrong hook key')

    const session = this.deps.sessionFor(hook.runAs)
    if (!session) return void deny(409, 'hook_owner_inactive', 'The account this hook runs as is disabled or gone; recreate the hook')

    const base = selfBase(req)
    const credentials = { 'x-tool-authorization': `Bearer ${session.token}` }
    const api = selfApi(base, credentials)
    const delivery = this.deps.hooks.recordDelivery(hook)
    const message = eventMessage(hook, req, raw)
    const key = `${agentId}/${name}`

    try {
      const conversationId = hook.session === 'continuous' ? await this.continuousSession(hook, api) : await openConversation(api, hook)
      this.deps.hooks.finishDelivery(delivery.id, { sessionId: conversationId })
      const queued = hook.session === 'continuous' && this.turns.has(key)

      const run = () =>
        runTurn(base, credentials, conversationId, message).then(
          (error) => this.deps.hooks.finishDelivery(delivery.id, error ? { status: 'error', error } : { status: 'ok' }),
          (error: unknown) => this.deps.hooks.finishDelivery(delivery.id, { status: 'error', error: error instanceof Error ? error.message : String(error) }),
        )
      if (hook.session === 'continuous') {
        const next = (this.turns.get(key) ?? Promise.resolve()).then(run)
        this.turns.set(key, next)
        void next.finally(() => this.turns.get(key) === next && this.turns.delete(key))
      } else void run()

      res.status(202).json(ok({ conversationId, hook: name, queued }, 'Hook accepted'))
    } catch (error: unknown) {
      const failure = error instanceof SelfCallError ? error : undefined
      this.deps.hooks.finishDelivery(delivery.id, { status: 'error', error: failure?.message ?? String(error) })
      res.status(failure?.status ?? 500).json(fail(failure?.message ?? 'Could not open the conversation', (failure?.code as never) ?? 'internal_error'))
    }
  }

  /** A conversa de um hook contínuo: a gravada, se ainda existe; senão uma nova, gravada no hook. */
  private async continuousSession(hook: IAgentHook, api: TSelfApi): Promise<string> {
    const key = `${hook.agentId}/${hook.name}`
    const pending = this.opening.get(key)
    if (pending) return pending
    const work = (async () => {
      const current = this.deps.hooks.get(hook.agentId, hook.name).sessionId
      if (current && (await api('GET', `/sessions/${encodeURIComponent(current)}`)).ok) return current
      const created = await openConversation(api, hook)
      this.deps.hooks.setSession(hook.agentId, hook.name, created)
      return created
    })().finally(() => this.opening.delete(key))
    this.opening.set(key, work)
    return work
  }

  async list(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listHooks')
      const agentId = req.params.agentId as string
      return this.deps.hooks.list(agentId).map((hook) => this.toDto(hook))
    })
  }

  async create(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const caller = await this.requireAdmin('createHook')
        if (!caller.userId) throw new HttpError(422, 'validation_error', 'Sign in with a gateway account to create a hook: it runs as you')
        const created = this.deps.hooks.create(req.params.agentId as string, parseBody(createSchema, req.body), { userId: caller.userId, label: caller.label })
        return { ...this.toDto(created.hook), secret: created.secret }
      },
      { status: 201, message: 'Hook created' },
    )
  }

  async update(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const caller = await this.requireAdmin('updateHook')
      return this.toDto(this.deps.hooks.update(req.params.agentId as string, req.params.hookName as string, parseBody(updateSchema, req.body), caller.label))
    })
  }

  async remove(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('deleteHook')
      this.deps.hooks.remove(req.params.agentId as string, req.params.hookName as string)
      return null
    })
  }

  /** Uma chave nova (a antiga para de valer na hora). ⛔ Devolvida só aqui. */
  async rotate(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const caller = await this.requireAdmin('rotateHook')
      const agentId = req.params.agentId as string
      const name = req.params.hookName as string
      const secret = this.deps.hooks.rotate(agentId, name, caller.label)
      return { ...this.toDto(this.deps.hooks.get(agentId, name)), secret }
    })
  }

  async deliveries(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listHookDeliveries')
      return this.deps.hooks.deliveries(req.params.agentId as string, req.params.hookName as string)
    })
  }

  private toDto(hook: IAgentHook) {
    const last = this.deps.hooks.deliveries(hook.agentId, hook.name)[0]
    return {
      agentId: hook.agentId,
      name: hook.name,
      path: `/v1/hook/${hook.agentId}/${hook.name}`,
      prompt: hook.prompt,
      enabled: hook.enabled,
      verify: hook.verify,
      signatureHeader: hook.signatureHeader,
      signaturePrefix: hook.signaturePrefix,
      signatureEncoding: hook.signatureEncoding,
      session: hook.session,
      ...(hook.sessionId ? { sessionId: hook.sessionId } : {}),
      runAs: hook.runAs,
      secretLast4: this.deps.hooks.secretLast4(hook.agentId, hook.name),
      ...(last ? { lastDelivery: last } : {}),
      createdAt: hook.createdAt,
      updatedAt: hook.updatedAt,
      updatedBy: hook.updatedBy,
    }
  }

  private async requireAdmin(operation: string): Promise<{ userId?: string; label: string }> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return { userId: access.identity?.id, label: access.identity?.email ?? access.identity?.id ?? 'admin' }
  }

  private async respond<T>(res: Response, work: () => Promise<T>, options: { status?: number; message?: string } = {}) {
    try {
      res.status(options.status ?? 200).json(ok(await work(), options.message))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[HooksController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

/** A conversa do hook, aberta pela API em nome da conta: carimbada com o hook, para a caixa de entrada mostrar a origem. */
function openConversation(api: TSelfApi, hook: IAgentHook): Promise<string> {
  return openSelfConversation(api, { agentId: hook.agentId, metadata: { hook: { agentId: hook.agentId, name: hook.name } } })
}

function verified(hook: IAgentHook, secret: string, req: Request, raw: Buffer): boolean {
  if (hook.verify === 'hmac') {
    const header = req.headers[hook.signatureHeader.toLowerCase()]
    const signature = Array.isArray(header) ? header[0] : header
    if (!signature) return false
    const expected = hook.signaturePrefix + createHmac('sha256', secret).update(raw).digest(hook.signatureEncoding)
    return safeEqual(signature.trim(), expected)
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
  const header = req.headers['x-hook-key']
  const given = bearer ?? (Array.isArray(header) ? header[0] : header)
  return !!given && safeEqual(given.trim(), secret)
}

function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** O prompt do hook e o evento: hora, tipo, os headers úteis (sem credencial), a query e o corpo. */
export function eventMessage(hook: IAgentHook, req: Request, raw: Buffer, now = new Date()): string {
  const contentType = String(req.headers['content-type'] ?? '')
  const hidden = (name: string) => HIDDEN_HEADERS.test(name) || name.toLowerCase() === hook.signatureHeader.toLowerCase()
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => (name.startsWith('x-') || name === 'user-agent') && !hidden(name)))
  const query = Object.fromEntries(Object.entries(req.query).filter(([name]) => name !== 'key'))

  let body = raw.toString('utf8')
  if (/json/i.test(contentType)) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      // Corpo que diz ser JSON e não é: vai como veio.
    }
  }
  const cut = body.length > BODY_IN_PROMPT
  if (cut) body = body.slice(0, BODY_IN_PROMPT)

  return [
    hook.prompt,
    '',
    '## Evento recebido',
    `- hook: ${hook.name} · ${now.toISOString()}`,
    ...(contentType ? [`- content-type: ${contentType}`] : []),
    ...(Object.keys(headers).length ? [`- headers: ${JSON.stringify(headers)}`] : []),
    ...(Object.keys(query).length ? [`- query: ${JSON.stringify(query)}`] : []),
    '',
    body ? `\`\`\`${/json/i.test(contentType) ? 'json' : ''}\n${body}\n\`\`\`` : '(corpo vazio)',
    ...(cut ? [`(corpo cortado em ${BODY_IN_PROMPT} caracteres)`] : []),
  ].join('\n')
}
