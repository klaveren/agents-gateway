import { Request, Response } from 'express'
import { z } from 'zod'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { WorkFolderError } from '@infra/workspace/Work.Folder'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface IImportControllerDeps {
  scan: ImportScanUseCase
  projectExists: (projectId: string) => boolean
  proof?: ICallerProof
}

const scanSchema = z.object({ repository: z.string().min(1).max(100) })

/**
 * O IMPORTADOR de recursos de um repositório do projeto. Por ora só a varredura: devolve o inventário e não grava nada.
 *
 * ⛔ Só admin (quem administra o projeto), 404 para os demais, como `/projects/:id/members`. O repositório é só o
 * nome da pasta em `<projeto>/repositories/`, resolvido no servidor: repositório de outro projeto não existe aqui.
 */
export class ImportController {
  constructor(private readonly deps: IImportControllerDeps) {
    this.scan = this.scan.bind(this)
  }

  /** `POST /projects/:id/import/scan { repository }` — o inventário do repositório (só leitura, nada persiste). */
  async scan(req: Request, res: Response): Promise<void> {
    try {
      const projectId = req.params.id as string
      const access = await checkAdminAccess(this.deps.proof)
      if (!access.allowed) {
        console.warn('[admin] acesso negado a importScan:', access.reason)
        throw new HttpError(404, 'not_found', 'Not found')
      }
      if (!this.deps.projectExists(projectId)) throw new HttpError(404, 'not_found', `Project not found: ${projectId}`)
      const { repository } = parseBody(scanSchema, req.body)
      let result
      try {
        result = this.deps.scan.execute(projectId, repository)
      } catch (error) {
        if (error instanceof WorkFolderError) throw new HttpError(422, 'validation_error', 'Request body is invalid', [{ field: 'repository', message: error.message }])
        throw error
      }
      res.status(200).json(ok(result))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[ImportController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}
