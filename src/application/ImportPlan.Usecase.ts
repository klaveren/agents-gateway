import { builderAgent } from '@domain/Builder.Agents'
import { IMPORT_PREFIX_PATTERN, planAgentBatch } from '@domain/Import.Order'
import { IImportPlan, TItemStates } from '@domain/models/ImportPlan.Model'
import { TInventoryKind } from '@domain/models/ImportInventory.Model'
import { PROTOCOL_KINDS, TProtocolKind } from '@domain/models/Protocol.Model'
import { estimateTokens } from '@domain/Token.Estimate'
import { IImportScanOptions, ImportScanUseCase } from './ImportScan.Usecase'

/**
 * O pedido do lote: o repositório, o agente (chave `agent:<id>` ou o id), o prefixo opcional dos ids e o trabalho
 * aberto (opcional): com ele, o que já está aprovado ou aplicado no trabalho sai das conversas e da estimativa.
 */
export interface IImportPlanRequest extends IImportScanOptions {
  repository: string
  agent: string
  prefix?: string
  job?: string
}

/** O pedido não serve (agente que não existe no inventário, prefixo inválido): vira 422 no campo. */
export class ImportPlanError extends Error {
  constructor(
    readonly field: 'agent' | 'prefix' | 'job',
    message: string,
  ) {
    super(message)
    this.name = 'ImportPlanError'
  }
}

export interface IImportPlanDeps {
  scan: ImportScanUseCase
  /** ≈ tokens do protocolo do construtor de um tipo. Padrão: alma + prompt do construtor do core. */
  protocolTokens?: (kind: TInventoryKind) => number
  /** O repositório e o estado dos itens de um trabalho do projeto (ausente = não é dele). */
  jobStates?: (projectId: string, jobId: string) => { repository: string; states: TItemStates } | undefined
  now?: () => Date
}

/** ≈ tokens do construtor do core de cada tipo (a alma e o prompt com o protocolo), sem os complementos do projeto. */
export function builderProtocolTokens(): (kind: TInventoryKind) => number {
  const cache = new Map<TInventoryKind, number>()
  return (kind) => {
    const protocol: TProtocolKind | undefined = kind === 'trigger' ? 'agent' : PROTOCOL_KINDS.find((one) => one === kind)
    if (!protocol) return 0
    if (!cache.has(kind)) {
      const agent = builderAgent(protocol, { provider: 'estimate', models: [] })
      cache.set(kind, estimateTokens(`${agent.soul ?? ''}\n${agent.systemPrompt ?? ''}`))
    }
    return cache.get(kind)!
  }
}

/**
 * ⛔ O LOTE de um agente: SÓ LÊ. Roda a varredura (mesma contenção, mesmo ignorar), monta o fecho, a ordem, o mapa de
 * ids, o alcance traduzido e a estimativa. O que já está no catálogo do projeto (e, com o trabalho, o que já está
 * aprovado nele) fica marcado e fora das conversas. Não grava, não persiste, não chama modelo, não dispara construtor.
 */
export class ImportPlanUseCase {
  private readonly protocolTokens: (kind: TInventoryKind) => number

  constructor(private readonly deps: IImportPlanDeps) {
    this.protocolTokens = deps.protocolTokens ?? builderProtocolTokens()
  }

  execute(projectId: string, request: IImportPlanRequest): IImportPlan {
    const prefix = (request.prefix ?? '').trim().toLowerCase()
    if (prefix && !IMPORT_PREFIX_PATTERN.test(prefix)) throw new ImportPlanError('prefix', 'prefix: lowercase letters, digits and "-", up to 16 characters')
    let states: TItemStates | undefined
    if (request.job) {
      const found = this.deps.jobStates?.(projectId, request.job)
      if (!found) throw new ImportPlanError('job', `import job not found: ${request.job}`)
      if (found.repository !== request.repository) throw new ImportPlanError('job', 'the import job is of another repository')
      states = found.states
    }
    const { scan, reach, agentByName, instructions } = this.deps.scan.inventory(projectId, request.repository, request.ignore ? { ignore: request.ignore } : {})
    const wanted = request.agent.trim()
    const agent = scan.items.find((item) => item.kind === 'agent' && (item.key === wanted || item.candidateId === wanted))
    if (!agent) throw new ImportPlanError('agent', `agent not found in the inventory: ${wanted}`)
    const batch = planAgentBatch({
      items: scan.items,
      agent: agent.key,
      prefix,
      reach,
      agentByName,
      ...(instructions ? { instructions } : {}),
      catalog: (query) => this.deps.scan.catalogState({ ...query, projectId }),
      protocolTokens: this.protocolTokens,
      ...(states ? { states } : {}),
    })
    return {
      projectId,
      repository: request.repository,
      ...(scan.head ? { head: scan.head } : {}),
      ...(scan.dirty !== undefined ? { dirty: scan.dirty } : {}),
      plannedAt: (this.deps.now ?? (() => new Date()))(),
      ...batch,
    }
  }
}
