import { Request, Response } from 'express'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IDENTITY_HEADERS } from '@domain/Agent.Identity'
import { TURN_GRANT_LOCAL } from './Security.Middleware'
import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'
import { ISelfReply, TSelfApi } from './Self.Api'
import { AGENT_PATCH_FIELDS } from '@domain/AgentPatch.Policy'

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

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** ⚖️ Quem grava `save_agent` por agente diz o porquê ao pedido (a pessoa que aprova lê). */
const SAVE_REASON = 'Gravado por um agente (save_agent): o que amplia acesso espera a confirmação de uma pessoa na tela.'

/**
 * ⛔ `save_agent` CHAMADO POR UM AGENTE NÃO AMPLIA ACESSO. `PUT/POST /agents` grava na hora; um agente injetado trocaria
 * ferramentas, `adminOnly`, permissões, delegação e sandbox de qualquer agente do projeto (o dele inclusive). Aqui a
 * escrita passa pelo `PATCH /agents/:id` (o `patch_agent`), que decide "amplia" pelo detector do catálogo: o que amplia
 * vira pedido pendente e o resto grava já.
 *  - Agente que existe: só os campos ENVIADOS vão no patch (o que o `PUT` apagaria por omissão, como `adminOnly`, ficaria
 *    aberto — aqui fica como está).
 *  - Agente novo: nasce no MÍNIMO (sem ferramentas, só admin, sandbox fechado, sem permissões, terminal, env nem grupo de
 *    modelos) e o corpo inteiro segue como patch: tudo o que passa do mínimo é pedido pendente, que a pessoa aprova na
 *    tela. Se o patch for recusado (corpo inválido), o recém-criado é apagado: não sobra agente pela metade.
 */
async function saveAgentWithoutWidening(api: TSelfApi, method: 'POST' | 'PUT', path: string, body: Record<string, unknown>): Promise<ISelfReply> {
  const patch = Object.fromEntries(AGENT_PATCH_FIELDS.filter((field) => field in body).map((field) => [field, body[field]]))
  const asked = (id: string) => api('PATCH', `/agents/${encodeURIComponent(id)}`, { body: { patch, reason: SAVE_REASON } })
  if (method === 'PUT') {
    const id = segment(path, 1)
    if (!Object.keys(patch).length) return api('GET', `/agents/${encodeURIComponent(id)}`)
    const patched = await asked(id)
    if (!patched.ok) return patched
    const now = await api('GET', `/agents/${encodeURIComponent(id)}`)
    return { ...now, result: { ...(isObject(now.result) ? now.result : {}), ...withPending(patched.result) } }
  }

  const id = typeof body.id === 'string' ? body.id : ''
  const providers = Array.isArray(body.providers)
    ? body.providers.map((target) => (isObject(target) ? Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'sandbox' && key !== 'network')) : target))
    : body.providers
  const minimum: Record<string, unknown> = { ...body, providers, allowedTools: [], adminOnly: true }
  for (const field of ['permissions', 'terminal', 'env', 'modelGroup']) delete minimum[field]
  const created = await api('POST', '/agents', { body: minimum })
  if (!created.ok) return created
  const patched = await asked(id)
  if (!patched.ok) {
    await api('DELETE', `/agents/${encodeURIComponent(id)}`)
    return patched
  }
  return { ...created, result: { ...(isObject(created.result) ? created.result : {}), ...withPending(patched.result) } }
}

/** Do resultado do patch, só o que o chamador precisa ver: o que ficou pendente e o aviso (pendente ≠ liberado). */
function withPending(result: unknown): Record<string, unknown> {
  if (!isObject(result)) return {}
  return { ...(result.pending ? { pending: result.pending } : {}), ...(result.pending && typeof result.notice === 'string' ? { notice: result.notice } : {}) }
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
    const detail = found.result as { projectId?: string; sharedWith?: string[] } | undefined
    return { projectId: detail?.projectId ?? null, sharedWith: detail?.sharedWith ?? [] }
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
          // Um agente de OUTRO projeto só abre conversa aqui se foi compartilhado com o projeto desta conversa.
          if (found.projectId && found.projectId !== scope.projectId && !(scope.projectId && found.sharedWith.includes(scope.projectId))) return outside(found.projectId)
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
        // Pedidos de regra (a pessoa aprova na tela): valem para o agente da conversa e seguem como estavam.
        if (clean.endsWith('/permission-rules')) return undefined
        // ⛔ O `PATCH` (patch_agent, e o save_agent de agente) grava NA HORA o que não amplia: o agente alvo tem de ser do
        // projeto da conversa, como no PUT.
        if (clean === '/agents') return inScope(bodyProject(body))
        // ⛔ Compartilhar mexe em OUTRO projeto (o que recebe): o agente não compartilha agentes (nem o próprio).
        if (method === 'PUT' && /^\/agents\/[^/]+\/shares\/?$/.test(clean)) return refuse('An agent conversation cannot share agents with other projects')
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
      // ⛔ Configuração do sistema (sequências de modelos): nem o agente do Atlas (admin sem projeto) grava — é da pessoa.
      case 'settings':
        return refuse('An agent conversation cannot change the gateway settings')
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
    // O agente criado pelo agente nasce no projeto da conversa dele (o prompt diz que o que se cria pertence ao projeto).
    let body = options?.body
    if (method === 'POST' && clean === '/agents' && isObject(body) && !('projectId' in body) && scope.projectId) body = { ...body, projectId: scope.projectId }
    const denied = await check(method, path, body)
    if (denied) return denied
    const saving = clean === '/agents' ? method === 'POST' : method === 'PUT' && root === 'agents' && clean.split('/').filter(Boolean).length === 2
    if (saving && isObject(body)) return saveAgentWithoutWidening(api, method as 'POST' | 'PUT', clean, body)
    return api(method, path, { ...options, ...(body === options?.body ? {} : { body }) })
  }
}
