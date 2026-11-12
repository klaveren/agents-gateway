import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canonicalize, documentFromText, ICatalogDocument, TCatalogKind } from '@domain/Catalog.Document'
import { ConnectService } from './Connect.Service'

const doc = (kind: TCatalogKind, id: string, projectId: string | undefined, body: Record<string, unknown>) =>
  documentFromText(kind, id, projectId, canonicalize({ id, ...(projectId ? { projectId } : {}), ...body } as never))

describe('ConnectService (a origem de um projeto conectado)', () => {
  it('o pacote leva os MCPs GLOBAIS que os agentes do projeto usam, como se fossem do projeto; o resto dos globais fica', () => {
    const project = [doc('agent', 'maya', 'logiccus', { allowedTools: ['mcp:agents-mcp/tickets', 'read_doc'] }), doc('mcp', 'proprio', 'logiccus', { url: 'https://p' })]
    const global = [doc('mcp', 'agents-mcp', undefined, { url: 'https://agents.local/mcp' }), doc('mcp', 'outro', undefined, { url: 'https://o' })]
    let extra: readonly ICatalogDocument[] = []
    const service = new ConnectService({
      history: { versionOf: () => 7, since: () => [] },
      exporter: {
        run: (_scope, _by, more = []) => {
          extra = more
          return { manifest: {} as never, files: {} }
        },
      },
      reader: { list: (scope) => (scope.kind === 'global' ? global : project) },
      files: { read: () => undefined },
    })
    service.package('logiccus', 'dev@x')
    assert.deepEqual(
      extra.map((item) => [item.kind, item.id, item.projectId, (item.body as { projectId?: string }).projectId]),
      [['mcp', 'agents-mcp', 'logiccus', 'logiccus']],
    )
  })

  it('⛔ o ledger do agente só de admin (`adminOnly`): a conexão de um membro comum não lê nem escreve; a de quem administra, sim', () => {
    const written: string[] = []
    const service = new ConnectService({
      history: { versionOf: () => 1, since: () => [] },
      exporter: { run: () => ({ manifest: {} as never, files: {} }) },
      reader: { list: () => [] },
      files: { read: () => undefined },
      ledger: {
        index: () => ({}) as never,
        context: () => ({}) as never,
        search: () => ({}) as never,
        promptSection: () => undefined,
        write: (agentId) => (written.push(agentId), {} as never),
      },
      agentProject: (agentId) => (agentId === 'fora' ? 'outro' : 'logiccus'),
      agentAdminOnly: (agentId) => agentId === 'restrito',
    })
    const change = { op: 'gatilho' } as never

    assert.throws(() => service.ledger('logiccus', 'restrito', 'member'), /restrito/)
    assert.throws(() => service.ledger('logiccus', 'restrito'), /restrito/)
    assert.throws(() => service.ledger('logiccus', 'fora', 'admin'), /fora/)
    service.ledger('logiccus', 'restrito', 'admin').write(change, { via: 'a@x' })
    service.ledger('logiccus', 'comum', 'member').write(change, { via: 'm@x' })
    assert.deepEqual(written, ['restrito', 'comum'])
  })
})
