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

/**
 * O aplicador falso: grava na ordem e PARA no item de `failOn` (como o de verdade); o plano não bloqueia nada.
 * `synced` = a conexão já terminou uma atualização (a primeira é a que traz os MCPs).
 */
function build(localGlobals: ICatalogDocument[], localProject: ICatalogDocument[] = [], synced = false) {
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
    projects: {
      exists: () => true,
      create: () => undefined,
      keepEnv: (id, env) => void steps.push(`keep-env ${id} ${JSON.stringify(env)}`),
      keepMcpEnv: (id, list) => void steps.push(`keep-mcp ${id} ${list.map((item) => `${item.server}/${item.name}`).join(',')}`),
    },
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
    localMcps: { release: (projectId) => void steps.push(`release ${projectId}`) },
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
  if (synced) repository.update('logiccus', { lastSyncedAt: new Date() })
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

  it('🔌 os MCPs são desta máquina: depois da primeira atualização a origem não traz, não troca e não remove nenhum', async () => {
    const here = [
      doc('mcp', 'gateway', 'logiccus', { url: 'http://localhost:9000/mcp', enabled: false }),
      doc('mcp', 'velho', 'logiccus', { url: 'https://velho/mcp', enabled: true }),
      doc('agent', 'sre', 'logiccus', { allowedTools: [] }),
    ]
    const { service, planned, written, steps } = build([], here, true)
    const result = await service.sync('logiccus', 'dev')
    // Nem o que mudou lá (`gateway`), nem o que foi removido aqui (`agents-mcp`), nem o que a origem tirou (`velho`).
    assert.ok(!planned[0].some((ref) => ref.startsWith('mcp/')), planned[0].join(', '))
    assert.deepEqual(steps, [])
    assert.deepEqual(result.removed, [])
    assert.ok(!result.skipped.some((item) => item.ref.startsWith('mcp/')))
    // O agente que cita o MCP que não está mais aqui continua atualizando.
    assert.ok(written.includes('agent/sre'), written.join(', '))
  })

  it('🔌 a primeira atualização refeita só traz o MCP que ainda não está aqui', async () => {
    const { service, planned, steps } = build([], [doc('mcp', 'agents-mcp', 'logiccus', { url: 'http://localhost:9000/mcp', enabled: true })])
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

  it('🔌 as fixas desta máquina: gravadas na conexão com as regras do projeto; ao desconectar, passam para o projeto', () => {
    const { service, steps, repository } = build([])
    assert.deepEqual(service.setLocalEnv('logiccus', { API_BASE_URL: 'http://localhost:4000' }).localEnv, { API_BASE_URL: 'http://localhost:4000' })
    for (const env of [{ minusculo: 'x' }, { API_TOKEN: 'x' }, { PATH: '/tmp' }] as Array<Record<string, string>>)
      assert.throws(() => service.setLocalEnv('logiccus', env), /Project is invalid|invalid/i, JSON.stringify(env))
    assert.deepEqual(repository.get('logiccus')?.localEnv, { API_BASE_URL: 'http://localhost:4000' })
    service.setLocalMcpEnv('logiccus', [{ server: 'n8n', name: 'N8N_API_URL', value: 'http://localhost:5678' }])
    assert.throws(() => service.setLocalMcpEnv('logiccus', [{ server: 'n8n', name: 'minusculo', value: 'x' }]), /invalid/i)
    service.disconnect('logiccus', 'dev')
    assert.deepEqual(steps, ['apply logiccus', 'keep-env logiccus {"API_BASE_URL":"http://localhost:4000"}', 'keep-mcp logiccus n8n/N8N_API_URL', 'release logiccus'])
    // Vazia, a conexão não leva nada ao projeto.
    const other = build([])
    other.service.setLocalEnv('logiccus', {})
    assert.equal(other.repository.get('logiccus')?.localEnv, undefined)
    other.service.disconnect('logiccus', 'dev')
    assert.deepEqual(other.steps, ['apply logiccus', 'release logiccus'])
  })
})
