import { EProvider } from '@domain/enums/EProvider.Enum'
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
  credentials: ICredentialStore
  agents: IAgentDirectory
  proof?: ICallerProof
  /** Injetável para o teste não sair para a rede. */
  probe?: typeof probeKey
}

/** Uma chave de API: texto sem espaço, com teto — ninguém cola um arquivo inteiro aqui. */
const keySchema = z.object({ key: z.string().trim().min(8).max(500).regex(/^\S+$/, 'no spaces') })
const testSchema = z.object({ key: z.string().trim().min(8).max(500).regex(/^\S+$/, 'no spaces').optional() })

/**
 * As chaves de API dos providers — a seção Providers.
 *
 * ⛔ SÓ ADMINISTRADOR, 404 para os demais (a mesma porta de `/settings`). ⛔ A CHAVE SÓ ENTRA: nenhuma
 * resposta daqui a devolve; o status mostra a origem e os quatro últimos caracteres.
 */
export class ProvidersController {
  constructor(private readonly deps: IProvidersControllerDeps) {
    for (const name of ['list', 'saveKey', 'clearKey', 'test'] as const) this[name] = this[name].bind(this)
  }

  async list(_req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('listProviders')
      const agents = this.deps.agents.list()

      return this.deps.credentials.status().map((status) => ({
        ...status,
        // O que a chave libera: os modelos que os agentes deste provider declaram.
        models: [...new Set(agents.filter((agent) => agent.provider === status.provider).flatMap((agent) => agent.models))],
        agents: agents.filter((agent) => agent.provider === status.provider).map((agent) => ({ id: agent.id, name: agent.name })),
      }))
    })
  }

  async saveKey(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('saveProviderKey')
        const provider = providerOf(req)
        const { key } = parseBody(keySchema, req.body)

        this.deps.credentials.save(provider, key, admin)
        return this.statusOf(provider)
      },
      { message: 'Key saved' },
    )
  }

  /** Remove a chave salva: volta a valer a do `.env`, se houver. */
  async clearKey(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        await this.requireAdmin('clearProviderKey')
        const provider = providerOf(req)

        this.deps.credentials.clear(provider)
        return this.statusOf(provider)
      },
      { message: 'Key removed' },
    )
  }

  /** Testa a chave colada (antes de salvar) ou, sem corpo, a que está em vigor. */
  async test(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('testProviderKey')
      const provider = providerOf(req)
      const { key } = parseBody(testSchema, req.body ?? {})

      const candidate = key ?? this.deps.credentials.get(provider)
      if (!candidate) return { ok: false, message: 'Nenhuma chave para testar.' }

      return (this.deps.probe ?? probeKey)(provider, candidate)
    })
  }

  private statusOf(provider: EProvider) {
    return this.deps.credentials.status().find((status) => status.provider === provider)
  }

  private async requireAdmin(operation: string): Promise<string> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed || !access.identity?.id) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return access.identity.email ?? access.identity.id
  }

  private async respond<T>(res: Response, work: () => Promise<T>, options: { message?: string } = {}) {
    try {
      res.status(200).json(ok(await work(), options.message))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[ProvidersController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

function providerOf(req: Request): EProvider {
  const id = req.params.id as EProvider
  if (!Object.values(EProvider).includes(id)) throw new HttpError(404, 'not_found', 'Not found')
  return id
}
