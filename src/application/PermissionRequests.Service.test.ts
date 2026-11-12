import assert from 'node:assert'
import { beforeEach, describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import {
  AgentNotFoundError,
  CatalogWideningConfirmationError,
  InvalidAgentError,
  InvalidPermissionsError,
  PermissionRequestClosedError,
  PermissionRequestForbiddenError,
  ProjectNotFoundError,
} from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { IPermissionRule } from '@domain/Permission.Policy'
import { ICatalogChanged } from '@domain/ports/CatalogEvents.Port'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { SqlitePermissionRequestRepository } from '@infra/persistence/Sqlite.PermissionRequestRepository'
import { AgentCatalog } from './Agent.Catalog'
import type { ICatalogChange, ICatalogItemKey } from './CatalogHistory.Service'
import { PermissionRequestsService } from './PermissionRequests.Service'

const allow = (category: IPermissionRule['category'], pattern: string): IPermissionRule => ({ category, pattern, decision: 'allow' })
const deny = (category: IPermissionRule['category'], pattern: string): IPermissionRule => ({ category, pattern, decision: 'deny' })

describe('PermissionRequestsService — o agente pede, a pessoa confirma na tela', () => {
  const theo: IAgent = {
    id: 'theo',
    name: 'Theo',
    providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
    systemPrompt: 'faça',
    modes: [EMode.AGENT],
    allowedTools: ['read_doc'],
    projectId: 'alfa',
    permissions: [allow('terminal', 'git status'), deny('terminal', 'git push *'), allow('read', 'src/**')],
  }
  const asker = { by: 'root@x.test', agentId: 'theo', conversationId: 'c-1' }
  const screen = { by: 'root@x.test', onScreen: true }
  const agentRules = { knownTools: ['read_doc', 'run_bash', 'search_web', 'fetch_url'] }
  const theoRef = { agentId: 'theo' }

  let agents: AgentCatalog
  let revisions: Array<{ keys: readonly ICatalogItemKey[]; change: ICatalogChange }>
  let events: ICatalogChanged[]
  let now: Date
  let projectRules: IPermissionRule[]
  let service: PermissionRequestsService
  let savedSecrets: Array<{ scope: string; scopeId: string; name: string; value?: string; by: string }>

  beforeEach(() => {
    agents = new AgentCatalog(new NullAgentRepository())
    agents.save(theo, { rules: agentRules, by: 'seed', creating: true })
    revisions = []
    const recorder = {
      record: (keys: readonly ICatalogItemKey[], change: ICatalogChange) => (revisions.push({ keys, change }), []),
      withDependents: (key: ICatalogItemKey) => [key],
      keysOf: () => [],
    }
    agents.history.use(() => recorder)
    events = []
    now = new Date('2026-11-03T12:00:00Z')
    projectRules = [allow('network', 'api.github.com'), deny('write', '**/*.lock')]
    let next = 0
    service = new PermissionRequestsService({
      repository: new SqlitePermissionRequestRepository(':memory:'),
      agents,
      projects: {
        exists: (id) => id === 'alfa',
        name: () => 'Alfa',
        rules: () => projectRules,
        save: (_id, rules, by, change) => {
          projectRules = rules
          revisions.push({ keys: [{ kind: 'project-permissions', id: 'alfa' }], change: { ...change, by } })
          return rules
        },
      },
      events: { publish: (changes) => void events.push(...changes) },
      now: () => now,
      newId: () => `pr-${++next}`,
      secrets: {
        save: (scope, scopeId, input, by) => savedSecrets.push({ scope, scopeId, name: input.name, ...(input.value ? { value: input.value } : {}), by }),
        exists: (scope, id) => (scope === 'agent' && id === 'theo') || (scope === 'skill' && id === 'gitlab'),
      },
    })
    savedSecrets = []
    service.useAgentValidation(async () => ({ rules: agentRules, issues: () => [] }))
  })

  const rulesOf = () => agents.entry('theo')?.agent.permissions ?? []

  it('restrição vale já, com a revisão no histórico (quem: o agente pela conta; o motivo); a ampliação fica pendente e NÃO vale', () => {
    const result = service.change(
      theoRef,
      { add: [deny('network', '*.evil.com'), allow('terminal', 'npm test')], remove: [allow('read', 'src/**')], reason: 'rodar os testes' },
      asker,
    )

    assert.deepStrictEqual(rulesOf(), [allow('terminal', 'git status'), deny('terminal', 'git push *'), deny('network', '*.evil.com')])
    assert.strictEqual(revisions.length, 1)
    assert.deepStrictEqual(revisions[0].change, { source: 'agent', note: 'pedido do agente: rodar os testes', by: 'agent:theo (conversa c-1) por root@x.test' })

    assert.ok(result.pending)
    assert.deepStrictEqual([result.pending[0].kind, result.pending[0].status], ['agent-rules', 'pending'])
    assert.deepStrictEqual(result.pending[0].add, [allow('terminal', 'npm test')])
    assert.deepStrictEqual(
      result.pending[0].widenings.map((item) => item.key),
      ['agent/theo@alfa#permissions+allow:terminal:npm test'],
    )
    assert.ok(!rulesOf().some((rule) => rule.pattern === 'npm test'), 'a ampliação não pode valer antes da aprovação')
    assert.deepStrictEqual(events, [{ kind: 'permission-request', id: 'theo', projectId: 'alfa', op: 'update' }])
  })

  it('⛔ o resultado manda avisar a pessoa: pendente, onde confirmar na tela, a lista, e nunca dizer que foi liberado', () => {
    const { notice } = service.change(theoRef, { add: [allow('terminal', 'npm test')], reason: 'testes' }, asker)
    assert.match(notice, /PENDENTE — NÃO aplicado/)
    assert.match(notice, /Agentes → Theo → Permissões → Pedidos pendentes/)
    assert.match(notice, /permite terminal "npm test"/)
    assert.match(notice, /Não diga que o acesso foi liberado/)
  })

  it('sem ampliação, nenhum pedido; a troca que não muda nada não grava revisão', () => {
    const only = service.change(theoRef, { add: [deny('write', '**/*.lock')], reason: 'proteger' }, asker)
    assert.strictEqual(only.pending, undefined)
    assert.strictEqual(service.list().length, 0)
    assert.strictEqual(revisions.length, 1)
    const same = service.change(theoRef, { add: [deny('write', '**/*.lock')], reason: 'de novo' }, asker)
    assert.strictEqual(revisions.length, 1)
    assert.match(same.notice, /Nada mudou/)
  })

  it('regra inválida volta campo a campo e nada é gravado', () => {
    assert.throws(
      () => service.change(theoRef, { add: [{ category: 'terminal', pattern: 'npm **', decision: 'allow' }], reason: 'x' }, asker),
      (error: unknown) => error instanceof InvalidPermissionsError && error.issues[0].field === 'add[0]',
    )
    assert.strictEqual(revisions.length, 0)
    assert.throws(() => service.change({ agentId: 'ninguem' }, { add: [deny('read', 'x')], reason: 'x' }, asker), AgentNotFoundError)
  })

  it('⛔ aprovar fora da tela (agente, MCP, token de acesso) é recusado, e nada muda', async () => {
    const { pending } = service.change(theoRef, { add: [allow('terminal', 'npm test')], reason: 'testes' }, asker)
    await assert.rejects(
      service.approve(
        pending![0].id,
        pending![0].widenings.map((item) => item.key),
        { by: 'root@x.test', onScreen: false },
      ),
      PermissionRequestForbiddenError,
    )
    assert.strictEqual(service.get(pending![0].id).status, 'pending')
    assert.ok(!rulesOf().some((rule) => rule.pattern === 'npm test'))
  })

  it('aprovar na tela aplica exatamente o confirmado e grava as chaves na revisão; confirm a menos ou a mais é recusado', async () => {
    const { pending } = service.change(theoRef, { add: [allow('terminal', 'npm test')], remove: [deny('terminal', 'git push *')], reason: 'publicar' }, asker)
    const keys = pending![0].widenings.map((item) => item.key)
    await assert.rejects(service.approve(pending![0].id, keys.slice(1), screen), CatalogWideningConfirmationError)
    await assert.rejects(service.approve(pending![0].id, [...keys, 'agent/theo@alfa#permissions+allow:read:**'], screen), CatalogWideningConfirmationError)
    await assert.rejects(service.approve(pending![0].id, undefined, screen), CatalogWideningConfirmationError)

    const approved = await service.approve(pending![0].id, [...keys].reverse(), screen)
    assert.strictEqual(approved.request.status, 'approved')
    assert.strictEqual(approved.request.decidedBy, 'root@x.test')
    // ⚖️ Um item por regra: aprovado o `npm test`, a outra (tirar o deny do push) segue pendente e não vale.
    assert.deepStrictEqual(approved.permissions, [allow('terminal', 'git status'), deny('terminal', 'git push *'), allow('read', 'src/**'), allow('terminal', 'npm test')])
    assert.deepStrictEqual(rulesOf(), approved.permissions)
    const last = revisions.at(-1)!
    assert.deepStrictEqual(last.change.widenings, keys)
    assert.strictEqual(last.change.by, 'root@x.test')
    assert.match(last.change.note ?? '', /pedido de permissão pr-1 aprovado \(pedido por agent:theo \(conversa c-1\) por root@x.test\): publicar/)
    await assert.rejects(service.approve(pending![0].id, keys, screen), PermissionRequestClosedError)
  })

  it('o agente mudou no meio: as ampliações são recalculadas, o confirm antigo é recusado com a lista nova', async () => {
    const { pending } = service.change(theoRef, { add: [allow('terminal', 'npm test'), allow('read', 'docs/**')], reason: 'x' }, asker)
    const [npm, docs] = pending!
    const old = npm.widenings.map((item) => item.key)
    // Alguém liberou `npm *` pela tela: o item do `npm test` já não amplia; o do `docs/**` segue igual.
    agents.savePermissions('theo', [...rulesOf(), allow('terminal', 'npm *')], 'ana@x.test')
    const seen = service.get(npm.id)
    assert.strictEqual(seen.changed, true)
    assert.deepStrictEqual(seen.widenings, [])
    assert.deepStrictEqual(
      service.get(docs.id).widenings.map((item) => item.key),
      ['agent/theo@alfa#permissions+allow:read:docs/**'],
    )
    await assert.rejects(service.approve(npm.id, old, screen), (error: unknown) => error instanceof CatalogWideningConfirmationError && error.widenings.length === 0)
    assert.strictEqual((await service.approve(npm.id, [], screen)).request.status, 'approved')
  })

  it('⚖️ um pedido por regra: os itens da mesma chamada dividem o lote, e cada um se aprova ou se recusa sozinho', async () => {
    const { pending, notice } = service.change(theoRef, { add: [allow('terminal', 'npm test'), allow('read', 'docs/**')], reason: 'x' }, asker)
    assert.strictEqual(pending!.length, 2)
    assert.ok(pending![0].batchId)
    assert.strictEqual(pending![0].batchId, pending![1].batchId)
    assert.match(notice, /estas 2 mudanças ampliam/)
    await service.approve(pending![1].id, ['agent/theo@alfa#permissions+allow:read:docs/**'], screen)
    service.reject(pending![0].id, { by: 'root@x.test' })
    assert.ok(rulesOf().some((rule) => rule.pattern === 'docs/**'))
    assert.ok(!rulesOf().some((rule) => rule.pattern === 'npm test'))
    // Um item só não tem lote.
    assert.strictEqual(service.change(theoRef, { add: [allow('read', 'lib/**')], reason: 'y' }, asker).pending![0].batchId, undefined)
  })

  it('recusar: nada muda no agente; decidido não se decide de novo', async () => {
    const { pending } = service.change(theoRef, { add: [allow('terminal', 'npm test')], reason: 'x' }, asker)
    const before = revisions.length
    const rejected = service.reject(pending![0].id, { by: 'root@x.test' }, 'não agora')
    assert.deepStrictEqual([rejected.status, rejected.decisionNote], ['rejected', 'não agora'])
    assert.strictEqual(revisions.length, before)
    assert.throws(() => service.reject(pending![0].id, { by: 'root@x.test' }), PermissionRequestClosedError)
    await assert.rejects(service.approve(pending![0].id, [], screen), PermissionRequestClosedError)
    assert.strictEqual(service.list().length, 0)
    assert.strictEqual(service.list({ all: true }).length, 1)
  })

  it('a decisão avisa quem ouve (o aviso à conversa que pediu); ⛔ o aviso que falha não desfaz a decisão', async () => {
    const heard: Array<{ id: string; status: string; conversationId?: string; by: string }> = []
    service.useDecisionListener(
      (request, decider) => void heard.push({ id: request.id, status: request.status, conversationId: request.requestedBy.conversationId, by: decider.by }),
    )
    const { pending } = service.change(theoRef, { add: [allow('terminal', 'npm test'), allow('read', 'lib/**')], reason: 'x' }, asker)
    assert.deepStrictEqual(heard, [])
    await service.approve(
      pending![0].id,
      pending![0].widenings.map((item) => item.key),
      screen,
    )
    service.reject(pending![1].id, { by: 'outra@x.test' }, 'não')
    assert.deepStrictEqual(heard, [
      { id: pending![0].id, status: 'approved', conversationId: 'c-1', by: 'root@x.test' },
      { id: pending![1].id, status: 'rejected', conversationId: 'c-1', by: 'outra@x.test' },
    ])
    // A aprovação recusada (fora da tela) não é decisão: ninguém é avisado.
    const again = service.change(theoRef, { add: [allow('terminal', 'npm run build')], reason: 'y' }, asker).pending![0]
    await assert.rejects(
      service.approve(
        again.id,
        again.widenings.map((item) => item.key),
        { by: 'root@x.test', onScreen: false },
      ),
      PermissionRequestForbiddenError,
    )
    assert.strictEqual(heard.length, 2)

    service.useDecisionListener(() => {
      throw new Error('a conversa sumiu')
    })
    const original = console.warn
    console.warn = () => undefined
    try {
      const approved = await service.approve(
        again.id,
        again.widenings.map((item) => item.key),
        screen,
      )
      assert.strictEqual(approved.request.status, 'approved')
    } finally {
      console.warn = original
    }
    assert.ok(rulesOf().some((rule) => rule.pattern === 'npm run build'))
  })

  it('🔌 ligar na camada local: o agente que não é de projeto conectado não tem camada, e nada vira pedido', async () => {
    await assert.rejects(service.requestLocalTools('theo', { allowedTools: ['search_web'], reason: 'x' }, asker), (error: unknown) => {
      assert.ok(error instanceof InvalidAgentError)
      return error.issues.some((issue) => issue.field === 'localLayer' && /CONNECTED project/.test(issue.message))
    })
    await assert.rejects(service.requestLocalTools('theo', { allowedTools: [' '], reason: ' ' }, asker), (error: unknown) => {
      assert.ok(error instanceof InvalidAgentError)
      return error.issues.map((issue) => issue.field).join() === 'reason,localLayer.allowedTools'
    })
    await assert.rejects(service.requestLocalTools('fantasma', { allowedTools: ['search_web'], reason: 'x' }, asker), AgentNotFoundError)
    assert.strictEqual(service.list({ all: true }).length, 0)
  })

  it('vencido (7 dias): aparece como vencido e não é aprovado; pode ser descartado', async () => {
    const { pending } = service.change(theoRef, { add: [allow('terminal', 'npm test')], reason: 'x' }, asker)
    now = new Date('2026-11-10T12:00:00Z')
    assert.strictEqual(service.list({ agentId: 'theo' })[0].status, 'expired')
    await assert.rejects(
      service.approve(
        pending![0].id,
        pending![0].widenings.map((item) => item.key),
        screen,
      ),
      (error: unknown) => error instanceof PermissionRequestClosedError && error.status === 'expired',
    )
    assert.strictEqual(service.reject(pending![0].id, { by: 'root@x.test' }).status, 'rejected')
  })

  it('list_permission_rules: as do agente, as do projeto dele e os pedidos abertos', () => {
    service.change(theoRef, { add: [allow('terminal', 'npm test')], reason: 'x' }, asker)
    const view = service.rules(theoRef)
    assert.deepStrictEqual([view.layer, view.rules], ['agent', theo.permissions])
    assert.deepStrictEqual(view.project, { projectId: 'alfa', rules: projectRules })
    assert.deepStrictEqual(
      view.pending.map((request) => request.id),
      ['pr-1'],
    )
  })

  it('list_permission_rules de um agente global: a camada de baixo é a do projeto da conversa (o do agente vence)', () => {
    agents.save({ ...theo, id: 'atlas', name: 'Atlas', projectId: undefined }, { rules: agentRules, by: 'seed', creating: true })
    assert.strictEqual(service.rules({ agentId: 'atlas' }).project, undefined)
    assert.deepStrictEqual(service.rules({ agentId: 'atlas' }, { conversationProjectId: 'alfa' }).project, { projectId: 'alfa', rules: projectRules })
    assert.strictEqual(service.rules(theoRef, { conversationProjectId: 'beta' }).project?.projectId, 'alfa')
  })

  describe('as regras do PROJETO (a camada de baixo)', () => {
    const alfa = { projectId: 'alfa' }

    it('restrição já, ampliação pendente com as chaves de `project-permissions`; o caminho da tela é o do projeto', () => {
      const result = service.change(alfa, { add: [deny('network', '*.evil.com'), allow('read', 'docs/**')], remove: [deny('write', '**/*.lock')], reason: 'docs' }, asker)
      assert.deepStrictEqual(projectRules, [allow('network', 'api.github.com'), deny('write', '**/*.lock'), deny('network', '*.evil.com')])
      assert.strictEqual(revisions.at(-1)!.change.source, 'agent')
      assert.deepStrictEqual([result.pending?.[0]?.kind, result.pending?.[0]?.projectId, result.pending?.[0]?.agentId], ['project-rules', 'alfa', undefined])
      assert.deepStrictEqual(
        result.pending?.map((item) => item.widenings.map((widening) => widening.key)),
        [['project-permissions/alfa#rules+allow:read:docs/**'], ['project-permissions/alfa#rules-deny:write:**/*.lock']],
      )
      assert.match(result.notice, /Projeto Alfa → Permissões → Pedidos pendentes/)
      assert.deepStrictEqual(
        service
          .list({ projectId: 'alfa', kind: 'project-rules' })
          .map((request) => request.id)
          .sort(),
        result.pending!.map((request) => request.id).sort(),
      )
      assert.strictEqual(service.rules(alfa).layer, 'project')
    })

    it('aprovar só na tela; aplica nas regras do projeto com as chaves na revisão', async () => {
      const { pending } = service.change(alfa, { add: [allow('read', 'docs/**')], reason: 'docs' }, asker)
      const keys = pending![0].widenings.map((item) => item.key)
      await assert.rejects(service.approve(pending![0].id, keys, { by: 'root@x.test', onScreen: false }), PermissionRequestForbiddenError)
      const approved = await service.approve(pending![0].id, keys, screen)
      assert.ok(approved.permissions?.some((rule) => rule.pattern === 'docs/**'))
      assert.deepStrictEqual(revisions.at(-1)!.change.widenings, keys)
    })

    it('projeto que não existe: 404', () => {
      assert.throws(() => service.change({ projectId: 'zeta' }, { add: [deny('read', 'x')], reason: 'x' }, asker), ProjectNotFoundError)
    })
  })

  describe('patch_agent', () => {
    it('o que não amplia vale já; o campo que amplia fica pendente (o detector do catálogo), e nada dele vale', async () => {
      const result = await service.patchAgent('theo', { patch: { name: 'Theo 2', allowedTools: ['read_doc', 'run_bash'] }, reason: 'precisa do terminal' }, asker)
      const stored = agents.entry('theo')!.agent
      assert.deepStrictEqual([stored.name, stored.allowedTools], ['Theo 2', ['read_doc']])
      assert.deepStrictEqual(result.applied, ['name'])
      assert.deepStrictEqual(revisions.at(-1)!.change, { source: 'agent', note: 'patch do agente: precisa do terminal', by: 'agent:theo (conversa c-1) por root@x.test' })
      assert.deepStrictEqual(
        [result.pending?.[0]?.kind, result.pending?.[0]?.patch, result.pending?.[0]?.entries],
        ['agent-patch', undefined, { field: 'allowedTools', add: ['cap:terminal'] }],
      )
      assert.deepStrictEqual(
        result.pending?.[0]?.widenings.map((item) => item.key),
        ['agent/theo@alfa#allowedTools+cap:terminal'],
      )
      assert.match(result.notice, /PENDENTE — NÃO aplicado/)
      assert.match(result.notice, /Agentes → Theo 2 → Permissões → Pedidos pendentes/)
    })

    it('⚖️ campo-lista: o que ele tira vale já; cada entrada nova é um pedido, aprovado sozinho sobre o agente de agora', async () => {
      agents.save({ ...agents.entry('theo')!.agent, allowedTools: ['read_doc', 'search_web'] }, { rules: agentRules, by: 'ana@x.test', creating: false })
      const result = await service.patchAgent('theo', { patch: { allowedTools: ['read_doc', 'cap:terminal', 'cap:web.fetch'] }, reason: 'mais' }, asker)
      assert.deepStrictEqual(agents.entry('theo')!.agent.allowedTools, ['read_doc'])
      assert.deepStrictEqual(
        result.pending?.map((item) => item.entries),
        [
          { field: 'allowedTools', add: ['cap:terminal'] },
          { field: 'allowedTools', add: ['cap:web.fetch'] },
        ],
      )
      assert.strictEqual(result.pending![0].batchId, result.pending![1].batchId)
      const [terminal, fetch] = result.pending!
      await service.approve(
        fetch.id,
        fetch.widenings.map((item) => item.key),
        screen,
      )
      assert.deepStrictEqual(agents.entry('theo')!.agent.allowedTools, ['read_doc', 'cap:web.fetch'])
      service.reject(terminal.id, { by: 'root@x.test' })
      assert.deepStrictEqual(agents.entry('theo')!.agent.allowedTools, ['read_doc', 'cap:web.fetch'])
    })

    it('tirar ferramenta e restringir não pedem nada', async () => {
      const result = await service.patchAgent('theo', { patch: { allowedTools: [], adminOnly: true }, reason: 'fechar' }, asker)
      assert.strictEqual(result.pending, undefined)
      assert.deepStrictEqual(agents.entry('theo')!.agent.allowedTools, [])
      assert.strictEqual(agents.entry('theo')!.agent.adminOnly, true)
    })

    it('aprovar o patch na tela grava pelo caminho normal com as chaves; fora da tela, recusado; inválido, nada grava', async () => {
      await assert.rejects(service.patchAgent('theo', { patch: { allowedTools: ['nao_existe'] }, reason: 'x' }, asker), InvalidAgentError)
      await assert.rejects(service.patchAgent('theo', { patch: {}, reason: '' }, asker), InvalidAgentError)
      const { pending } = await service.patchAgent('theo', { patch: { allowedTools: ['read_doc', 'search_web'] }, reason: 'buscar' }, asker)
      const keys = pending![0].widenings.map((item) => item.key)
      await assert.rejects(service.approve(pending![0].id, keys, { by: 'root@x.test', onScreen: false }), PermissionRequestForbiddenError)
      await assert.rejects(service.approve(pending![0].id, [], screen), CatalogWideningConfirmationError)
      const approved = await service.approve(pending![0].id, keys, screen)
      assert.strictEqual(approved.request.status, 'approved')
      assert.deepStrictEqual(agents.entry('theo')!.agent.allowedTools, ['read_doc', 'cap:web.search'])
      assert.deepStrictEqual(revisions.at(-1)!.change.widenings, keys)
    })
  })

  describe('variável secreta pedida (`request_secret`)', () => {
    it('⛔ o pedido guarda só o nome; o valor entra na aprovação, pela tela, e vai direto ao cofre', async () => {
      const request = service.requestSecret({ scope: 'skill', scopeId: 'gitlab', name: 'GITLAB_TOKEN', description: 'deploy', reason: 'publicar' }, asker)
      assert.deepStrictEqual(
        [request.kind, request.secret, request.agentId],
        ['secret', { scope: 'skill', scopeId: 'gitlab', name: 'GITLAB_TOKEN', description: 'deploy' }, 'theo'],
      )
      const keys = request.widenings.map((item) => item.key)
      assert.deepStrictEqual(keys, ['secret/skill/gitlab#GITLAB_TOKEN'])
      await assert.rejects(service.approve(request.id, keys, { by: 'root@x.test', onScreen: false }, 'glpat-x'), PermissionRequestForbiddenError)
      await assert.rejects(service.approve(request.id, keys, screen), InvalidPermissionsError)
      await assert.rejects(service.approve(request.id, [], screen, 'glpat-x'), CatalogWideningConfirmationError)
      const approved = await service.approve(request.id, keys, screen, 'glpat-valor-real')
      assert.strictEqual(approved.request.status, 'approved')
      assert.deepStrictEqual(savedSecrets, [{ scope: 'skill', scopeId: 'gitlab', name: 'GITLAB_TOKEN', value: 'glpat-valor-real', by: 'root@x.test' }])
      assert.ok(!JSON.stringify(service.get(request.id)).includes('glpat-valor-real'), 'o valor não fica no pedido')
    })

    it('nome inválido, recurso que não existe e sem motivo: recusados', () => {
      assert.throws(() => service.requestSecret({ scope: 'skill', scopeId: 'gitlab', name: 'minusculo', reason: 'x' }, asker), InvalidPermissionsError)
      assert.throws(() => service.requestSecret({ scope: 'command', scopeId: 'nao-existe', name: 'TOKEN', reason: 'x' }, asker), InvalidPermissionsError)
      assert.throws(() => service.requestSecret({ scope: 'agent', scopeId: 'theo', name: 'TOKEN', reason: ' ' }, asker), InvalidPermissionsError)
    })

    it('⛔ teto de pedidos abertos por agente: o que passa do teto é recusado e nada é gravado', () => {
      const before = service.list({ agentId: 'theo' }).length
      for (let index = before; index < 100; index += 1) service.requestSecret({ scope: 'agent', scopeId: 'theo', name: `VAR_${index}`, reason: 'x' }, asker)
      assert.throws(
        () => service.requestSecret({ scope: 'agent', scopeId: 'theo', name: 'UMA_A_MAIS', reason: 'x' }, asker),
        (error: unknown) => error instanceof InvalidPermissionsError && /too many open requests/.test(JSON.stringify(error.issues)),
      )
      assert.strictEqual(service.list({ agentId: 'theo' }).length, 100)
    })
  })
})
