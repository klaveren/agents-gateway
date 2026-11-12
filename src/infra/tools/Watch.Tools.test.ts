import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IWatchConversation, WatchService } from '@application/Watch.Service'
import { WAKE_ME_TOOL, WATCH_LIST_TOOL, WATCH_START_TOOL, WATCH_STOP_TOOL, WATCH_TOOLS } from '@domain/models/Watch.Model'
import { SqliteWatchRepository } from '@infra/persistence/Sqlite.WatchRepository'
import { IToolResult } from './Tool.Types'
import { makeWatchTools, WatchDesk, watchVerdict } from './Watch.Tools'

const NOW = new Date('2026-01-01T10:00:00Z')
const ok = (result: string): IToolResult => ({ status: 'success', result })
const fail = (result: string): IToolResult => ({ status: 'error', result })

const setup = (options: { maxActive?: number; bash?: boolean } = {}) => {
  let next = 0
  const outcomes: IToolResult[] = []
  const ran: string[] = []
  const conversations = new Map<string, IWatchConversation>([
    ['s1', { agentId: 'a', ownerId: 'u', delegated: false, archived: false }],
    ['filha', { agentId: 'sub', ownerId: 'u', delegated: true, archived: false }],
  ])
  const desk = new WatchDesk()
  const service = new WatchService({
    repository: new SqliteWatchRepository(),
    conversation: async (id) => conversations.get(id),
    ownerActive: () => true,
    now: () => NOW,
    newId: () => `w-${++next}`,
    ...(options.maxActive ? { maxActive: () => options.maxActive! } : {}),
  })
  service.useCheck((watch) => desk.check(watch.command ?? '', { sessionId: watch.sessionId, agentId: watch.agentId }))
  desk.bind(service)
  if (options.bash !== false)
    desk.useBash(async (command) => {
      ran.push(command)
      return outcomes.shift() ?? fail('Exit code 1: ')
    })
  const tools = new Map(makeWatchTools(desk, () => NOW).map((tool) => [tool.name, tool]))
  const call = (name: string, args: Record<string, unknown> = {}, sessionId: string | null = 's1') => tools.get(name)!.execute(args, sessionId ? { sessionId } : {})
  return { service, desk, outcomes, ran, call }
}

const start = { label: 'servidor voltar', command: 'curl -sf http://localhost/health', then: 'avisar a pessoa' }

describe('watchVerdict', () => {
  it('saiu com 0 = aconteceu; outro código = ainda não', () => {
    assert.deepStrictEqual(watchVerdict(ok('pronto')), { verdict: 'met', output: 'pronto' })
    assert.strictEqual(watchVerdict(fail('Exit code 1: ')).verdict, 'unmet')
    assert.strictEqual(watchVerdict(fail('saída\nExit code 7: falhou')).verdict, 'unmet')
  })

  it('⛔ 126, 127 e qualquer recusa = a conferência não roda; o tempo esgotado é à parte', () => {
    assert.strictEqual(watchVerdict(fail('Exit code 127: comando não encontrado')).verdict, 'refused')
    assert.strictEqual(watchVerdict(fail('Exit code 126: sem permissão')).verdict, 'refused')
    assert.strictEqual(watchVerdict(fail('Not permitted: rm -rf')).verdict, 'refused')
    assert.strictEqual(watchVerdict(fail('Tempo esgotado após 30 s')).verdict, 'timeout')
  })
})

describe('Watch.Tools', () => {
  it('são as quatro do modelo, todas locais', () => {
    const tools = makeWatchTools(new WatchDesk())
    assert.deepStrictEqual(
      tools.map((tool) => tool.name),
      [...WATCH_TOOLS],
    )
    assert.ok(tools.every((tool) => tool.origin === 'local'))
  })

  it('watch_start confere na hora e arma; watch_list mostra; watch_stop cancela', async () => {
    const { call, ran } = setup()
    const armed = await call(WATCH_START_TOOL, start)
    assert.strictEqual(armed.status, 'success')
    assert.match(armed.result, /^Vigia armada \(w-1\): "servidor voltar"\. A conferência rodou agora e ainda não passou\./)
    assert.match(armed.result, /confere a cada 60 s, por até 1 h/)
    assert.deepStrictEqual(ran, [start.command])

    const listed = await call(WATCH_LIST_TOOL)
    assert.strictEqual(listed.result, 'w-1 · servidor voltar · confere a cada 60 s · prazo em 1 h · 1 conferência(s)')

    assert.deepStrictEqual(await call(WATCH_STOP_TOOL, { id: 'w-1' }), ok('Vigia cancelada: "servidor voltar".'))
    assert.match((await call(WATCH_LIST_TOOL)).result, /^w-1 · servidor voltar · cancelada/)
    const again = await call(WATCH_STOP_TOOL, { id: 'w-1' })
    assert.strictEqual(again.status, 'error')
    assert.match(again.result, /Não há vigia ativa com o id "w-1"/)
  })

  it('o que já aconteceu não arma nada, e diz para seguir', async () => {
    const { call, outcomes } = setup()
    outcomes.push(ok('HTTP 200'))
    const result = await call(WATCH_START_TOOL, start)
    assert.strictEqual(result.status, 'success')
    assert.match(result.result, /^Já aconteceu: a conferência passou agora, nenhuma vigia foi armada\./)
    assert.match(result.result, /Saída da conferência:\nHTTP 200$/)
    assert.strictEqual((await call(WATCH_LIST_TOOL)).result, 'Nenhuma vigia nesta conversa.')
  })

  it('⛔ o comando recusado volta como erro, com o motivo, e nada é armado', async () => {
    const { call, outcomes } = setup()
    outcomes.push(fail('Not permitted: curl'))
    assert.deepStrictEqual(await call(WATCH_START_TOOL, start), fail('Not permitted: curl'))
    assert.strictEqual((await call(WATCH_LIST_TOOL)).result, 'Nenhuma vigia nesta conversa.')
  })

  it('sem terminal para conferir, watch_start recusa apontando o wake_me', async () => {
    const { call } = setup({ bash: false })
    const result = await call(WATCH_START_TOOL, start)
    assert.strictEqual(result.status, 'error')
    assert.match(result.result, /use wake_me/)
  })

  it('wake_me arma o despertador sem conferir nada', async () => {
    const { call, ran } = setup()
    const result = await call(WAKE_ME_TOOL, { label: 'ticket fechar', afterMinutes: 30, then: 'conferir o ticket' })
    assert.strictEqual(result.status, 'success')
    assert.match(result.result, /^Despertador armado \(w-1\): "ticket fechar", daqui a 30 min\./)
    assert.deepStrictEqual(ran, [])
    assert.strictEqual((await call(WATCH_LIST_TOOL)).result, 'w-1 · ticket fechar · acorda em 30 min')
  })

  it('entrada errada volta com o que corrigir', async () => {
    const { call } = setup()
    const start = await call(WATCH_START_TOOL, { label: '', command: 'true', then: 'x', everySeconds: 1 })
    assert.strictEqual(start.status, 'error')
    assert.match(start.result, /^Corrija e chame de novo:\n- /)
    const wake = await call(WAKE_ME_TOOL, { label: 'x', afterMinutes: 1, then: 'y' })
    assert.strictEqual(wake.status, 'error')
    assert.match(wake.result, /^Corrija e chame de novo:\n- /)
  })

  it('⛔ conversa de delegação não arma vigia nem despertador', async () => {
    const { call, ran } = setup()
    for (const result of [await call(WATCH_START_TOOL, start, 'filha'), await call(WAKE_ME_TOOL, { label: 'x', afterMinutes: 10, then: 'y' }, 'filha')]) {
      assert.strictEqual(result.status, 'error')
      assert.match(result.result, /Conversa de delegação não arma vigia/)
    }
    assert.deepStrictEqual(ran, [])
  })

  it('o teto por conversa recusa a sexta', async () => {
    const { call } = setup()
    for (let index = 0; index < 5; index++) assert.strictEqual((await call(WAKE_ME_TOOL, { label: `v${index}`, afterMinutes: 10, then: 'y' })).status, 'success')
    assert.strictEqual((await call(WAKE_ME_TOOL, { label: 'a sexta', afterMinutes: 10, then: 'y' })).status, 'error')
  })

  it('fora de uma conversa, ou sem o serviço, cada uma diz por quê', async () => {
    const { call } = setup()
    for (const name of WATCH_TOOLS) assert.deepStrictEqual(await call(name, { ...start, afterMinutes: 10, id: 'w-1' }, null), fail('A vigia só funciona dentro de uma conversa.'))
    for (const tool of makeWatchTools(new WatchDesk())) assert.deepStrictEqual(await tool.execute({}, { sessionId: 's1' }), fail('As vigias não estão ligadas neste gateway.'))
  })
})
