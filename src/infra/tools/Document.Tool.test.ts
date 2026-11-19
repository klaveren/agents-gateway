import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IConversationFile } from '@domain/models/ConversationFile.Model'
import { markdownToTypst, typstString } from '@infra/documents/Markdown.Typst'
import { renderDocumentTool } from './Document.Tool'

function deliveries() {
  const saved: Array<{ file: IConversationFile; data: Buffer }> = []
  return {
    saved,
    deliveries: { files: async () => saved.map((item) => item.file), saveFile: async (file: IConversationFile, data: Buffer) => void saved.push({ file, data }), turnOf: () => 3 },
  }
}
const context = { sessionId: 'gw_1', agentId: 'hermes', conversationProjectId: 'alfa' } as never

describe('render_document', () => {
  it('📄 os quatro formatos viram arquivo entregue na conversa, com o modelo do projeto', async () => {
    const { saved, deliveries: store } = deliveries()
    const asked: Array<string | undefined> = []
    const tool = renderDocumentTool(store, (projectId) => (asked.push(projectId), { organization: 'Infoccus', footer: 'CNPJ 1', color: '#7C3AED' }))
    const runs = [
      { format: 'pdf', name: 'relatorio', title: 'Relatório', markdown: '# Título\n\nTexto **forte**.\n\n| A | B |\n|---|---|\n| 1 | 2 |' },
      { format: 'docx', name: 'proposta.docx', markdown: '## Proposta\n\n- um\n- dois' },
      {
        format: 'xlsx',
        name: 'planilha',
        sheets: [
          {
            name: 'Vendas',
            rows: [
              ['Cliente', 'Valor'],
              ['ACME', 10],
              ['Total', '=SUM(B2:B2)'],
            ],
          },
        ],
      },
      { format: 'pptx', name: 'deck', title: 'Q4', slides: [{ title: 'Resumo', bullets: ['a', 'b'], notes: 'n' }] },
    ]
    for (const args of runs) assert.strictEqual((await tool.execute(args, context)).status, 'success', JSON.stringify(args))
    assert.deepStrictEqual(
      saved.map((item) => [item.file.name, item.file.mime.split('.').pop(), item.file.turn, item.file.agentId]),
      [
        ['relatorio.pdf', 'application/pdf', 3, 'hermes'],
        ['proposta.docx', 'document', 3, 'hermes'],
        ['planilha.xlsx', 'sheet', 3, 'hermes'],
        ['deck.pptx', 'presentation', 3, 'hermes'],
      ],
    )
    assert.strictEqual(saved[0].data.subarray(0, 5).toString(), '%PDF-')
    for (const item of saved.slice(1)) assert.strictEqual(item.data.subarray(0, 2).toString(), 'PK', 'docx/xlsx/pptx são zip')
    assert.deepStrictEqual([...new Set(asked)], ['alfa'], 'o modelo é o do projeto da conversa')
  })

  it('o pedido errado volta com o motivo, sem gerar nada', async () => {
    const { saved, deliveries: store } = deliveries()
    const tool = renderDocumentTool(store)
    assert.match((await tool.execute({ format: 'pdf', name: 'x' }, context)).result as string, /pdf needs markdown/)
    assert.match((await tool.execute({ format: 'xlsx', name: 'x', sheets: [] }, context)).result as string, /xlsx needs sheets/)
    assert.match((await tool.execute({ format: 'odt', name: 'x' }, context)).result as string, /format must be one of/)
    assert.match((await tool.execute({ format: 'pdf', name: 'x', markdown: 'a' }, {} as never)).result as string, /only works inside a conversation/)
    assert.strictEqual(saved.length, 0)
  })
})

describe('Markdown.Typst', () => {
  it('⛔ o texto do agente é string, nunca código: #read, #import e aspas ficam literais', () => {
    const typst = markdownToTypst('Oi #read("/etc/passwd") e #import "@preview/x:1.0" ] \\ fim')
    assert.ok(typst.includes(typstString('Oi #read("/etc/passwd") e #import "@preview/x:1.0" ] \\ fim')), typst)
    assert.ok(!/^#read|[^"]#read\(/.test(typst.replace(/"(?:[^"\\]|\\.)*"/g, '""')), 'fora das strings não sobra #read')
  })

  it('⛔ o PDF não lê arquivo do servidor nem com imagem: fica o texto alternativo', () => {
    assert.strictEqual(markdownToTypst('![segredo](/etc/hosts)'), `#par[#${typstString('segredo')}]`)
  })
})
