import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IConversationFile } from '@domain/models/ConversationFile.Model'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { deliverFileTool } from './File.Tools'

describe('deliver_file', () => {
  let base: string
  let project: string
  let conversation: string
  let saved: Array<{ file: IConversationFile; data: Buffer }>

  const context = { sessionId: 'gw_1', agentId: 'assistente' } as IExecutionContext
  /** Entrega com a raiz de trabalho e a resposta da regra de leitura (`denied`: o motivo; nada = liberado). */
  const deliver = (root: string, args: Record<string, unknown>, denied?: string, withContext = true) =>
    deliverFileTool(
      { rootFor: () => root, access: () => denied },
      { files: async () => saved.map((item) => item.file), saveFile: async (file, data) => void saved.push({ file, data }), turnOf: () => 2 },
      () => conversation,
    ).execute(args, withContext ? context : undefined)

  before(() => {
    base = mkdtempSync(join(tmpdir(), 'deliver-'))
    project = join(base, 'project')
    conversation = join(base, 'conversation')
    mkdirSync(project)
    mkdirSync(conversation)
    writeFileSync(join(conversation, 'quotes.csv'), 'a,b\n1,2\n')
    writeFileSync(join(project, 'report.md'), '# ok')
    writeFileSync(join(project, '.env'), 'KEY=1')
    writeFileSync(join(base, 'outside.txt'), 'nope')
  })

  after(() => rmSync(base, { recursive: true, force: true }))

  it('a pasta da conversa entrega sem regra: guarda a cópia e devolve o resumo que a tela lê', async () => {
    saved = []
    const result = await deliver(conversation, { path: 'quotes.csv' }, 'no rule')

    assert.equal(result.status, 'success', String(result.result))
    const [{ file, data }] = saved as [{ file: IConversationFile; data: Buffer }]
    assert.deepEqual([file.name, file.mime, file.size, file.turn, data.toString()], ['quotes.csv', 'text/csv', 8, 2, 'a,b\n1,2\n'])
    assert.match(String(result.result), /"deliveredFile":\{"id":"f_[a-f0-9]+","name":"quotes.csv","size":8\}/)
  })

  it('pelo caminho absoluto da conversa, mesmo com outra raiz', async () => {
    saved = []
    const result = await deliver(project, { path: join(conversation, 'quotes.csv'), name: 'citações.csv' }, 'no rule')
    assert.equal(result.status, 'success', String(result.result))
    assert.equal(saved[0]!.file.name, 'citações.csv')
  })

  it('⛔ fora da conversa vale a regra de leitura, a lista protegida e a raiz', async () => {
    saved = []
    assert.match(String((await deliver(project, { path: 'report.md' }, 'no read rule')).result), /Not permitted/)
    assert.equal((await deliver(project, { path: 'report.md' })).status, 'success')
    assert.match(String((await deliver(project, { path: '.env' })).result), /protected/)
    assert.match(String((await deliver(project, { path: '../outside.txt' })).result), /outside/)
  })

  it('sem conversa, recusa', async () => {
    assert.equal((await deliver(conversation, { path: 'quotes.csv' }, undefined, false)).status, 'error')
  })
})
