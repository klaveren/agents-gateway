import { Request, Response } from 'express'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IDENTITY_HEADERS } from '@domain/Agent.Identity'
import { TURN_GRANT_LOCAL } from './Security.Middleware'
import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'
import { ISelfReply, TSelfApi } from './Self.Api'

/**
 * Onde um AGENTE pode escrever pelo MCP do gateway: o projeto da conversa dele (`projectId`), e nada mais. `unrestricted` =
 * administrador do gateway numa conversa SEM projeto (o Atlas): escreve onde a conta dele escreve.
 */
export interface IAgentWriteScope {
  projectId?: string
  unrestricted: boolean
}

/**
 * ⛔ QUEM CHAMA É UM AGENTE? Pela concessão do turno (`Grant.Credential`: o contexto vem do servidor, o agente não o altera) ou,
 * sem ela, pelos cabeçalhos de identidade que o gateway põe nas conexões de dentro do processo (agente/conversa/projeto).
 * `undefined` = uma pessoa ou integração de fora (Claude Code, Desktop): escreve com a conta inteira, como sempre.
 */
export function agentScopeOf(req: Pick<Request, 'headers'>, res: Pick<Response, 'locals'>, gateway: boolean): IAgentWriteScope | undefined {
  const grant = res.locals[TURN_GRANT_LOCAL] as IExecutionContext | undefined
  if (grant) {
    const projectId = grant.conversationProjectId ?? grant.projectId
    return { ...(projectId ? { projectId } : {}), unrestricted: gateway && !projectId }
  }
  const header = (name: string) => {
    const value = req.headers[name]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  if (!header(IDENTITY_HEADERS.agent) && !header(IDENTITY_HEADERS.conversation) && !header(IDENTITY_HEADERS.project)) return undefined
  const projectId = header(IDENTITY_HEADERS.project)
  return { ...(projectId ? { projectId } : {}), unrestricted: gateway && !projectId }
}

const segment = (path: string, index: number) => decodeURIComponent(path.split('?')[0].split('/')[index + 1] ?? '')

/** O `projectId` de um corpo: `undefined` = ausente; `null` = global; texto = o projeto. */
function bodyProject(body: unknown, key = 'projectId'): string | null | undefined {
  if (!body || typeof body !== 'object' || !(key in body)) return undefined
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : null
}

/**
 * ⛔ A API do MCP do gateway CHAMADA POR UM AGENTE: leituras passam como estão (cada rota confere a conta); toda ESCRITA confere
 * que o alvo é o projeto da conversa. Sem isto, uma injeção numa conversa do projeto P gravava agente, regra ou recurso em
 * Q, que a pessoa também administra — a conta é uma só e o MCP agia com ela inteira. O que não se sabe classificar é recusado.
 */
export function scopedWrites(api: TSelfApi, scope: IAgentWriteScope): TSelfApi {
  const refuse = (message: string): ISelfReply => ({ ok: false, status: 403, code: 'forbidden', message })
  const outside = (target: string | null | undefined) =>
    scope.unrestricted
      ? undefined
      : refuse(
          target
            ? `This conversation can only change its own project${scope.projectId ? ` (${scope.projectId})` : ''}, not "${target}"`
            : 'This conversation can only change its own project: global items are changed from a conversation outside any project',
        )
  const inScope = (target: string | null | undefined) =>
    scope.unrestricted || (target !== undefined && target !== null && target === scope.projectId) ? undefined : outside(target)

  /** O item existe no escopo da conversa? (a lista do projeto traz só os dele) */
  const existsIn = async (collection: 'rules' | 'docs' | 'resources', id: string) => {
    if (scope.unrestricted) return undefined
    if (!scope.projectId) return outside(null)
    const listed = await api('GET', `/${collection}`, { query: { project: scope.projectId } })
    const found = Array.isArray(listed.result) && (listed.result as Array<{ id?: string; projectId?: string }>).some((item) => item.id === id && item.projectId === scope.projectId)
    return found ? undefined : refuse(`"${id}" is not in this conversation project`)
  }

  const agentProject = async (agentId: string) => {
    const found = await api('GET', `/agents/${encodeURIComponent(agentId)}`)
    if (!found.ok) return { reply: found as ISelfReply }
    const projectId = (found.result as { projectId?: string } | undefined)?.projectId
    return { projectId: projectId ?? null }
  }

  const check = async (method: string, path: string, body: unknown): Promise<ISelfReply | undefined> => {
    const clean = path.split('?')[0]
    const [root] = clean.split('/').filter(Boolean)
    const id = segment(clean, 1)

    switch (root) {
      // Conversas e pedidos da própria conversa: a dona é conferida pela rota.
      case 'sessions': {
        if (method !== 'POST' || clean !== '/sessions') return undefined
        const project = bodyProject(body)
        if (project !== undefined && project !== null && !scope.unrestricted && project !== scope.projectId) return outside(project)
        const agentId = (body as { agentId?: string } | undefined)?.agentId
        if (agentId && !scope.unrestricted) {
          const found = await agentProject(agentId)
          if (found.reply) return found.reply
          if (found.projectId && found.projectId !== scope.projectId) return outside(found.projectId)
        }
        return undefined
      }
      case 'secret-requests':
        return undefined
      case 'projects': {
        if (clean === '/projects') return scope.unrestricted ? undefined : refuse('Only an administrator in a conversation outside any project creates projects')
        return inScope(id)
      }
      case 'agents': {
        // Pedidos de mudança (a pessoa aprova na tela): valem para o agente da conversa e seguem como estavam.
        if (method === 'PATCH' || clean.endsWith('/permission-rules')) return undefined
        if (clean === '/agents') return inScope(bodyProject(body))
        const owner = await agentProject(id)
        if (owner.reply) return owner.reply
        const denied = inScope(owner.projectId)
        if (denied) return denied
        const moved = bodyProject(body)
        return moved === undefined ? undefined : inScope(moved)
      }
      case 'rules':
      case 'docs':
      case 'resources': {
        // ⛔ Compartilhar mexe em OUTRO projeto (o que recebe): o agente não compartilha. A pessoa, direto pelo MCP, passa
        // pela regra da rota (admin da origem e de cada destino novo).
        if (method === 'PUT' && root !== 'rules' && /^\/[^/]+\/[^/]+\/shares\/?$/.test(clean)) return refuse('An agent conversation cannot share items with other projects')
        if (clean === `/${root}`) return inScope(bodyProject(body))
        const missing = await existsIn(root, id)
        if (missing) return missing
        const moved = bodyProject(body)
        return moved === undefined ? undefined : inScope(moved)
      }
      case 'catalog': {
        if (clean !== '/catalog/history/restore') return refuse('Not available to an agent conversation')
        return inScope(bodyProject(body, 'project'))
      }
      default:
        // Provedores, modelos, pacotes e o resto: do gateway, não de uma conversa de projeto.
        return scope.unrestricted ? undefined : refuse('Not available to an agent conversation in a project')
    }
  }

  /** O projeto de uma conversa: o gravado nela, senão o do agente; `null` = sem projeto. */
  const sessionProject = async (reply: ISelfReply): Promise<string | null> => {
    const session = (reply.result ?? {}) as { agentId?: string; metadata?: Record<string, unknown> }
    const stored = session.metadata?.[PROJECT_METADATA_KEY]
    if (typeof stored === 'string' && stored) return stored
    if (!session.agentId) return null
    return (await agentProject(session.agentId)).projectId ?? null
  }
  const sameProject = (project: string | null) => (project ?? undefined) === scope.projectId
  const known = new Set<string>()

  /**
   * ⛔ Conversa alvo (ler, mandar mensagem, reconfigurar) tem de ser do MESMO projeto da conversa de origem — ler também. A
   * rota só confere o dono, e a conta é uma só: sem isto, a injeção em P escrevia (e lia) em Q. Sem projeto só casa com sem
   * projeto, e o que não se consegue ler é recusado (falha fechada).
   */
  const sameProjectSession = async (id: string): Promise<ISelfReply | undefined> => {
    if (known.has(id)) return undefined
    // A viva (`/sessions`); a que já acabou só está no histórico (`/conversations/:id/turns`, que traz a conversa no corpo).
    let found = await api('GET', `/sessions/${encodeURIComponent(id)}`)
    if (!found.ok) {
      const stored = await api('GET', `/conversations/${encodeURIComponent(id)}/turns`)
      if (!stored.ok) return found
      found = { ...stored, result: (stored.result as { conversation?: unknown } | undefined)?.conversation }
    }
    if (!sameProject(await sessionProject(found))) return refuse('This conversation can only reach conversations of its own project')
    known.add(id)
    return undefined
  }

  return async (method, path, options) => {
    const clean = path.split('?')[0]
    const [root] = clean.split('/').filter(Boolean)
    const id = root === 'sessions' || (root === 'conversations' && !['stats', 'events'].includes(segment(clean, 1))) ? segment(clean, 1) : ''
    if (id) {
      const denied = await sameProjectSession(id)
      if (denied) return denied
    }
    if (method === 'GET') {
      // ⛔ O monitor (`scope=all`) de um agente já sai recortado no projeto da origem, para a página não vir vazia do filtro abaixo.
      const pinned =
        root === 'conversations' && !id && scope.projectId && options?.query?.scope === 'all' ? { ...options, query: { ...options.query, project: scope.projectId } } : options
      const answer = await api(method, path, pinned)
      // A lista de conversas mostra só as do projeto da origem.
      const listed = (answer.result as { sessions?: unknown } | undefined)?.sessions
      if (root === 'conversations' && !id && answer.ok && Array.isArray(listed)) {
        const kept: unknown[] = []
        for (const item of listed as Array<{ metadata?: Record<string, unknown>; agentId?: string }>)
          if (sameProject(await sessionProject({ ok: true, status: 200, result: item }))) kept.push(item)
        return { ...answer, result: { ...(answer.result as object), sessions: kept } }
      }
      return answer
    }
    return (await check(method, path, options?.body)) ?? api(method, path, options)
  }
}
