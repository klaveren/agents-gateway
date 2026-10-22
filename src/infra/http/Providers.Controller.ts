import { ProvidersService } from '@application/Providers.Service'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IProviderConfig } from '@domain/models/Provider.Model'
import { IAgentDirectory } from '@domain/ports/AgentRepository.Port'
import { ICredentialStore } from '@domain/ports/CredentialStore.Port'
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
  /** Injetável para o teste não sair para a rede. */
  probe?: typeof probeKey
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
const updateSchema = z.object({ name: z.string().max(200).optional(), baseUrl: z.string().trim().max(500).optional(), enabled: z.boolean().optional() })

/**
 * A seção Providers: os oficiais e os compatíveis (OpenRouter, vLLM, LiteLLM…), com a chave de cada um.
 *
 * ⛔ SÓ ADMINISTRADOR, 404 para os demais (a mesma porta de `/settings`). ⛔ A CHAVE SÓ ENTRA: nenhuma
 * resposta daqui a devolve; o status mostra a origem e os quatro últimos caracteres.
 */
export class ProvidersController {
  constructor(private readonly deps: IProvidersControllerDeps) {
    for (const name of ['list', 'create', 'update', 'remove', 'saveKey', 'clearKey', 'test'] as const) this[name] = this[name].bind(this)
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
