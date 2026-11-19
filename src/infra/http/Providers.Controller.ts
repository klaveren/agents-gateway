import { ModelCatalogService } from '@application/ModelCatalog.Service'
import { ProvidersService } from '@application/Providers.Service'
import { ICatalogModel } from '@domain/models/ModelCatalog.Model'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IProviderConfig } from '@domain/models/Provider.Model'
import { IAgentDirectory } from '@domain/ports/AgentRepository.Port'
import { ICredentialStore } from '@domain/ports/CredentialStore.Port'
import { listModels } from '@infra/providers/Model.Listing'
import { probeKey } from '@infra/providers/Provider.Probe'
import { listSubscriptionModels, probeSubscription, SubscriptionLogins } from '@infra/providers/Subscription.Client'
import { isSubscription } from '@domain/Subscription.Policy'
import { protocolCatalog } from '@domain/Protocol.Catalog'
import { Request, Response } from 'express'
import { z } from 'zod'
import { checkAdminAccess } from './Caller.Admin'
import { administers, adminView, IAdminView, requireAnyAdmin, requireProjectAdmin } from './Project.Access'
import { viaAccessToken } from './Auth.Controller'
import { viaSessionCookie } from './Session.Cookie'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface IProvidersControllerDeps {
  providers: ProvidersService
  credentials: ICredentialStore
  agents: IAgentDirectory
  proof?: ICallerProof
  /** O catálogo de modelos de cada provider. Ausente = as rotas de modelos respondem 404. */
  models?: ModelCatalogService
  /** ⚖️ Tira das sequências de modelos os passos que deixaram de servir (ver `ModelGroupRetirement`). Chamada depois de cada mudança do catálogo ou do provider. */
  retire?: (by: string) => Promise<unknown>
  /** Injetáveis para o teste não sair para a rede. */
  probe?: typeof probeKey
  list?: typeof listModels
  /** As assinaturas: teste, listagem e login pelos clientes oficiais (ver `Subscription.Client`). */
  subscriptionProbe?: typeof probeSubscription
  subscriptionList?: typeof listSubscriptionModels
  logins?: SubscriptionLogins
}

/** Uma chave de API: texto sem espaço, com teto — ninguém cola um arquivo inteiro aqui. */
const key = z.string().trim().min(8).max(500).regex(/^\S+$/, 'no spaces')
const keySchema = z.object({ key })
const testSchema = z.object({ key: key.optional() })
const loginCodeSchema = z.object({ code: z.string().trim().min(4).max(2000).regex(/^\S+$/, 'no spaces') })
const createSchema = z.object({
  id: z.string().trim().max(32),
  name: z.string().max(200),
  protocol: z.enum([EProvider.OPENAI, EProvider.CLAUDE]),
  baseUrl: z.string().trim().max(500),
  key: key.optional(),
})
const price = z.number().min(0).max(10_000)
const addModelSchema = z.object({ modelId: z.string().trim().min(1).max(200) })
const modelChangeSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  enabled: z.boolean().optional(),
  /** `null` apaga o preço manual e volta ao do catálogo ou de fábrica. */
  price: z.object({ input: price, output: price, cacheRead: price.optional(), cacheWrite: price.optional() }).nullable().optional(),
})
/** 🔐 O provider de um projeto: só os tipos conhecidos (ver `PROJECT_PROVIDER_KINDS`). */
const projectProviderSchema = z.object({
  kind: z.enum(['anthropic', 'openai', 'google', 'openrouter']),
  name: z.string().max(60).optional(),
  key: key.optional(),
})
const updateSchema = z.object({ name: z.string().max(200).optional(), baseUrl: z.string().trim().max(500).optional(), enabled: z.boolean().optional() })

/**
 * A seção Providers: os oficiais e os compatíveis (OpenRouter, vLLM, LiteLLM…), com a chave de cada um.
 *
 * ⛔ SÓ ADMINISTRADOR, 404 para os demais (a mesma porta de `/settings`). ⛔ A CHAVE SÓ ENTRA: nenhuma
 * resposta daqui a devolve; o status mostra a origem e os quatro últimos caracteres.
 */
export class ProvidersController {
  constructor(private readonly deps: IProvidersControllerDeps) {
    for (const name of [
      'list',
      'create',
      'update',
      'remove',
      'saveKey',
      'clearKey',
      'test',
      'listModels',
      'syncModels',
      'updateModel',
      'loginStatus',
      'loginStart',
      'loginCode',
      'loginCancel',
      'addModel',
      'protocols',
      'createForProject',
    ] as const)
      this[name] = this[name].bind(this)
  }

  /**
   * Os protocolos e o que a tela precisa de cada um (lanes, níveis, assinatura, rótulo, console).
   * Para qualquer chamador autenticado: é metadado das regras, sem nada de configuração ou chave.
   */
  async protocols(_req: Request, res: Response) {
    await this.respond(res, async () => protocolCatalog())
  }

  async list(_req: Request, res: Response) {
    await this.respond(res, async () => {
      // ⚖️ Quem administra um projeto também lê (o formulário do agente escolhe provider e modelo); os agentes que
      // aparecem são só os dos projetos dele. Gravar segue do administrador do gateway.
      const view = await requireAnyAdmin(this.deps.proof, 'listProviders')
      // 🔐 O provider de um projeto só aparece para quem administra o projeto (e o gateway).
      return this.deps.providers
        .list()
        .filter((provider) => !provider.projectId || view.gateway || administers(view, provider.projectId))
        .map((provider) => this.view(provider, view))
    })
  }

  /** Cria um compatível — e, se veio, já salva a chave dele. */
  async create(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('createProvider')
        const body = parseBody(createSchema, req.body)

        const provider = this.deps.providers.create(body, admin)
        if (body.key) this.deps.credentials.save(provider.id, body.key, admin)
        return this.view(provider, await adminView(this.deps.proof))
      },
      { status: 201, message: 'Provider created' },
    )
  }

  async update(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireProviderAdmin(req, 'updateProvider')
        const body = parseBody(updateSchema, req.body)
        const updated = this.deps.providers.update(this.idOf(req), body, admin)
        if (body.enabled === false) await this.deps.retire?.(admin)
        return this.view(updated, await adminView(this.deps.proof))
      },
      { message: 'Provider updated' },
    )
  }

  /** Apaga um compatível e a chave dele. Oficial: 422. Usado por algum agente: 409, com quais. */
  async remove(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireProviderAdmin(req, 'removeProvider')
        const id = this.idOf(req)
        this.deps.providers.remove(id, (providerId) =>
          this.deps.agents
            .list()
            .filter((agent) => agent.providers.some((target) => target.provider === providerId))
            .map((agent) => agent.name),
        )
        // Desliga, não apaga: as conversas antigas com esse provider continuam com preço.
        this.deps.models?.disableAll(id, admin)
        await this.deps.retire?.(admin)
        return null
      },
      { message: 'Provider removed' },
    )
  }

  async saveKey(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireProviderAdmin(req, 'saveProviderKey')
        const id = this.idOf(req)
        // ⛔ A chave de um provider do PROJETO só entra pela tela, como as variáveis secretas: nem token nem agente.
        if (this.deps.providers.get(id)?.projectId && !(viaSessionCookie(res) && !viaAccessToken(res)))
          throw new HttpError(403, 'forbidden', 'Só quem administra o projeto, entrando pela tela, grava a chave do provider dele.')
        this.deps.credentials.save(id, parseBody(keySchema, req.body).key, admin)
        return this.view(this.deps.providers.get(id) as IProviderConfig, await adminView(this.deps.proof))
      },
      { message: 'Key saved' },
    )
  }

  /** Remove a chave salva: volta a valer a do `.env`, se houver (só nos oficiais). */
  async clearKey(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        await this.requireProviderAdmin(req, 'clearProviderKey')
        const id = this.idOf(req)
        this.deps.credentials.clear(id)
        return this.view(this.deps.providers.get(id) as IProviderConfig, await adminView(this.deps.proof))
      },
      { message: 'Key removed' },
    )
  }

  /** Testa a chave colada (antes de salvar) ou, sem corpo, a que está em vigor — na URL do provider. */
  async test(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireProviderAdmin(req, 'testProviderKey')
      const provider = this.deps.providers.get(this.idOf(req)) as IProviderConfig
      const { key: pasted } = parseBody(testSchema, req.body ?? {})

      // Assinatura: um turno mínimo pelo cliente oficial. A "chave" do Claude é o token OAuth, opcional.
      if (isSubscription(provider.protocol)) return (this.deps.subscriptionProbe ?? probeSubscription)(provider.protocol, pasted ?? this.deps.credentials.get(provider.id))

      const candidate = pasted ?? this.deps.credentials.get(provider.id)
      if (!candidate) return { ok: false, message: 'Nenhuma chave para testar.' }

      return (this.deps.probe ?? probeKey)(provider, candidate)
    })
  }

  /** O catálogo de um provider: tudo o que ele lista, ativado ou não, com o preço e de onde ele veio. */
  async listModels(req: Request, res: Response) {
    await this.respond(res, async () => {
      const view = await requireAnyAdmin(this.deps.proof, 'listModels')
      const provider = this.deps.providers.get(this.idOf(req))
      if (provider?.projectId && !view.gateway && !administers(view, provider.projectId)) throw new HttpError(404, 'not_found', 'Not found')
      return this.catalog.list(this.idOf(req)).map(toModelDto)
    })
  }

  /**
   * Busca a listagem do provider e mescla no catálogo (ver `ModelCatalogService.sync`): novos entram
   * desligados, ativação e preço manual ficam, o que sumiu é marcado.
   */
  async syncModels(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireProviderAdmin(req, 'syncModels')
        const provider = this.deps.providers.get(this.idOf(req)) as IProviderConfig
        if (isSubscription(provider.protocol)) {
          let listed
          try {
            listed = await (this.deps.subscriptionList ?? listSubscriptionModels)(provider.protocol)
          } catch (error: unknown) {
            throw new HttpError(502, 'upstream_error', error instanceof Error ? error.message : String(error))
          }
          const result = this.catalog.sync(provider.id, listed, admin)
          await this.deps.retire?.(admin)
          return { ...result, models: this.catalog.list(provider.id).map(toModelDto) }
        }
        const key = this.deps.credentials.get(provider.id)
        if (!key) throw new HttpError(422, 'validation_error', 'Salve uma chave antes de atualizar a lista de modelos.')

        let listed
        try {
          listed = await (this.deps.list ?? listModels)(provider, key)
        } catch (error: unknown) {
          throw new HttpError(502, 'upstream_error', error instanceof Error ? error.message : String(error))
        }

        const result = this.catalog.sync(provider.id, listed, admin)
        await this.deps.retire?.(admin)
        return { ...result, models: this.catalog.list(provider.id).map(toModelDto) }
      },
      { message: 'Models synced' },
    )
  }

  /** Acrescenta um modelo por id (provider sem listagem, ou modelo que a listagem não traz). Nasce desligado. */
  async addModel(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireProviderAdmin(req, 'addModel')
        const id = this.idOf(req)
        const { modelId } = parseBody(addModelSchema, req.body)
        return toModelDto(this.catalog.addModel(id, modelId, admin))
      },
      { status: 201, message: 'Model added' },
    )
  }

  /** Liga/desliga um modelo e/ou define o preço manual. O id vai no corpo: id de modelo pode ter `/`. */
  async updateModel(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireProviderAdmin(req, 'updateModel')
        const id = this.idOf(req)
        const body = parseBody(modelChangeSchema, req.body)

        let model: ICatalogModel | undefined
        if (body.enabled !== undefined) model = this.catalog.setEnabled(id, body.modelId, body.enabled, admin)
        if (body.price !== undefined) model = this.catalog.setPrice(id, body.modelId, body.price, admin)
        if (!model) throw new HttpError(422, 'validation_error', 'Nothing to change: send enabled and/or price.')
        if (body.enabled === false) await this.deps.retire?.(admin)

        return toModelDto(model)
      },
      { message: 'Model updated' },
    )
  }

  /** O login de uma assinatura em andamento: link, código de dispositivo e estado. */
  async loginStatus(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('subscriptionLogin')
      return this.logins.view(this.subscriptionOf(req))
    })
  }

  /** Começa o login oficial do cliente (num HOME só do gateway) e devolve o link para abrir. */
  async loginStart(req: Request, res: Response) {
    await this.respond(res, async () => {
      const admin = await this.requireAdmin('subscriptionLogin')
      const protocol = this.subscriptionOf(req)
      const provider = this.deps.providers.get(this.idOf(req)) as IProviderConfig
      // O login do Claude termina num token: ele vai direto para o cofre, como a "chave" deste provider.
      return this.logins.start(protocol, { onToken: (token) => this.deps.credentials.save(provider.id, token, admin) })
    })
  }

  /** O código que a página de login devolveu, colado na tela. */
  async loginCode(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('subscriptionLogin')
      return this.logins.submit(this.subscriptionOf(req), parseBody(loginCodeSchema, req.body).code)
    })
  }

  async loginCancel(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('subscriptionLogin')
      const protocol = this.subscriptionOf(req)
      this.logins.cancel(protocol)
      return this.logins.view(protocol)
    })
  }

  private subscriptionOf(req: Request): EProvider {
    const provider = this.deps.providers.get(this.idOf(req)) as IProviderConfig
    if (provider.protocol !== EProvider.CODEX && provider.protocol !== EProvider.ANTIGRAVITY && provider.protocol !== EProvider.CLAUDE_SUB)
      throw new HttpError(422, 'validation_error', 'Este provider não tem login pela tela.')
    return provider.protocol
  }

  private get logins(): SubscriptionLogins {
    if (!this.deps.logins) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.logins
  }

  private get catalog(): ModelCatalogService {
    if (!this.deps.models) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.models
  }

  /** O provider como a tela o vê: sem chave nenhuma, com o que ela libera. */
  /** ⛔ Os agentes que usam o provider: só os dos projetos de quem vê (e os globais, para o admin do gateway). */
  private view(provider: IProviderConfig, viewer: IAdminView | undefined) {
    const agents = this.deps.agents
      .list()
      .filter((agent) => agent.providers.some((target) => target.provider === provider.id))
      .filter((agent) => !viewer || administers(viewer, agent.projectId))
    const [credential] = this.deps.credentials.status([provider.id])

    return {
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      official: provider.official,
      subscription: isSubscription(provider.protocol),
      enabled: provider.enabled,
      ...(provider.projectId ? { projectId: provider.projectId } : {}),
      updatedAt: provider.updatedAt,
      updatedBy: provider.updatedBy,
      credential,
      models: [...new Set(agents.flatMap((agent) => agent.providers.filter((target) => target.provider === provider.id).flatMap((target) => target.models)))],
      catalog: this.deps.models ? { total: this.deps.models.list(provider.id).length, enabled: this.deps.models.enabledIds(provider.id).length } : undefined,
      agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
    }
  }

  private idOf(req: Request): string {
    const id = req.params.id as string
    if (!this.deps.providers.get(id)) throw new HttpError(404, 'not_found', 'Not found')
    return id
  }

  /**
   * 🔐 Quem mexe no provider: o do gateway, o administrador do gateway; o de um PROJETO, quem administra o projeto (e o
   * administrador do gateway). Devolve quem grava.
   */
  private async requireProviderAdmin(req: Request, operation: string): Promise<string> {
    const provider = this.deps.providers.get(this.idOf(req))
    if (!provider?.projectId) return this.requireAdmin(operation)
    const view = await adminView(this.deps.proof)
    if (!view || !(view.gateway || administers(view, provider.projectId))) {
      console.warn(`[admin] acesso negado a ${operation}: não administra o projeto ${provider.projectId}`)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return view.by
  }

  /**
   * `POST /projects/:id/providers { kind, name?, key? }` — 🔐 um provider do projeto (Anthropic, OpenAI ou OpenRouter, URL
   * fixa). Quem administra o projeto; a chave, só pela tela.
   */
  async createForProject(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const projectId = req.params.id as string
        const by = await requireProjectAdmin(this.deps.proof, projectId, 'createProjectProvider')
        const body = parseBody(projectProviderSchema, req.body)
        if (body.key && !(viaSessionCookie(res) && !viaAccessToken(res)))
          throw new HttpError(403, 'forbidden', 'Só quem administra o projeto, entrando pela tela, grava a chave do provider dele.')
        const provider = this.deps.providers.createForProject(projectId, body.kind, body.name, by)
        if (body.key) this.deps.credentials.save(provider.id, body.key, by)
        return this.view(provider, await adminView(this.deps.proof))
      },
      { status: 201, message: 'Provider created' },
    )
  }

  private async requireAdmin(operation: string): Promise<string> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed || !access.identity?.id) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return access.identity.email ?? access.identity.id
  }

  private async respond<T>(res: Response, work: () => Promise<T>, options: { status?: number; message?: string } = {}) {
    try {
      res.status(options.status ?? 200).json(ok(await work(), options.message))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[ProvidersController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

function toModelDto(model: ICatalogModel) {
  return {
    modelId: model.modelId,
    label: model.label,
    enabled: model.enabled,
    available: model.available,
    contextLength: model.contextLength,
    price: model.price,
    priceSource: model.priceSource,
    reasoning: model.reasoning,
    syncedAt: model.syncedAt,
    updatedAt: model.updatedAt,
    updatedBy: model.updatedBy,
  }
}
