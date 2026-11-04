import { Request, Response } from 'express'
import { z } from 'zod'
import { MicromambaAdapter, PACKAGE_NAME, PACKAGE_VERSION, PackageBusyError, toolsPrefix } from '@infra/packages/Micromamba.Adapter'
import { NPM_PACKAGE_NAME, NPM_PACKAGE_VERSION, NpmAdapter, npmPrefix } from '@infra/packages/Npm.Adapter'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface IPackagesControllerDeps {
  packages?: MicromambaAdapter
  /** Os pacotes do registro npm (ver `Npm.Adapter`). */
  npm?: NpmAdapter
  proof?: ICallerProof
}

/** De onde vem o pacote: o conda-forge (padrão) ou o registro npm. */
type TPackageSource = 'conda' | 'npm'
const sourceOf = (value: unknown): TPackageSource => (value === 'npm' ? 'npm' : 'conda')

const installSchema = z.object({
  name: z.string().regex(PACKAGE_NAME, 'a conda-forge package name'),
  version: z.string().regex(PACKAGE_VERSION, 'a version like 2.45 or 2.*').optional(),
})
// ⚖️ npm: a versão é obrigatória e EXATA — a aba não instala "a mais nova".
const npmInstallSchema = z.object({
  source: z.literal('npm'),
  name: z.string().regex(NPM_PACKAGE_NAME, 'an npm package name (e.g. mongosh or @scope/name)'),
  version: z.string().regex(NPM_PACKAGE_VERSION, 'an exact version like 2.14.1'),
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
  private readonly npm: NpmAdapter

  constructor(private readonly deps: IPackagesControllerDeps = {}) {
    this.packages = deps.packages ?? new MicromambaAdapter()
    this.npm = deps.npm ?? new NpmAdapter()
    for (const name of ['list', 'search', 'install', 'remove'] as const) this[name] = this[name].bind(this)
  }

  async list(_req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('listPackages')
      const [status, npm] = await Promise.all([this.packages.available(), this.npm.available()])
      return {
        ...status,
        prefix: toolsPrefix(),
        packages: status.available ? await this.packages.list() : [],
        npm: { ...npm, prefix: npmPrefix(), packages: npm.available ? await this.npm.list() : [] },
      }
    })
  }

  async search(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('searchPackages')
      const query = typeof req.query.q === 'string' ? req.query.q : ''
      return sourceOf(req.query.source) === 'npm' ? this.npm.search(query) : this.packages.search(query)
    })
  }

  async install(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('installPackage')
      if (sourceOf((req.body as { source?: unknown } | undefined)?.source) === 'npm') {
        const body = parseBody(npmInstallSchema, req.body)
        return { ...(await this.npm.install(body.name, body.version)), source: 'npm', packages: await this.npm.list() }
      }
      const body = parseBody(installSchema, req.body)
      return { ...(await this.packages.install(body.name, body.version)), packages: await this.packages.list() }
    })
  }

  async remove(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('removePackage')
      const name = req.params.name as string
      if (sourceOf(req.query.source) === 'npm') {
        if (!NPM_PACKAGE_NAME.test(name)) throw new HttpError(422, 'validation_error', 'Not an npm package name')
        return { ...(await this.npm.remove(name)), source: 'npm', packages: await this.npm.list() }
      }
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
