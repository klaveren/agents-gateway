import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canonicalize, documentFromText, ICatalogDocument, TCatalogKind } from '@domain/Catalog.Document'
import { refOfDocument } from '@domain/Catalog.Import'
import { IRemoteCatalog } from '@domain/ports/RemoteCatalog.Port'
import { SqliteProjectConnectionRepository } from '@infra/persistence/Sqlite.ProjectConnectionRepository'
import { CatalogExportUseCase } from './CatalogExport.Usecase'
import { ProjectConnectionService } from './ProjectConnection.Service'

const doc = (kind: TCatalogKind, id: string, projectId: string | undefined, body: Record<string, unknown>) =>
  documentFromText(kind, id, projectId, canonicalize({ id, ...(projectId ? { projectId } : {}), ...body } as never))

/** O pacote da origem: o projeto, a spec que não grava, os dois MCPs globais emprestados e o agente que os usa. */
const ORIGIN = [
  doc('project', 'logiccus', 'logiccus', { name: 'Logiccus' }),
  doc('spec', 'quebrada', 'logiccus', { title: 'Spec', summary: 'S', body: 'B', supersedes: 'sumiu' }),
  doc('mcp', 'gateway', 'logiccus', { url: 'https://origem/mcp', enabled: true }),
  doc('mcp', 'agents-mcp', 'logiccus', { url: 'https://agents/mcp', enabled: true, secrets: ['header'] }),
  doc('agent', 'sre', 'logiccus', { allowedTools: ['mcp:agents-mcp/tickets', 'mcp:gateway/list_agents'] }),
]

/** O aplicador falso: grava na ordem e PARA no item de `failOn` (como o de verdade); o plano não bloqueia nada. */
function build(localGlobals: ICatalogDocument[], localProject: ICatalogDocument[] = [], localMcps: string[] = []) {
  const exporter = new CatalogExportUseCase({
    reader: { list: () => ORIGIN, read: () => ORIGIN[0] } as never,
    mask: { scan: (value: string) => ({ text: value, hits: [] }) } as never,
  })
  const pack = exporter.run({ kind: 'project', projectId: 'logiccus' })
  const client = { package: async () => ({ version: 2, package: pack, files: [], secrets: [] }), changes: async () => ({ version: 2, changes: [] }) } as unknown as IRemoteCatalog
  const failOn = 'spec/quebrada'
  const planned: string[][] = []
  const written: string[] = []
  /** A ordem do que a camada local e o espelho fizeram. */
  const steps: string[] = []
  const repository = new SqliteProjectConnectionRepository(':memory:')
  const service = new ProjectConnectionService({
    repository,
    box: { seal: (plain) => plain, open: (box) => box },
    client: () => client,
    projects: { exists: () => true, create: () => undefined },
    files: { has: () => true, put: () => ({ sha256: '' }) },
    applier: {
      plan: async ({ documents }: { documents: ICatalogDocument[] }) => {
        planned.push(documents.map(refOfDocument))
        return { plan: { items: documents.map((document) => ({ ref: refOfDocument(document), op: 'create', issues: [] })), planHash: 'h', widenings: [] } }
      },
      apply: async ({ documents }: { documents: ICatalogDocument[] }) => {
        const refs = documents.map(refOfDocument).filter((ref) => !written.includes(ref))
        const stop = refs.indexOf(failOn)
        const done = stop < 0 ? refs : refs.slice(0, stop)
        written.push(...done)
        return {
          applied: done.map((ref) => ({ ref })),
          ...(stop < 0 ? { pending: [] } : { failed: { ref: failOn, message: 'Guidance is invalid: supersedes' }, pending: refs.slice(stop + 1).map((ref) => ({ ref })) }),
        }
      },
    } as never,
    reader: { list: (scope) => (scope.kind === 'global' ? localGlobals : localProject) },
    remove: async (current) => void steps.push(`remove ${current.kind}/${current.id}`),
    layers: { applyAll: (projectId) => void steps.push(`apply ${projectId}`), forget: (agentId) => void steps.push(`forget ${agentId}`) },
    localMcps: { ids: () => localMcps, release: (projectId) => void steps.push(`release ${projectId}`) },
    models: async () => ({ enabled: () => true }),
  })
  repository.insert(
    {
      projectId: 'logiccus',
      url: 'http://origem',
      remoteProjectId: 'logiccus',
      syncedVersion: 1,
      latestVersion: 2,
      state: 'ok',
      changes: [],
      skipped: [],
      secrets: [],
      modelMap: {},
      createdAt: new Date(),
      createdBy: 'dev',
    },
    'agc_x',
  )
  return { service, planned, written, steps, repository }
}

describe('projeto conectado: a cópia', () => {
  it('um item que não grava sai sozinho: o que vinha depois dele na fila grava na volta seguinte', async () => {
    const { service, written } = build([])
    const result = await service.sync('logiccus', 'dev')
    assert.deepEqual(
      result.skipped.map((item) => item.ref),
      ['spec/quebrada'],
    )
    assert.ok(written.includes('mcp/logiccus.agents-mcp'), written.join(', '))
    assert.ok(written.includes('agent/sre'), written.join(', '))
    assert.equal(result.applied, written.length)
  })

  it('o MCP emprestado com o id de um global daqui não vem: vale o daqui, e não aparece como "não aplicado"', async () => {
    const { service, planned } = build([doc('mcp', 'gateway', undefined, { url: 'http://localhost/mcp', enabled: true })])
    const result = await service.sync('logiccus', 'dev')
    assert.ok(!planned[0].includes('mcp/logiccus.gateway'))
    assert.ok(planned[0].includes('mcp/logiccus.agents-mcp'))
    assert.ok(!result.skipped.some((item) => item.ref.startsWith('mcp/')))
  })

  it('🔌 a camada local: o agente que a origem removeu leva a dele ANTES de sair; os outros ficam como estão', async () => {
    const { service, steps } = build([], [...ORIGIN, doc('agent', 'antigo', 'logiccus', { allowedTools: [] })])
    const result = await service.sync('logiccus', 'dev')
    assert.deepEqual(steps, ['forget antigo', 'remove agent/antigo'])
    assert.deepEqual(result.removed, ['agent/antigo'])
  })

  it('🔌 o MCP desta máquina: a origem não o remove; o que ela tirou e não é daqui, sai', async () => {
    const here = [
      ...ORIGIN,
      doc('mcp', 'meu', 'logiccus', { url: 'http://localhost:9000/mcp', enabled: true }),
      doc('mcp', 'velho', 'logiccus', { url: 'https://velho/mcp', enabled: true }),
    ]
    const { service, steps } = build([], here, ['meu'])
    const result = await service.sync('logiccus', 'dev')
    assert.deepEqual(steps, ['remove mcp/velho'])
    assert.deepEqual(result.removed, ['mcp/velho'])
  })

  it('🔌 o MCP desta máquina com o id de um da origem: vale o daqui, e não aparece como "não aplicado"', async () => {
    const { service, planned, steps } = build([], [...ORIGIN, doc('mcp', 'agents-mcp', 'logiccus', { url: 'http://localhost:9000/mcp', enabled: true })], ['agents-mcp'])
    const result = await service.sync('logiccus', 'dev')
    assert.ok(!planned[0].includes('mcp/logiccus.agents-mcp'))
    assert.ok(planned[0].includes('mcp/logiccus.gateway'))
    assert.ok(!result.skipped.some((item) => item.ref.startsWith('mcp/')))
    assert.deepEqual(steps, [])
  })

  it('🔌 desconectar aplica as camadas locais nos agentes e solta os MCPs desta máquina, antes de esquecer a conexão', () => {
    const { service, steps, repository } = build([])
    service.disconnect('logiccus', 'dev')
    assert.deepEqual(steps, ['apply logiccus', 'release logiccus'])
    assert.equal(repository.get('logiccus'), undefined)
  })
})
