import assert from 'node:assert'
import { describe, it } from 'node:test'
import { ILedgerAgentInfo, LedgerService } from '@application/Ledger.Service'
import { SqliteLedgerRepository } from '@infra/persistence/Sqlite.LedgerRepository'
import { makeLedgerTools } from './Ledger.Tools'

const AGENTS: Record<string, ILedgerAgentInfo> = { theo: { id: 'theo' }, ana: { id: 'ana', projectId: 'xpto' }, zeus: { id: 'zeus', adminOnly: true } }

function setup() {
  const ledger = new LedgerService(new SqliteLedgerRepository(), { get: (id) => AGENTS[id] })
  const [read, write] = makeLedgerTools(ledger)
  return { ledger, read, write }
}

/** O contexto do turno, como o servidor o monta: é ELE que diz quem chama. */
const turn = (agentId: string, extra: Record<string, string> = {}) => ({ agentId, sessionId: `conv-${agentId}`, ...extra })

const CREATE = { tema: 'build-oom', acao: 'criar', gatilho: 'quando o build estourar memória no CI' }

describe('ledger_read / ledger_write', () => {
  it('são exatamente duas, com as ações do ledger_write num campo `acao`', () => {
    const { read, write } = setup()
    assert.deepStrictEqual([read.name, write.name], ['ledger_read', 'ledger_write'])
    assert.deepStrictEqual(write.inputSchema.properties.acao.enum, ['criar', 'gatilho', 'playbook', 'linha_nova', 'linha_editar', 'linha_apagar', 'excluir'])
    assert.deepStrictEqual(write.inputSchema.required, ['tema', 'acao'])
    assert.ok(!('agente' in write.inputSchema.properties), 'a escrita não tem campo de agente')
  })

  it('⛔ o dono é o agente do TURNO: grava no ledger dele, com a conversa na revisão', async () => {
    const { ledger, write } = setup()
    const created = await write.execute(CREATE, turn('theo'))
    assert.strictEqual(created.status, 'success')
    assert.ok(created.result.startsWith('Gravado: criar em build-oom.'))
    assert.deepStrictEqual(ledger.revisions('theo', 'build-oom')[0].by, { kind: 'agent', agentId: 'theo', conversationId: 'conv-theo' })
    assert.deepStrictEqual(ledger.index('ana').contexts, [])
  })

  it('⛔ escrever no ledger de OUTRO agente é recusado, mesmo com o argumento dizendo que é dele', async () => {
    const { ledger, write } = setup()
    for (const claim of [{ agente: 'ana' }, { agentId: 'ana' }]) {
      const refused = await write.execute({ ...CREATE, ...claim }, turn('theo'))
      assert.strictEqual(refused.status, 'error')
      assert.ok(refused.result.includes('só escreve no SEU ledger'))
    }
    assert.deepStrictEqual(ledger.index('ana').contexts, [])
    assert.deepStrictEqual(ledger.index('theo').contexts, [])
    // O próprio id no argumento não atrapalha.
    assert.strictEqual((await write.execute({ ...CREATE, agente: 'theo' }, turn('theo'))).status, 'success')
  })

  it('⛔ sem o agente do turno não há dono: as duas recusam', async () => {
    const { read, write } = setup()
    assert.strictEqual((await write.execute(CREATE)).status, 'error')
    assert.strictEqual((await read.execute({}, { sessionId: 'x' })).status, 'error')
  })

  it('cada ação pela ferramenta: criar, gatilho, playbook, linha_nova, linha_editar, linha_apagar, excluir', async () => {
    const { ledger, write, read } = setup()
    const as = (args: Record<string, unknown>) => write.execute(args, turn('theo'))
    assert.strictEqual((await as(CREATE)).status, 'success')
    assert.strictEqual((await as({ tema: 'build-oom', acao: 'gatilho', gatilho: 'quando o build do front estourar memória' })).status, 'success')
    assert.strictEqual((await as({ tema: 'build-oom', acao: 'playbook', playbook: '## Heap\n- 4 GB' })).status, 'success')
    const added = await as({ tema: 'build-oom', acao: 'linha_nova', tipo: 'APRENDIZADO', situacao: 'build no CI', aprendizado: 'subir o heap para 4 GB', ref: 'ci.yml' })
    assert.strictEqual(added.status, 'success')
    const id = ledger.context('theo', 'build-oom').lines[0].id
    assert.ok(added.result.includes(`#${id} [`))
    assert.strictEqual((await as({ tema: 'build-oom', acao: 'linha_editar', linha: id, aprendizado: 'subir o heap para 6 GB' })).status, 'success')
    assert.strictEqual(ledger.context('theo', 'build-oom').lines[0].learning, 'subir o heap para 6 GB')
    // O id como o `ledger_read` o mostra (`#12`) também vale.
    assert.strictEqual((await as({ tema: 'build-oom', acao: 'linha_apagar', linha: `#${id}` })).status, 'success')
    assert.deepStrictEqual(ledger.context('theo', 'build-oom').lines, [])
    const whole = await read.execute({ tema: 'build-oom' }, turn('theo'))
    assert.ok(whole.result.includes('Gatilho: quando o build do front estourar memória'))
    assert.ok(whole.result.includes('## Playbook\n## Heap'))
    assert.strictEqual((await as({ tema: 'build-oom', acao: 'excluir' })).status, 'success')
    assert.deepStrictEqual(
      ledger.revisions('theo', 'build-oom').map((revision) => revision.action),
      ['excluir', 'linha_apagar', 'linha_editar', 'linha_nova', 'playbook', 'gatilho', 'criar'],
    )
  })

  it('a validação volta com os nomes dos argumentos', async () => {
    const { write } = setup()
    const short = await write.execute({ tema: 'x-y', acao: 'criar', gatilho: 'curto' }, turn('theo'))
    assert.strictEqual(short.status, 'error')
    assert.ok(short.result.startsWith('Não gravado: gatilho: too short'))
    await write.execute(CREATE, turn('theo'))
    const line = await write.execute({ tema: 'build-oom', acao: 'linha_nova', tipo: 'OUTRO', situacao: 'a\nb', aprendizado: '' }, turn('theo'))
    assert.ok(line.result.includes('tipo: one of APRENDIZADO, POSTURA, DIFICULDADE'))
    assert.ok(line.result.includes('situacao: must be a single line'))
    assert.ok(line.result.includes('aprendizado: required'))
    assert.strictEqual((await write.execute({ tema: 'build-oom', acao: 'apagar-tudo' }, turn('theo'))).status, 'error')
  })

  it('ledger_read sem argumento: o índice com os avisos de saúde; com busca: as linhas que casam', async () => {
    const { read, write } = setup()
    const empty = await read.execute({}, turn('theo'))
    assert.ok(empty.result.includes('vazio'))
    await write.execute({ tema: 'deploy', acao: 'criar', gatilho: 'RETOMAR o deploy de produção amanhã' }, turn('theo'))
    await write.execute(CREATE, turn('theo'))
    await write.execute({ tema: 'build-oom', acao: 'linha_nova', tipo: 'regra', situacao: 'compilação no CI', aprendizado: 'subir o heap' }, turn('theo'))
    const index = await read.execute({}, turn('theo'))
    assert.ok(index.result.includes('- build-oom — quando o build estourar memória no CI (1 linha'))
    assert.ok(index.result.includes('Saúde:'))
    assert.ok(index.result.includes('⚠️ deploy: o gatilho tem "retomar"'))
    const found = await read.execute({ busca: 'compilacao' }, turn('theo'))
    assert.ok(found.result.includes('- build-oom #'))
    assert.ok(found.result.includes('APRENDIZADO/REGRA | compilação no CI | subir o heap'))
  })

  it('ledger_read { agente }: lê o de outro que enxerga, marcado como só leitura; o que não enxerga, como inexistente', async () => {
    const { read, write } = setup()
    await write.execute(CREATE, turn('theo'))
    await write.execute({ tema: 'crm-sync', acao: 'criar', gatilho: 'quando a sincronia do CRM falhar' }, turn('ana'))
    await write.execute({ tema: 'god-mode', acao: 'criar', gatilho: 'quando mexer em tudo de uma vez' }, turn('zeus'))

    const global = await read.execute({ agente: 'theo' }, turn('ana', { conversationProjectId: 'xpto' }))
    assert.strictEqual(global.status, 'success')
    assert.ok(global.result.startsWith('Ledger de theo (somente leitura)'))
    const one = await read.execute({ agente: 'theo', tema: 'build-oom' }, turn('ana'))
    assert.ok(one.result.includes('(ledger de theo, somente leitura)'))

    // Projeto: só na conversa do projeto dele.
    assert.strictEqual((await read.execute({ agente: 'ana' }, turn('theo'))).status, 'error')
    assert.strictEqual((await read.execute({ agente: 'ana' }, turn('theo', { conversationProjectId: 'xpto' }))).status, 'success')
    // Só-admin: não.
    const hidden = await read.execute({ agente: 'zeus' }, turn('theo'))
    assert.deepStrictEqual(hidden, { status: 'error', result: 'Agent not found: zeus' })
  })
})
