import { Request, Response } from 'express'
import { z } from 'zod'
import { MicromambaAdapter, PACKAGE_NAME, PACKAGE_VERSION, PackageBusyError, toolsPrefix } from '@infra/packages/Micromamba.Adapter'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface IPackagesControllerDeps {
  packages?: MicromambaAdapter
  proof?: ICallerProof
}

const installSchema = z.object({
  name: z.string().regex(PACKAGE_NAME, 'a conda-forge package name'),
  version: z.string().regex(PACKAGE_VERSION, 'a version like 2.45 or 2.*').optional(),
})

/**
 * A guia Pacotes: ferramentas do servidor (git, curl, jq…) instaladas pelo micromamba numa pasta
 * persistente, que entra no PATH do gateway.
 *
 * ⛔ SÓ ADMINISTRADOR, e 404 para os demais (como `/mcp-servers`): o que se instala aqui vale para o Bash
 * de todos os agentes.
 */
export class PackagesController {
  private readonly packages: MicromambaAdapter

  constructor(private readonly deps: IPackagesControllerDeps = {}) {
    this.packages = deps.packages ?? new MicromambaAdapter()
    for (const name of ['list', 'search', 'install', 'remove'] as const) this[name] = this[name].bind(this)
  }

  async list(_req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('listPackages')
      const status = await this.packages.available()
      return { ...status, prefix: toolsPrefix(), packages: status.available ? await this.packages.list() : [] }
    })
  }

  async search(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('searchPackages')
      const query = typeof req.query.q === 'string' ? req.query.q : ''
      return this.packages.search(query)
    })
  }

  async install(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('installPackage')
      const body = parseBody(installSchema, req.body)
      return { ...(await this.packages.install(body.name, body.version)), packages: await this.packages.list() }
    })
  }

  async remove(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('removePackage')
      const name = req.params.name as string
      if (!PACKAGE_NAME.test(name)) throw new HttpError(422, 'validation_error', 'Not a package name')
      return { ...(await this.packages.remove(name)), packages: await this.packages.list() }
    })
  }

  private async requireAdmin(operation: string): Promise<void> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
  }

  private async respond<T>(res: Response, work: () => Promise<T>) {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      const failure = toHttpFailure(error instanceof PackageBusyError ? new HttpError(409, 'package_busy', error.message) : error)
      if (failure.status >= 500) console.error('[PackagesController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}
