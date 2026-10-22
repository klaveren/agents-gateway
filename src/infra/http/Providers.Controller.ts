import { ModelCatalogService } from '@application/ModelCatalog.Service'
import { ProvidersService } from '@application/Providers.Service'
import { ICatalogModel } from '@domain/models/ModelCatalog.Model'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IProviderConfig } from '@domain/models/Provider.Model'
import { IAgentDirectory } from '@domain/ports/AgentRepository.Port'
import { ICredentialStore } from '@domain/ports/CredentialStore.Port'
import { listModels } from '@infra/providers/Model.Listing'
import { probeKey } from '@infra/providers/Provider.Probe'
import { Request, Response } from 'express'
import { z } from 'zod'
import { checkAdminAccess } from './Caller.Admin'
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
  /** Injetáveis para o teste não sair para a rede. */
  probe?: typeof probeKey
  list?: typeof listModels
}

/** Uma chave de API: texto sem espaço, com teto — ninguém cola um arquivo inteiro aqui. */
const key = z.string().trim().min(8).max(500).regex(/^\S+$/, 'no spaces')
const keySchema = z.object({ key })
const testSchema = z.object({ key: key.optional() })
const createSchema = z.object({
  id: z.string().trim().max(32),
  name: z.string().max(200),
  protocol: z.enum([EProvider.OPENAI, EProvider.CLAUDE]),
  baseUrl: z.string().trim().max(500),
  key: key.optional(),
})
const price = z.number().min(0).max(10_000)
const modelChangeSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  enabled: z.boolean().optional(),
  /** `null` apaga o preço manual e volta ao do catálogo ou de fábrica. */
  price: z.object({ input: price, output: price, cacheRead: price.optional(), cacheWrite: price.optional() }).nullable().optional(),
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
    for (const name of ['list', 'create', 'update', 'remove', 'saveKey', 'clearKey', 'test', 'listModels', 'syncModels', 'updateModel'] as const) this[name] = this[name].bind(this)
  }

  async list(_req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('listProviders')
      return this.deps.providers.list().map((provider) => this.view(provider))
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
        return this.view(provider)
      },
      { status: 201, message: 'Provider created' },
    )
  }

  async update(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('updateProvider')
        const body = parseBody(updateSchema, req.body)
        return this.view(this.deps.providers.update(this.idOf(req), body, admin))
      },
      { message: 'Provider updated' },
    )
  }

  /** Apaga um compatível e a chave dele. Oficial: 422. Usado por algum agente: 409, com quais. */
  async remove(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        await this.requireAdmin('removeProvider')
        const id = this.idOf(req)
        this.deps.providers.remove(id, (providerId) =>
          this.deps.agents
            .list()
            .filter((agent) => agent.provider === providerId)
            .map((agent) => agent.name),
        )
        this.deps.models?.clear(id)
        return null
      },
      { message: 'Provider removed' },
    )
  }

  async saveKey(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('saveProviderKey')
        const id = this.idOf(req)
        this.deps.credentials.save(id, parseBody(keySchema, req.body).key, admin)
        return this.view(this.deps.providers.get(id) as IProviderConfig)
      },
      { message: 'Key saved' },
    )
  }

  /** Remove a chave salva: volta a valer a do `.env`, se houver (só nos oficiais). */
  async clearKey(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        await this.requireAdmin('clearProviderKey')
        const id = this.idOf(req)
        this.deps.credentials.clear(id)
        return this.view(this.deps.providers.get(id) as IProviderConfig)
      },
      { message: 'Key removed' },
    )
  }

  /** Testa a chave colada (antes de salvar) ou, sem corpo, a que está em vigor — na URL do provider. */
  async test(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('testProviderKey')
      const provider = this.deps.providers.get(this.idOf(req)) as IProviderConfig
      const { key: pasted } = parseBody(testSchema, req.body ?? {})

      const candidate = pasted ?? this.deps.credentials.get(provider.id)
      if (!candidate) return { ok: false, message: 'Nenhuma chave para testar.' }

      return (this.deps.probe ?? probeKey)(provider, candidate)
    })
  }

  /** O catálogo de um provider: tudo o que ele lista, ativado ou não, com o preço e de onde ele veio. */
  async listModels(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('listModels')
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
        const admin = await this.requireAdmin('syncModels')
        const provider = this.deps.providers.get(this.idOf(req)) as IProviderConfig
        const key = this.deps.credentials.get(provider.id)
        if (!key) throw new HttpError(422, 'validation_error', 'Salve uma chave antes de atualizar a lista de modelos.')

        let listed
        try {
          listed = await (this.deps.list ?? listModels)(provider, key)
        } catch (error: unknown) {
          throw new HttpError(502, 'upstream_error', error instanceof Error ? error.message : String(error))
        }

        const result = this.catalog.sync(provider.id, listed, admin)
        return { ...result, models: this.catalog.list(provider.id).map(toModelDto) }
      },
      { message: 'Models synced' },
    )
  }

  /** Liga/desliga um modelo e/ou define o preço manual. O id vai no corpo: id de modelo pode ter `/`. */
  async updateModel(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('updateModel')
        const id = this.idOf(req)
        const body = parseBody(modelChangeSchema, req.body)

        let model: ICatalogModel | undefined
        if (body.enabled !== undefined) model = this.catalog.setEnabled(id, body.modelId, body.enabled, admin)
        if (body.price !== undefined) model = this.catalog.setPrice(id, body.modelId, body.price, admin)
        if (!model) throw new HttpError(422, 'validation_error', 'Nothing to change: send enabled and/or price.')

        return toModelDto(model)
      },
      { message: 'Model updated' },
    )
  }

  private get catalog(): ModelCatalogService {
    if (!this.deps.models) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.models
  }

  /** O provider como a tela o vê: sem chave nenhuma, com o que ela libera. */
  private view(provider: IProviderConfig) {
    const agents = this.deps.agents.list().filter((agent) => agent.provider === provider.id)
    const [credential] = this.deps.credentials.status([provider.id])

    return {
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      official: provider.official,
      enabled: provider.enabled,
      updatedAt: provider.updatedAt,
      updatedBy: provider.updatedBy,
      credential,
      models: [...new Set(agents.flatMap((agent) => agent.models))],
      catalog: this.deps.models ? { total: this.deps.models.list(provider.id).length, enabled: this.deps.models.enabledIds(provider.id).length } : undefined,
      agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
    }
  }

  private idOf(req: Request): string {
    const id = req.params.id as string
    if (!this.deps.providers.get(id)) throw new HttpError(404, 'not_found', 'Not found')
    return id
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
    syncedAt: model.syncedAt,
    updatedAt: model.updatedAt,
    updatedBy: model.updatedBy,
  }
}
