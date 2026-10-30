import { Request, Response } from 'express'
import { z } from 'zod'
import { SecretMasker } from '@infra/secrets/Secret.Masker'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface ISecretMaskControllerDeps {
  masker: SecretMasker
  proof?: ICallerProof
}

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const NAME = /^[A-Za-z0-9_.-]{2,64}$/
const valueSchema = z.object({ label: z.string().trim().min(1).max(80), value: z.string().max(16_384).optional() })
const namesSchema = z.object({ secret: z.array(z.string().trim().regex(NAME)).max(200), safe: z.array(z.string().trim().regex(NAME)).max(200) })
const testSchema = z.object({ text: z.string().max(100_000) })

/**
 * A MÁSCARA DE SEGREDOS na tela (só admin; 404 para os demais): os valores a mascarar (o valor entra e nunca volta), os
 * nomes de campo que dizem segredo e os que nunca dizem, o testador e os últimos acertos (só metadado).
 */
export class SecretMaskController {
  constructor(private readonly deps: ISecretMaskControllerDeps) {
    for (const name of ['get', 'saveValue', 'removeValue', 'saveNames', 'test'] as const) this[name] = this[name].bind(this)
  }

  async get(_req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.admin('getSecretMask')
      return { values: this.deps.masker.values(), names: this.deps.masker.names(), hits: this.deps.masker.recentHits().slice(0, 100) }
    })
  }

  async saveValue(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.admin('saveSecretMaskValue')
      const id = String(req.params.id ?? '')
      if (!ID.test(id)) throw new HttpError(422, 'validation_error', 'id: minúsculas, números e hífen')
      const body = parseBody(valueSchema, req.body)
      try {
        this.deps.masker.saveValue(id, body.label, body.value, by)
      } catch (error: unknown) {
        throw new HttpError(422, 'validation_error', error instanceof Error ? error.message : String(error))
      }
      return { saved: id }
    })
  }

  async removeValue(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.admin('removeSecretMaskValue')
      if (!this.deps.masker.removeValue(String(req.params.id ?? ''))) throw new HttpError(404, 'not_found', 'Not found')
      return { removed: req.params.id }
    })
  }

  async saveNames(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.admin('saveSecretMaskNames')
      this.deps.masker.saveNames(parseBody(namesSchema, req.body))
      return this.deps.masker.names()
    })
  }

  /** O testador: o texto colado, como ficaria (pelo mesmo caminho das ferramentas; o acerto entra na lista). */
  async test(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.admin('testSecretMask')
      return { masked: this.deps.masker.text(parseBody(testSchema, req.body).text) }
    })
  }

  private async admin(operation: string): Promise<string> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return access.identity?.email ?? access.identity?.id ?? 'admin'
  }

  private async respond<T>(res: Response, work: () => Promise<T>) {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[SecretMaskController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}
