import { Request, Response } from 'express'
import { z } from 'zod'
import { estimateTokens, GuidanceService } from '@application/Guidance.Service'
import { DOC_KINDS, TDocKind } from '@domain/models/ProjectDoc.Model'
import { TProtocolKind } from '@domain/models/Protocol.Model'
import { RESOURCE_KINDS, TResourceKind } from '@domain/models/Resource.Model'
import { TGuidanceScope } from '@domain/ports/GuidanceRepository.Port'
import { IResourceFile, RESOURCE_FILE_MAX_BYTES } from '@domain/models/ResourceFile.Model'
import { IResourceFilesPort } from '@domain/ports/ResourceFiles.Port'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface IGuidanceControllerDeps {
  guidance: GuidanceService
  proof?: ICallerProof
  /** O depósito dos arquivos de recurso (ver `ResourceFile.Model`). Ausente = sem arquivos (as rotas respondem 404). */
  files?: IResourceFilesPort
  /** Os arquivos de um agente gravado (a guia Arquivos dele). */
  agentFiles?: (agentId: string, files: IResourceFile[], by: string) => unknown
  /** Os segredos que um texto traz (a máscara do gateway): arquivo com segredo não entra. */
  secretsIn?: (text: string) => string[]
}

const project = z.string().max(64).nullable().optional()
const ruleSchema = z.object({ projectId: project, title: z.string().max(400).optional(), body: z.string().optional(), enabled: z.boolean().optional() })
const moveSchema = z.object({ direction: z.enum(['up', 'down']) })
const contextSchema = z.object({ docIds: z.array(z.string().max(80)).max(100) })
const resourceSchema = z.object({
  id: z.string().max(80).optional(),
  kind: z.enum(RESOURCE_KINDS as [TResourceKind, ...TResourceKind[]]).optional(),
  projectId: project,
  description: z.string().max(1_000).optional(),
  body: z.string().optional(),
  docIds: z.array(z.string().max(80)).max(50).optional(),
  docRefs: z.array(z.string().max(80)).max(50).optional(),
  files: z
    .array(z.object({ path: z.string().max(400), sha256: z.string().max(64), bytes: z.number() }))
    .max(1_000)
    .optional(),
})
const filesSchema = z.object({ files: z.array(z.object({ path: z.string().max(400), sha256: z.string().max(64), bytes: z.number() })).max(1_000) })
/** O conteúdo de um arquivo, em base64 (o texto passa inteiro, e o tamanho é o do arquivo). */
const uploadSchema = z.object({ content: z.string().max(Math.ceil((RESOURCE_FILE_MAX_BYTES * 4) / 3) + 8) })
const addendumSchema = z.object({ projectId: project, body: z.string() })
const agentResourcesSchema = z.object({ skills: z.array(z.string().max(80)).max(200).optional(), commands: z.array(z.string().max(80)).max(200).optional() })
/**
 * O "resolvido" de um problema da importação: o código e, para tirar só um, o alvo. Ou `{ pending: true }`: "descartar
 * todos os pendentes" de uma vez (uma gravação, uma revisão no histórico).
 */
export const importIssueMatchSchema = z.union([z.object({ code: z.string().min(1).max(40), target: z.string().max(200).optional() }), z.object({ pending: z.literal(true) })])
const docSchema = z.object({
  id: z.string().max(80).optional(),
  kind: z.enum(DOC_KINDS as [TDocKind, ...TDocKind[]]).optional(),
  projectId: project,
  title: z.string().max(400).optional(),
  summary: z.string().max(1_000).optional(),
  body: z.string().optional(),
  docIds: z.array(z.string().max(80)).max(50).optional(),
  docRefs: z.array(z.string().max(80)).max(50).optional(),
})

/**
 * As rules e os documentos (specs e ADRs). ⛔ TUDO de admin, até a leitura: quem só conversa nem sabe que
 * existem (404, como `/projects`). A conversa os recebe pelo prompt e pelo `read_doc`, não por aqui.
 */
export class GuidanceController {
  constructor(private readonly deps: IGuidanceControllerDeps) {
    for (const name of [
      'listRules',
      'createRule',
      'updateRule',
      'deleteRule',
      'moveRule',
      'listDocs',
      'getDoc',
      'createDoc',
      'updateDoc',
      'deleteDoc',
      'resolveDocImportIssue',
      'resolveResourceImportIssue',
      'getInitialContext',
      'setInitialContext',
      'getAgentContext',
      'setAgentContext',
      'listResources',
      'getResource',
      'createResource',
      'updateResource',
      'deleteResource',
      'getAgentResources',
      'setAgentResources',
      'uploadFile',
      'readFile',
      'setResourceFiles',
      'setAgentFiles',
      'getProtocol',
      'setProtocolAddendum',
    ] as const)
      this[name] = this[name].bind(this)
  }

  async listRules(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listRules')
      return this.deps.guidance.rules(scopeOf(req))
    })
  }

  async createRule(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => this.deps.guidance.createRule(parseBody(ruleSchema, req.body), await this.requireAdmin('createRule')), {
      status: 201,
      message: 'Rule created',
    })
  }

  async updateRule(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => this.deps.guidance.updateRule(req.params.id as string, parseBody(ruleSchema, req.body), await this.requireAdmin('updateRule')))
  }

  async deleteRule(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        this.deps.guidance.deleteRule(req.params.id as string, await this.requireAdmin('deleteRule'))
        return null
      },
      { message: 'Rule deleted' },
    )
  }

  /** Devolve a lista do escopo já na ordem nova. */
  async moveRule(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('moveRule')
      return this.deps.guidance.moveRule(req.params.id as string, parseBody(moveSchema, req.body).direction, by)
    })
  }

  /** A lista vai sem o corpo: o editor busca o documento inteiro (`GET /docs/:id`). */
  async listDocs(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listDocs')
      const kind = typeof req.query.kind === 'string' && (DOC_KINDS as readonly string[]).includes(req.query.kind) ? (req.query.kind as TDocKind) : undefined
      // `loadedIn`: os projetos que carregam a spec inteira (o contexto inicial deles). `tokens`: o peso estimado dela.
      return this.deps.guidance.docs(scopeOf(req), kind).map(({ body, ...doc }) => ({ ...doc, tokens: estimateTokens(body), loadedIn: this.deps.guidance.loadedIn(doc.id) }))
    })
  }

  async getDoc(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('getDoc')
      return this.deps.guidance.doc(req.params.id as string)
    })
  }

  async createDoc(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => this.deps.guidance.createDoc(parseBody(docSchema, req.body), await this.requireAdmin('createDoc')), {
      status: 201,
      message: 'Document created',
    })
  }

  async updateDoc(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { id: _id, ...change } = parseBody(docSchema, req.body)
      return this.deps.guidance.updateDoc(req.params.id as string, change, await this.requireAdmin('updateDoc'))
    })
  }

  async deleteDoc(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        this.deps.guidance.deleteDoc(req.params.id as string, await this.requireAdmin('deleteDoc'))
        return null
      },
      { message: 'Document deleted' },
    )
  }

  /**
   * `POST /docs/:id/import-issues/resolve { code, target? }` — "resolvido": tira do documento os problemas que casam.
   * `{ pending: true }`: descarta todos os pendentes (o que ficou guardado é esquecido).
   */
  async resolveDocImportIssue(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('resolveDocImportIssue')
      return this.deps.guidance.resolveDocIssue(req.params.id as string, parseBody(importIssueMatchSchema, req.body), by)
    })
  }

  /** `POST /resources/:id/import-issues/resolve { code, target? } | { pending: true }` — o mesmo na skill ou no command. */
  async resolveResourceImportIssue(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('resolveResourceImportIssue')
      return this.deps.guidance.resolveResourceIssue(req.params.id as string, parseBody(importIssueMatchSchema, req.body), by)
    })
  }

  /** O contexto inicial do projeto: as specs que vão inteiras no prompt, com os tokens estimados. */
  async getInitialContext(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('getInitialContext')
      return this.deps.guidance.initialContextView(req.params.id as string)
    })
  }

  /** Troca a lista INTEIRA (a ordem dada é a do prompt). */
  async setInitialContext(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('setInitialContext')
      return this.deps.guidance.setInitialContext(req.params.id as string, parseBody(contextSchema, req.body).docIds, by)
    })
  }

  /** O contexto inicial do agente: as specs que ele carrega inteiras além das do projeto. */
  async getAgentContext(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('getAgentContext')
      return this.deps.guidance.agentContextView(req.params.agentId as string)
    })
  }

  async setAgentContext(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('setAgentContext')
      return this.deps.guidance.setAgentContext(req.params.agentId as string, parseBody(contextSchema, req.body).docIds, by)
    })
  }

  /** As skills e os commands de um escopo (`?kind=skill|command`). */
  async listResources(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listResources')
      const kind = typeof req.query.kind === 'string' && (RESOURCE_KINDS as readonly string[]).includes(req.query.kind) ? (req.query.kind as TResourceKind) : undefined
      return this.deps.guidance.resources(scopeOf(req), kind)
    })
  }

  async getResource(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('getResource')
      return this.deps.guidance.resource(req.params.id as string)
    })
  }

  async createResource(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => this.deps.guidance.createResource(parseBody(resourceSchema, req.body), await this.requireAdmin('createResource')), {
      status: 201,
      message: 'Resource created',
    })
  }

  async updateResource(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { id: _id, kind: _kind, ...change } = parseBody(resourceSchema, req.body)
      return this.deps.guidance.updateResource(req.params.id as string, change, await this.requireAdmin('updateResource'))
    })
  }

  async deleteResource(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        this.deps.guidance.deleteResource(req.params.id as string, await this.requireAdmin('deleteResource'))
        return null
      },
      { message: 'Resource deleted' },
    )
  }

  /** As skills e os commands liberados ao agente (`*` = todos os que ele vê). */
  async getAgentResources(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('getAgentResources')
      return this.deps.guidance.agentResources(req.params.agentId as string)
    })
  }

  async setAgentResources(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('setAgentResources')
      return this.deps.guidance.setAgentResources(req.params.agentId as string, parseBody(agentResourcesSchema, req.body), by)
    })
  }

  /**
   * `POST /files { content }` — guarda o conteúdo de um arquivo de recurso no depósito e devolve o sha256 e o tamanho;
   * a lista do recurso aponta para ele depois. ⛔ Só texto (até 1 MB), e nada com segredo: o script lê a credencial de
   * uma variável do gateway.
   */
  async uploadFile(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('uploadFile')
      const files = this.requireFiles()
      const content = Buffer.from(parseBody(uploadSchema, req.body).content, 'base64')
      if (content.length > RESOURCE_FILE_MAX_BYTES)
        throw new HttpError(422, 'validation_error', `at most ${RESOURCE_FILE_MAX_BYTES} bytes`, [{ field: 'content', message: 'too large' }])
      if (content.subarray(0, 8192).includes(0))
        throw new HttpError(422, 'validation_error', 'only text files', [{ field: 'content', message: 'binary content (NUL byte): only text files are accepted' }])
      const secrets = this.deps.secretsIn?.(content.toString('utf8')) ?? []
      if (secrets.length)
        throw new HttpError(422, 'validation_error', 'the file has a secret', [
          { field: 'content', message: `looks like a secret (${[...new Set(secrets)].join(', ')}): read it from a gateway variable instead` },
        ])
      return files.put(content)
    })
  }

  /** `GET /files/:sha256` — o conteúdo de um arquivo do depósito, como texto (a tela edita). */
  async readFile(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('readFile')
      const sha256 = String(req.params.sha256 ?? '')
      const content = /^[a-f0-9]{64}$/.test(sha256) ? this.requireFiles().read(sha256) : undefined
      if (!content) throw new HttpError(404, 'not_found', `file not found: ${sha256}`)
      return { sha256, bytes: content.length, text: content.toString('utf8') }
    })
  }

  /** `PUT /resources/:id/files { files }` — só a lista de arquivos da skill ou do command (o resto fica). */
  async setResourceFiles(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('setResourceFiles')
      this.requireFiles()
      return this.deps.guidance.updateResource(req.params.id as string, { files: parseBody(filesSchema, req.body).files }, by)
    })
  }

  /** `PUT /agents/:agentId/files { files }` — só a lista de arquivos do agente (o resto fica). */
  async setAgentFiles(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('setAgentFiles')
      this.requireFiles()
      if (!this.deps.agentFiles) throw new HttpError(404, 'not_found', 'Not found')
      const { files } = parseBody(filesSchema, req.body)
      this.deps.agentFiles(req.params.agentId as string, files, by)
      return { files }
    })
  }

  private requireFiles(): IResourceFilesPort {
    if (!this.deps.files) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.files
  }

  /** O protocolo do tipo: o do core (versão e corpo) e os complementos — o global e, com `?project=`, o do projeto. */
  async getProtocol(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('getProtocol')
      return this.deps.guidance.protocol(kindOf(req), scopeOf(req) ?? undefined)
    })
  }

  /** Grava o complemento do escopo (`projectId` ausente ou nulo = global). Corpo vazio apaga. */
  async setProtocolAddendum(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const by = await this.requireAdmin('setProtocolAddendum')
      const body = parseBody(addendumSchema, req.body)
      return this.deps.guidance.setProtocolAddendum(kindOf(req), body.projectId || null, body.body, by)
    })
  }

  private async requireAdmin(operation: string): Promise<string> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return access.identity?.email ?? access.identity?.id ?? 'admin'
  }

  private async respond<T>(res: Response, work: () => Promise<T>, options: { status?: number; message?: string } = {}) {
    try {
      res.status(options.status ?? 200).json(ok(await work(), options.message))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[GuidanceController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

/** `?project=<id>` ou, ausente ou `global`, o escopo global. */
function scopeOf(req: Request): TGuidanceScope {
  const value = typeof req.query.project === 'string' ? req.query.project.trim() : ''
  return value && value !== 'global' ? value : null
}

/** O `:kind` da rota: skill, command, rule, spec ou adr (o serviço recusa o resto, com o motivo). */
function kindOf(req: Request): TProtocolKind {
  return req.params.kind as TProtocolKind
}
