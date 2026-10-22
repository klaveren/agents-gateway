import assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { IConversationTurn } from '@domain/models/Conversation.Model'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { withCaller } from '@infra/mcp/Caller.Identity'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { Request, Response } from 'express'
import { AgentController } from './Agent.Controller'
import { ICallerProof } from './Caller.Proof'

interface IBody {
  ok: boolean
  message?: string
  code?: string
  result?: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * As rotas de conversa gravada, contra o SQLite de verdade (em memória): o que se quer provar aqui é
 * quem vê o quê, e isso depende do recorte por dono que o banco faz.
 */
describe('AgentController — conversas, monitor e compartilhamento', () => {
  const proof: ICallerProof = { prove: async (token) => token.startsWith('good-') }
  const ALICE = { token: 'good-alice', id: 'alice', email: 'alice@x.test', account: 'acc-1' }
  const BOB = { token: 'good-bob', id: 'bob', email: 'bob@x.test', account: 'acc-1' }
  const ADMIN = { token: 'good-root', id: 'root', email: 'root@x.test', role: 'admin' }
  const FORGED_ADMIN = { token: 'forged-root', id: 'root', role: 'admin' }

  afterEach(() => {
    for (const name of ['ADMIN_ROLES', 'ADMIN_USERS', 'REQUIRE_PROVEN_OWNER']) delete process.env[name]
  })

  const fakeCatalog = () =>
    ({
      mcpUrl: '',
      mcpConnected: false,
      mcpEndpoint: async () => undefined,
      list: async () => [],
      invoke: async () => ({ status: 'success', result: '' }),
    }) as unknown as ToolCatalog

  const build = (extra: { pricing?: Record<string, { input: number; output: number }>; proof?: ICallerProof | null } = {}) => {
    const conversations = new SqliteConversationRepository(':memory:')
    const provider = {
      createSession: async () => ({ id: 'x', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
      sendMessage: async function* () {},
      cancel: async () => {},
      dispose: async () => {},
      describe: () => ({}),
      list: () => [],
    } as unknown as IAgentProvider

    const controller = new AgentController({
      catalog: fakeCatalog(),
      createSession: new CreateSessionUseCase(provider),
      sendMessage: new SendMessageUseCase(provider, conversations),
      cancelSession: new CancelSessionUseCase(provider),
      deleteSession: new DeleteSessionUseCase(provider),
      getSession: new GetSessionUseCase(provider),
      listSessions: new ListSessionsUseCase(provider),
      proof: extra.proof === null ? undefined : (extra.proof ?? proof),
      settings: new NullSettingsRepository(),
      conversations,
      pricing: extra.pricing,
    })

    return { controller, conversations }
  }

  const request = (over: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {}) =>
    ({ params: over.params ?? {}, query: over.query ?? {}, body: over.body ?? {}, headers: {} }) as unknown as Request

  const call = async (identity: object | undefined, run: (res: Response) => Promise<void>) => {
    const out = { status: 200, body: undefined as IBody | undefined }
    const res = {
      status(code: number) {
        out.status = code
        return this
      },
      json(data: IBody) {
        out.body = data
        return this
      },
    } as unknown as Response

    await (identity ? withCaller(identity, () => run(res)) : run(res))

    return out
  }

  const turnOf = (sessionId: string, over: Partial<IConversationTurn> = {}): IConversationTurn => ({
    sessionId,
    index: 0,
    at: new Date('2026-09-01T10:01:00Z'),
    request: 'qual o estoque?',
    text: 'Há 10 unidades.',
    reasoning: 'vou consultar',
    toolCalls: [{ tool: 'stock_lookup', args: { sku: 'S1' }, result: { secret: 'dado-cru-123' } }],
    usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
    ...over,
  })

  /** Alice com duas conversas, Bob com uma, e uma sem dono. O modelo da da Alice tem preço; o da do Bob não. */
  const seed = async (repo: SqliteConversationRepository) => {
    const base = { agentId: 'researcher-agent', provider: 'google', mode: 'chat', turns: 1, createdAt: new Date('2026-09-01T10:00:00Z') }
    const rows = [
      {
        id: 'a1',
        title: 'Pedido da Alice',
        model: 'claude-sonnet-5',
        provider: 'claude',
        metadata: { owner: { id: 'alice', email: 'alice@x.test', account: 'acc-1' }, app: 'web' },
        at: '10:05',
      },
      {
        id: 'a2',
        title: 'Outra da Alice',
        model: 'claude-sonnet-5',
        provider: 'claude',
        metadata: { owner: { id: 'alice', email: 'alice@x.test', account: 'acc-1' }, app: 'mobile' },
        at: '10:04',
      },
      {
        id: 'b1',
        title: 'Conversa do Bob',
        model: 'modelo-sem-preco',
        provider: 'google',
        metadata: { owner: { id: 'bob', email: 'bob@x.test', account: 'acc-1' }, app: 'web' },
        at: '10:03',
      },
      { id: 'n1', title: 'Sem dono', model: 'claude-sonnet-5', provider: 'claude', metadata: undefined, at: '10:02' },
    ]

    for (const { id, title, model, provider, metadata, at } of rows) {
      const updatedAt = new Date(`2026-09-01T${at}:00Z`)
      await repo.saveSession({ ...base, id, title, model, provider, metadata, updatedAt, usage: { inputTokens: 1_000_000, outputTokens: 100_000 } })
      await repo.appendTurn(turnOf(id))
    }
    await repo.classifyTurn('a1', 0, 'red')
    await repo.classifyTurn('b1', 0, 'green')
  }

  const setup = async () => {
    const built = build()
    await seed(built.conversations)

    return built
  }

  const ids = (body: IBody | undefined) => (body?.result.sessions as Array<{ id: string }>).map((item) => item.id)

  describe('GET /conversations — as do próprio chamador', () => {
    it('lista só as dele, e o chamador anônimo só as sem dono', async () => {
      const { controller } = await setup()

      assert.deepStrictEqual(ids((await call(ALICE, (res) => controller.listConversations(request(), res))).body), ['a1', 'a2'])
      assert.deepStrictEqual(ids((await call(BOB, (res) => controller.listConversations(request(), res))).body), ['b1'])
      assert.deepStrictEqual(ids((await call(undefined, (res) => controller.listConversations(request(), res))).body), ['n1'])
    })

    it('⛔ `owner` na query não vira dono: nem como filtro nem como identidade', async () => {
      const { controller } = await setup()

      for (const query of [{ owner: 'bob' }, { 'owner.id': 'bob' }, { ownerId: 'bob' }, { OWNER: 'bob' }]) {
        const out = await call(ALICE, (res) => controller.listConversations(request({ query }), res))
        assert.deepStrictEqual(ids(out.body), ['a1', 'a2'], JSON.stringify(query))
      }
    })

    it('o resto da query filtra por rótulo do metadata, e `limit` limita', async () => {
      const { controller } = await setup()

      assert.deepStrictEqual(ids((await call(ALICE, (res) => controller.listConversations(request({ query: { app: 'mobile' } }), res))).body), ['a2'])
      assert.deepStrictEqual(ids((await call(ALICE, (res) => controller.listConversations(request({ query: { limit: '1' } }), res))).body), ['a1'])
      // Chave que não é identificador simples não vira SQL: é ignorada (e avisada), nunca interpretada.
      assert.deepStrictEqual(ids((await call(ALICE, (res) => controller.listConversations(request({ query: { "a') = 'x' OR ('1": '1' } }), res))).body), ['a1', 'a2'])
    })

    it('⛔ sem custo nem rótulo para o dono — nem quando o dono é administrador', async () => {
      const { controller, conversations } = await setup()
      await conversations.saveSession({
        id: 'r1',
        agentId: 'x',
        provider: 'claude',
        mode: 'chat',
        model: 'claude-sonnet-5',
        turns: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        usage: { inputTokens: 1000 },
        metadata: { owner: { id: 'root', email: 'root@x.test' } },
      })

      for (const identity of [ALICE, ADMIN]) {
        const out = await call(identity, (res) => controller.listConversations(request(), res))
        const text = JSON.stringify(out.body)

        assert.strictEqual(out.status, 200)
        assert.ok(!text.includes('costUsd') && !text.includes('classification'), text)
      }
    })

    it('credencial forjada é 401, e o dono é descrito pela prova, não pelo que o token afirma', async () => {
      const { controller } = await setup()

      assert.strictEqual((await call({ token: 'forged-alice', id: 'alice', account: 'acc-1' }, (res) => controller.listConversations(request(), res))).status, 401)
    })

    it('mostra o shareId só enquanto a conversa está aberta', async () => {
      const { controller, conversations } = await setup()
      await conversations.setShared('a1', true, 'link-a1')
      await conversations.setShared('a2', true, 'link-a2')
      await conversations.setShared('a2', false)

      const sessions = (await call(ALICE, (res) => controller.listConversations(request(), res))).body?.result.sessions as Array<{ id: string; shared: boolean; shareId?: string }>

      assert.deepStrictEqual(
        sessions.map((item) => [item.id, item.shared, item.shareId]),
        [
          ['a1', true, 'link-a1'],
          ['a2', false, undefined],
        ],
      )
    })
  })

  describe('GET /conversations?scope=all — o monitor', () => {
    const all = (query: Record<string, unknown>) => (controller: AgentController) => (res: Response) =>
      controller.listConversations(request({ query: { scope: 'all', ...query } }), res)

    it('⛔ 404 para quem não é administrador provado — comum, forjado, anônimo e sem prova', async () => {
      const { controller } = await setup()

      for (const identity of [ALICE, FORGED_ADMIN, undefined]) {
        const out = await call(identity, all({})(controller))
        assert.strictEqual(out.status, 404, JSON.stringify(identity))
        assert.strictEqual(out.body?.code, 'not_found')
      }

      // Sem prova ninguém é administrador, nem com REQUIRE_PROVEN_OWNER desligado.
      process.env.REQUIRE_PROVEN_OWNER = '0'
      const { controller: unproven } = build({ proof: null })
      assert.strictEqual((await call(ADMIN, all({})(unproven))).status, 404)
    })

    it('o administrador vê todas, com custo e rótulo; modelo sem preço fica sem custo, não com zero', async () => {
      const { controller } = await setup()

      const out = await call(ADMIN, all({})(controller))
      const sessions = out.body?.result.sessions as Array<{ id: string; costUsd?: number; classification?: string }>

      assert.strictEqual(out.body?.result.scope, 'all')
      assert.deepStrictEqual(
        sessions.map((item) => item.id),
        ['a1', 'a2', 'b1', 'n1'],
      )
      // claude-sonnet-5: 1M de entrada × $2 + 100k de saída × $10 por 1M = $3.
      assert.strictEqual(sessions[0].costUsd, 3)
      assert.strictEqual(sessions[0].classification, 'red')
      assert.strictEqual('costUsd' in sessions[2], false)
    })

    it('com `page`, o servidor pagina, busca e conta as abas sobre a busca', async () => {
      const { controller } = await setup()

      const first = (await call(ADMIN, all({ page: '1', pageSize: '2' })(controller))).body?.result
      assert.deepStrictEqual({ total: first.total, page: first.page, pageSize: first.pageSize, scope: first.scope }, { total: 4, page: 1, pageSize: 2, scope: 'all' })
      assert.deepStrictEqual(
        first.sessions.map((item: { id: string }) => item.id),
        ['a1', 'a2'],
      )

      const searched = (await call(ADMIN, all({ page: '1', q: 'alice', classification: 'red' })(controller))).body?.result
      assert.deepStrictEqual(
        searched.sessions.map((item: { id: string }) => item.id),
        ['a1'],
      )
      assert.strictEqual(searched.total, 1)
      // As abas contam sobre a busca "alice", não sobre a aba `red`.
      assert.deepStrictEqual(searched.facets, { classification: { red: 1 }, provider: { claude: 2 }, agent: { 'researcher-agent': 2 } })

      const wide = (await call(ADMIN, all({ page: '1', pageSize: '100000' })(controller))).body?.result
      assert.strictEqual(wide.pageSize, 50, 'o teto de pageSize é 50')
      const broken = (await call(ADMIN, all({ page: 'abc', pageSize: '0' })(controller))).body?.result
      assert.deepStrictEqual([broken.page, broken.pageSize], [1, 10])
    })

    it('uma busca com mais de 100 caracteres é cortada, não recusada', async () => {
      const { controller } = await setup()

      const out = await call(ADMIN, all({ page: '1', q: `alice${'x'.repeat(200)}` })(controller))

      assert.strictEqual(out.status, 200)
      assert.strictEqual(out.body?.result.total, 0)
    })
  })

  describe('GET /conversations/stats', () => {
    it('⛔ 404 para quem não é administrador', async () => {
      const { controller } = await setup()

      for (const identity of [ALICE, FORGED_ADMIN, undefined]) {
        assert.strictEqual((await call(identity, (res) => controller.conversationStats(request(), res))).status, 404)
      }
    })

    it('totais, por modelo, por sinal e o custo — soma só o que tem preço', async () => {
      const { controller } = await setup()

      const stats = (await call(ADMIN, (res) => controller.conversationStats(request(), res))).body?.result

      assert.strictEqual(stats.conversations, 4)
      assert.strictEqual(stats.users, 2)
      assert.deepStrictEqual(stats.byClassification, { red: 1, green: 1 })
      // 3 conversas com preço × $3 = $9; a do modelo sem preço não entra como zero nem some do detalhe.
      assert.strictEqual(stats.costUsd, 9)
      const bySonnet = stats.byModel.find((item: { model: string }) => item.model === 'claude-sonnet-5')
      const byUnknown = stats.byModel.find((item: { model: string }) => item.model === 'modelo-sem-preco')
      assert.strictEqual(bySonnet.conversations, 3)
      assert.strictEqual(bySonnet.costUsd, 9)
      assert.strictEqual('costUsd' in byUnknown, false)
    })
  })

  describe('GET /conversations/:id/turns', () => {
    const turns = (id: string) => (res: Response, controller: AgentController) => controller.getConversationTurns(request({ params: { id } }), res)

    it('o dono lê, SEM custo nem rótulo', async () => {
      const { controller } = await setup()

      const out = await call(ALICE, (res) => turns('a1')(res, controller))
      const [turn] = out.body!.result.turns

      assert.strictEqual(out.status, 200)
      assert.strictEqual(turn.request, 'qual o estoque?')
      assert.strictEqual('costUsd' in turn, false)
      assert.strictEqual('classification' in turn, false)
    })

    it('o administrador lê a de qualquer um, COM custo e rótulo', async () => {
      const { controller } = await setup()

      const [turn] = (await call(ADMIN, (res) => turns('a1')(res, controller))).body!.result.turns

      assert.strictEqual(turn.costUsd, 3)
      assert.strictEqual(turn.classification, 'red')
    })

    it('⛔ outro dono, id inexistente e id de conversa sem dono respondem IGUAL: 404', async () => {
      const { controller } = await setup()

      const stranger = await call(BOB, (res) => turns('a1')(res, controller))
      const missing = await call(BOB, (res) => turns('nao-existe')(res, controller))
      const unowned = await call(BOB, (res) => turns('n1')(res, controller))

      for (const out of [stranger, missing, unowned]) assert.strictEqual(out.status, 404)
      assert.strictEqual(stranger.body?.code, missing.body?.code)
      assert.strictEqual(stranger.body?.message?.replace('a1', 'x'), missing.body?.message?.replace('nao-existe', 'x'))
    })

    it('credencial forjada é 401; anônimo só lê o que não tem dono', async () => {
      const { controller } = await setup()

      assert.strictEqual((await call(FORGED_ADMIN, (res) => turns('a1')(res, controller))).status, 401)
      assert.strictEqual((await call(undefined, (res) => turns('n1')(res, controller))).status, 200)
      assert.strictEqual((await call(undefined, (res) => turns('a1')(res, controller))).status, 404)
    })
  })

  describe('DELETE /conversations/:id', () => {
    const remove = (id: string) => (res: Response, controller: AgentController) => controller.deleteConversation(request({ params: { id } }), res)

    it('o dono apaga a sua, cabeçalho e turnos', async () => {
      const { controller, conversations } = await setup()

      const out = await call(ALICE, (res) => remove('a1')(res, controller))

      assert.strictEqual(out.status, 200)
      assert.strictEqual(await conversations.findSession('a1'), undefined)
      assert.deepStrictEqual(await conversations.listTurns('a1'), [])
    })

    it('o administrador apaga a de qualquer um', async () => {
      const { controller, conversations } = await setup()

      assert.strictEqual((await call(ADMIN, (res) => remove('b1')(res, controller))).status, 200)
      assert.strictEqual(await conversations.findSession('b1'), undefined)
    })

    it('⛔ quem não é o dono recebe 404 e NADA é apagado', async () => {
      const { controller, conversations } = await setup()

      assert.strictEqual((await call(BOB, (res) => remove('a1')(res, controller))).status, 404)
      assert.strictEqual((await call(FORGED_ADMIN, (res) => remove('a1')(res, controller))).status, 401)
      assert.strictEqual((await call(undefined, (res) => remove('a1')(res, controller))).status, 404)
      assert.ok(await conversations.findSession('a1'))
      assert.strictEqual((await conversations.listTurns('a1')).length, 1)
    })
  })

  describe('compartilhar por link', () => {
    const share = (id: string, body: unknown) => (res: Response, controller: AgentController) => controller.shareConversation(request({ params: { id }, body }), res)
    const shared = (id: string) => (res: Response, controller: AgentController) => controller.getSharedConversation(request({ params: { id } }), res)

    it('cria o shareId uma vez (12 bytes em base64url) e o reusa ao desligar e religar', async () => {
      const { controller, conversations } = await setup()

      const first = (await call(ALICE, (res) => share('a1', { shared: true })(res, controller))).body?.result
      assert.match(first.shareId, /^[A-Za-z0-9_-]{16}$/)
      assert.strictEqual((await conversations.findByShareId(first.shareId))?.id, 'a1')

      const off = (await call(ALICE, (res) => share('a1', { shared: false })(res, controller))).body?.result
      assert.deepStrictEqual(off, { sessionId: 'a1', shared: false, shareId: undefined })

      const again = (await call(ALICE, (res) => share('a1', { shared: true })(res, controller))).body?.result
      assert.strictEqual(again.shareId, first.shareId)

      const other = (await call(ALICE, (res) => share('a2', { shared: true })(res, controller))).body?.result
      assert.notStrictEqual(other.shareId, first.shareId)
    })

    it('o administrador também compartilha; quem não é dono recebe 404 e nada abre', async () => {
      const { controller, conversations } = await setup()

      assert.strictEqual((await call(ADMIN, (res) => share('b1', { shared: true })(res, controller))).status, 200)

      for (const identity of [BOB, undefined]) assert.strictEqual((await call(identity, (res) => share('a1', { shared: true })(res, controller))).status, 404)
      assert.strictEqual((await call(FORGED_ADMIN, (res) => share('a1', { shared: true })(res, controller))).status, 401)
      assert.strictEqual((await conversations.findSession('a1'))?.shared, false)
    })

    it('corpo inválido é 422 — `"true"` em texto não abre', async () => {
      const { controller, conversations } = await setup()

      for (const body of [{}, { shared: 'true' }, { shared: 1 }]) assert.strictEqual((await call(ALICE, (res) => share('a1', body)(res, controller))).status, 422)
      assert.strictEqual((await conversations.findSession('a1'))?.shared, false)
    })

    it('GET /shared/:id abre sem credencial e devolve SÓ a projeção pública', async () => {
      const { controller } = await setup()
      const { shareId } = (await call(ALICE, (res) => share('a1', { shared: true })(res, controller))).body!.result

      const out = await call(undefined, (res) => shared(shareId)(res, controller))
      const text = JSON.stringify(out.body)

      assert.strictEqual(out.status, 200)
      assert.deepStrictEqual(Object.keys(out.body?.result).sort(), ['createdAt', 'id', 'title', 'turns'])
      assert.strictEqual(out.body?.result.id, shareId)
      assert.deepStrictEqual(Object.keys(out.body?.result.turns[0]).sort(), ['at', 'request', 'text'])
      // Nada do que o registro guarda além de pergunta e resposta: chamada de ferramenta, raciocínio,
      // rótulo, consumo, dono e o id interno da sessão.
      for (const secret of ['dado-cru-123', 'stock_lookup', 'vou consultar', '"red"', 'classification', 'alice', 'claude-sonnet-5', '"a1"', 'usage']) {
        assert.ok(!text.includes(secret), `vazou: ${secret}`)
      }
    })

    it('⛔ descompartilhar REVOGA: o mesmo link passa a dar 404', async () => {
      const { controller } = await setup()
      const { shareId } = (await call(ALICE, (res) => share('a1', { shared: true })(res, controller))).body!.result
      assert.strictEqual((await call(undefined, (res) => shared(shareId)(res, controller))).status, 200)

      await call(ALICE, (res) => share('a1', { shared: false })(res, controller))

      assert.strictEqual((await call(undefined, (res) => shared(shareId)(res, controller))).status, 404)
    })

    it('⛔ não compartilhada e inexistente respondem IGUAL (404), e o id da sessão não abre nada', async () => {
      const { controller } = await setup()

      const closed = await call(undefined, (res) => shared('a1')(res, controller))
      const missing = await call(undefined, (res) => shared('nao-existe')(res, controller))

      assert.strictEqual(closed.status, 404)
      assert.deepStrictEqual(closed.body, missing.body)

      // Mesmo compartilhada, a conversa não abre pelo id da sessão — só pelo shareId.
      await call(ALICE, (res) => share('a1', { shared: true })(res, controller))
      assert.strictEqual((await call(undefined, (res) => shared('a1')(res, controller))).status, 404)
    })
  })

  describe('GET /agents — preço por modelo', () => {
    it('cada agente leva o preço dos modelos que oferece e que têm preço; sem preço fica de fora', async () => {
      const { controller } = build()

      const agents = (await call(ALICE, (res) => controller.getAgents(request(), res))).body?.result as Array<{
        models: string[]
        pricing: Record<string, { input: number; output: number }>
      }>

      assert.ok(agents.length > 0)
      for (const agent of agents) {
        assert.ok(Object.keys(agent.pricing).every((model) => agent.models.includes(model)))
        assert.ok(Object.values(agent.pricing).every((price) => price.input > 0 && price.output > 0))
      }
      assert.ok(agents.some((agent) => Object.keys(agent.pricing).length > 0))
      assert.ok(agents.every((agent) => !('o4-mini' in agent.pricing) && !('o3-pro' in agent.pricing)))
    })

    it('usa a tabela injetada (MODEL_PRICING_FILE) no lugar da de fábrica', async () => {
      const { controller } = build({ pricing: { 'claude-sonnet-5': { input: 7, output: 8 } } })

      const agents = (await call(ALICE, (res) => controller.getAgents(request(), res))).body?.result as Array<{ pricing: Record<string, unknown> }>
      const merged = Object.assign({}, ...agents.map((agent) => agent.pricing))

      assert.deepStrictEqual(merged['claude-sonnet-5'], { input: 7, output: 8 })
      assert.strictEqual(merged['gemini-3.7-flash'], undefined)
    })

    it('o custo das rotas de admin usa a tabela injetada', async () => {
      const { controller, conversations } = build({ pricing: { 'claude-sonnet-5': { input: 1, output: 1 } } })
      await seed(conversations)

      const [first] = (await call(ADMIN, (res) => controller.listConversations(request({ query: { scope: 'all' } }), res))).body!.result.sessions
      assert.strictEqual(first.costUsd, 1.1)
    })
  })
})
