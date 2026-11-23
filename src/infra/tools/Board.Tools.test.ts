import assert from 'node:assert'
import { describe, it } from 'node:test'
import { emptyPanel, IConversationPanel, panelTurnNote } from '@domain/models/ConversationPanel.Model'
import { deprecatedCitedIn, deprecationLine, DEPRECATED_TOOLS } from '@domain/Tool.Deprecations'
import { ambientSection } from '@domain/Ambient.Policy'
import { makeLocalTools } from './Local.Tools'

/** O board, o alias obsoleto e o plano, como o agente os chama. */
describe('board e plan — as ferramentas da conversa', () => {
  const store = () => {
    let panel: IConversationPanel = emptyPanel()
    const tools = makeLocalTools({ panels: { get: async () => panel, save: async (_id, next) => void (panel = next), turnOf: () => 3 } })
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!
    return { tool, panel: () => panel }
  }
  const context = { sessionId: 'gw_1', agentId: 'maya' }

  it('`board` grava; o alias `conversation_panel` faz o mesmo e avisa que é obsoleto', async () => {
    const { tool, panel } = store()
    assert.strictEqual((await tool('board').execute({ op: 'add', title: 'Ledgers' }, context)).status, 'success')
    const legacy = await tool('conversation_panel').execute({ op: 'add', title: 'Specs' }, context)
    assert.strictEqual(legacy.status, 'success')
    assert.match(String(legacy.result), /^\[deprecated\] `conversation_panel` is an alias of `board` and will be removed in 1\.0\.0/)
    assert.match(tool('conversation_panel').description, /DEPRECATED alias of `board`/)
    assert.deepStrictEqual(
      panel().items.map((item) => item.title),
      ['Ledgers', 'Specs'],
    )
    assert.strictEqual((await tool('board').execute({ op: 'plan_create', title: 't', body: 'b' }, context)).status, 'error', 'plano é do `plan`')
  })

  it('`plan`: cria, envia, e o agente registra a aprovação dada no chat (citando); os passos entram no board', async () => {
    const { tool, panel } = store()
    const plan = tool('plan')
    const created = await plan.execute({ op: 'create', title: 'Migração', body: '## Contexto\nx', steps: [{ title: 'Exportar' }, { title: 'Importar' }] }, context)
    assert.match(String(created.result), /Saved: plano pl1 criado/)
    assert.strictEqual((await plan.execute({ op: 'submit', id: 'pl1' }, context)).status, 'success')
    assert.strictEqual((await plan.execute({ op: 'approve', id: 'pl1' }, context)).status, 'error', 'sem citar a pessoa')
    assert.strictEqual((await plan.execute({ op: 'approve', id: 'pl1', note: '"pode seguir"' }, context)).status, 'success')
    assert.deepStrictEqual(
      panel().items.map((item) => [item.id, item.plan?.step]),
      [
        ['p1', 's1'],
        ['p2', 's2'],
      ],
    )
    assert.match(String((await plan.execute({ op: 'read', id: 'pl1' }, context)).result), /^# pl1 · Migração/)
    assert.strictEqual((await plan.execute({ op: 'add_steps', id: 'pl1', steps: [{ title: 'Conferir' }], note: 'pedido no chat' }, context)).status, 'success')
    assert.deepStrictEqual(panel().items.at(-1)?.plan, { id: 'pl1', step: 's3' })
    assert.strictEqual((await plan.execute({ op: 'changes', id: 'pl1', text: 'x' }, context)).status, 'error', 'pedir ajustes é da pessoa')
    assert.strictEqual((await plan.execute({ op: 'read' }, { agentId: 'maya' })).status, 'error', 'fora de conversa')
  })
})

describe('board e plan — leitura compacta', () => {
  const seed = async (count: number) => {
    let panel: IConversationPanel = emptyPanel()
    const tools = makeLocalTools({ panels: { get: async () => panel, save: async (_id, next) => void (panel = next), turnOf: () => 3 } })
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!
    const ctx = { sessionId: 'gw_1', agentId: 'maya' }
    const board = (args: Record<string, unknown>) => tool('board').execute(args, ctx)
    for (let index = 1; index <= count; index++) await board({ op: 'add', title: `Tarefa ${index}`, detail: `DETALHE-${index}`, status: index % 5 === 0 ? 'done' : 'queued' })
    return { board, plan: (args: Record<string, unknown>) => tool('plan').execute(args, ctx), panel: () => panel }
  }
  const lines = (text: unknown) =>
    String(text)
      .split('\n')
      .filter((line) => /^- p\d+ /.test(line))

  it('`read` lista uma linha por item, sem detalhe, com totais e paginação', async () => {
    const { board } = await seed(70)
    await board({ op: 'set_goal', goal: 'Migrar tudo' })
    const first = String((await board({ op: 'read' })).result)
    assert.match(first, /^Objetivo: Migrar tudo\nItens: 70 \(queued 56, done 14\)/)
    assert.match(first, /página 1 de 3 \(70 no filtro\) — próxima: board read page=2/)
    assert.strictEqual(lines(first).length, 30)
    assert.ok(!first.includes('DETALHE'))
    assert.strictEqual(lines((await board({ op: 'read', page: 2 })).result).length, 30)
    const last = String((await board({ op: 'read', page: 3 })).result)
    assert.strictEqual(lines(last).length, 10)
    assert.doesNotMatch(last, /próxima/)
    assert.strictEqual((await board({ op: 'read', page: 4 })).status, 'error')
    assert.strictEqual(lines((await board({ op: 'read', limit: 500 })).result).length, 70, 'o teto é 100')
    assert.strictEqual(lines((await board({ op: 'read', limit: 1000, page: 1 })).result).length, 70)
    const small = String((await board({ op: 'read', limit: 5 })).result)
    assert.match(small, /página 1 de 14 .*board read limit=5 page=2/)
  })

  it('o teto do `limit` é 100', async () => {
    const { board } = await seed(120)
    const result = String((await board({ op: 'read', limit: 500 })).result)
    assert.strictEqual(lines(result).length, 100)
    assert.match(result, /página 1 de 2/)
  })

  it('filtra por status (um ou vários) e por `q`', async () => {
    const { board } = await seed(10)
    await board({ op: 'update', id: 'p1', status: 'doing' })
    await board({ op: 'update', id: 'p2', status: 'blocked' })
    assert.deepStrictEqual(lines((await board({ op: 'read', status: 'doing' })).result), ['- p1 [doing] Tarefa 1'])
    const both = lines((await board({ op: 'read', status: ['doing', 'blocked'] })).result)
    assert.deepStrictEqual(both, ['- p1 [doing] Tarefa 1', '- p2 [blocked] Tarefa 2'])
    const done = String((await board({ op: 'read', status: ['done'], limit: 1 })).result)
    assert.match(done, /board read status=done limit=1 page=2/)
    assert.deepStrictEqual(lines((await board({ op: 'read', q: 'TAREFA 10' })).result), ['- p10 [done] Tarefa 10'])
    assert.match(String((await board({ op: 'read', q: 'nada' })).result), /Nada encontrado/)
    assert.strictEqual((await board({ op: 'read', status: 'xx' })).status, 'error')
  })

  it('seções: decisões e perguntas, uma linha cada, as abertas primeiro', async () => {
    const { board } = await seed(2)
    await board({ op: 'decide', text: 'Usar SQLite', why: 'simples' })
    await board({ op: 'ask', text: 'Qual porta?' })
    await board({ op: 'ask', text: 'Qual banco?' })
    await board({ op: 'answer', id: 'q1', answer: '27017' })
    const decisions = String((await board({ op: 'read', section: 'decisions' })).result)
    assert.match(decisions, /\n- d1 Usar SQLite\n/)
    assert.ok(!decisions.includes('simples') && !decisions.includes('Tarefa 1'))
    const questions = String((await board({ op: 'read', section: 'questions' })).result).split('\n')
    const rows = questions.filter((line) => line.startsWith('- q'))
    assert.deepStrictEqual(rows, ['- q2 [aberta] Qual banco?', '- q1 [respondida] Qual porta? → 27017'])
    assert.strictEqual((await board({ op: 'read', section: 'nope' })).status, 'error')
  })

  it('`get`: item inteiro, pergunta, decisão e id desconhecido', async () => {
    const { board } = await seed(1)
    await board({ op: 'update', id: 'p1', status: 'done', note: 'entregue', links: [{ label: 'PR', href: 'https://x/1' }], delegatedTo: { agentId: 'zeus', sessionId: 'gw_2' } })
    await board({ op: 'decide', text: 'Usar SQLite', why: 'simples' })
    await board({ op: 'ask', text: 'Qual porta?' })
    const item = String((await board({ op: 'get', id: 'p1' })).result)
    for (const part of ['p1 Tarefa 1', 'Status: done', 'Detalhe: DETALHE-1', 'Nota: entregue', '[PR](https://x/1)', 'Com: zeus (gw_2)', 'Mudou: '])
      assert.ok(item.includes(part), part)
    assert.match(String((await board({ op: 'get', id: 'd1' })).result), /d1 decisão: Usar SQLite\nMotivo: simples/)
    assert.match(String((await board({ op: 'get', id: 'q1' })).result), /q1 pergunta: Qual porta\?\nEm aberto\./)
    const missing = await board({ op: 'get', id: 'p99' })
    assert.strictEqual(missing.status, 'error')
    assert.strictEqual((await board({ op: 'get' })).status, 'error')
  })

  it('as gravações devolvem só a linha do que mudou', async () => {
    const { board } = await seed(5)
    const others = (text: unknown) => assert.ok(!/Tarefa [1-5]\b/.test(String(text).replace(/Tarefa 9/g, '')), String(text))
    const added = await board({ op: 'add', title: 'Nova', detail: 'x' })
    assert.strictEqual(added.result, 'Saved: p6 Nova (na fila)\n- p6 [queued] Nova')
    others(added.result)
    const updated = String((await board({ op: 'update', id: 'p2', status: 'doing' })).result)
    assert.strictEqual(updated, 'Saved: p2 Tarefa 2 (em andamento)\n- p2 [doing] Tarefa 2')
    assert.strictEqual(String((await board({ op: 'move', id: 'p6', before: 'p1' })).result).split('\n').length, 2)
    assert.strictEqual(String((await board({ op: 'set_goal', goal: 'Meta' })).result), 'Saved: objetivo: Meta\nObjetivo: Meta')
    for (const args of [
      { op: 'decide', text: 'D' },
      { op: 'ask', text: 'Q?' },
      { op: 'answer', id: 'q1', answer: 'A' },
    ]) {
      const result = String((await board(args)).result)
      assert.strictEqual(result.split('\n').length, 2, result)
      assert.ok(!result.includes('Tarefa'), result)
    }
  })

  it('`plan`: lista com uma linha por plano, `read id` traz o plano inteiro, gravar devolve uma linha', async () => {
    const { plan } = await seed(0)
    const created = String((await plan({ op: 'create', title: 'Migração', body: 'CORPO-UM', steps: [{ title: 'A' }, { title: 'B' }] })).result)
    assert.match(created, /^Saved: plano pl1 criado: Migração \(2 passos\)\n- pl1 Migração \(.+\) — 2 passos, 0 prontos$/)
    assert.ok(!created.includes('CORPO-UM'))
    const second = String((await plan({ op: 'create', title: 'Outro', body: 'CORPO-DOIS' })).result)
    assert.ok(!second.includes('CORPO-UM') && !second.includes('Migração'))
    const list = String((await plan({ op: 'read' })).result)
    assert.match(list, /Planos: 2 · página 1 de 1/)
    assert.ok(!list.includes('CORPO'))
    assert.strictEqual(list.split('\n').filter((line) => line.startsWith('- pl')).length, 2)
    const paged = String((await plan({ op: 'read', limit: 1 })).result)
    assert.match(paged, /página 1 de 2 — próxima: plan read page=2 limit=1/)
    assert.match(String((await plan({ op: 'read', id: 'pl2' })).result), /CORPO-DOIS/)
    assert.strictEqual((await plan({ op: 'read', id: 'pl9' })).status, 'error')
  })

  it('o aviso do começo do turno limita 15 por grupo e diz como ver o resto', async () => {
    const { panel, board } = await seed(40)
    for (let index = 1; index <= 17; index++) await board({ op: 'ask', text: `Pergunta ${index}` })
    const note = panelTurnNote(panel())
    assert.strictEqual(note.split('\n').filter((line) => /^- p\d+ /.test(line)).length, 15)
    assert.match(note, /\+17: board read status=queued limit=15 page=2/)
    assert.strictEqual(note.split('\n').filter((line) => /^- q\d+ /.test(line)).length, 15)
    assert.match(note, /\+2: board read section=questions limit=15 page=2/)
    const small = panelTurnNote((await seed(3)).panel())
    assert.doesNotMatch(small, /\+\d+:/)
  })
})

describe('Tool.Deprecations — as ferramentas obsoletas', () => {
  it('cada uma diz o substituto e a versão em que sai; o talk de antes está registrado', () => {
    for (const tool of DEPRECATED_TOOLS) assert.ok(tool.replacement && tool.removeIn && tool.since, tool.name)
    assert.deepStrictEqual(
      DEPRECATED_TOOLS.filter((tool) => tool.replacement === 'talk').map((tool) => tool.name),
      ['delegate_to_agent', 'start_conversation', 'send_message', 'get_turn'],
    )
  })

  it('o prompt que cita uma obsoleta de agente ganha a linha no Ambiente; a do MCP não conta', () => {
    const cited = deprecatedCitedIn('Use conversation_panel e delegate_to_agent; send_message também.')
    assert.deepStrictEqual(
      cited.map((tool) => tool.name),
      ['conversation_panel', 'delegate_to_agent'],
    )
    assert.deepStrictEqual(deprecatedCitedIn('my_conversation_panels'), [])
    const ambient = ambientSection({ agentId: 'maya', talk: true, deprecated: cited })
    assert.ok(ambient.includes(deprecationLine(cited[0])))
    assert.match(ambient, /Onde o seu prompt diz `delegate_to_agent`, use `talk` — `delegate_to_agent` está obsoleta e sai na versão 1\.0\.0\./)
  })
})
