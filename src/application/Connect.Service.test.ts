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
})
