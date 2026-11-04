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
  const agentRules = { knownTools: ['read_doc', 'run_bash', 'search_web'] }
  const theoRef = { agentId: 'theo' }

  let agents: AgentCatalog
  let revisions: Array<{ keys: readonly ICatalogItemKey[]; change: ICatalogChange }>
  let events: ICatalogChanged[]
  let now: Date
  let projectRules: IPermissionRule[]
  let service: PermissionRequestsService

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
    })
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
    assert.deepStrictEqual([result.pending.kind, result.pending.status], ['agent-rules', 'pending'])
    assert.deepStrictEqual(result.pending.add, [allow('terminal', 'npm test')])
    assert.deepStrictEqual(
      result.pending.widenings.map((item) => item.key),
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
        pending!.id,
        pending!.widenings.map((item) => item.key),
        { by: 'root@x.test', onScreen: false },
      ),
      PermissionRequestForbiddenError,
    )
    assert.strictEqual(service.get(pending!.id).status, 'pending')
    assert.ok(!rulesOf().some((rule) => rule.pattern === 'npm test'))
  })

  it('aprovar na tela aplica exatamente o confirmado e grava as chaves na revisão; confirm a menos ou a mais é recusado', async () => {
    const { pending } = service.change(theoRef, { add: [allow('terminal', 'npm test')], remove: [deny('terminal', 'git push *')], reason: 'publicar' }, asker)
    const keys = pending!.widenings.map((item) => item.key)
    await assert.rejects(service.approve(pending!.id, keys.slice(1), screen), CatalogWideningConfirmationError)
    await assert.rejects(service.approve(pending!.id, [...keys, 'agent/theo@alfa#permissions+allow:read:**'], screen), CatalogWideningConfirmationError)
    await assert.rejects(service.approve(pending!.id, undefined, screen), CatalogWideningConfirmationError)

    const approved = await service.approve(pending!.id, [...keys].reverse(), screen)
    assert.strictEqual(approved.request.status, 'approved')
    assert.strictEqual(approved.request.decidedBy, 'root@x.test')
    assert.deepStrictEqual(approved.permissions, [allow('terminal', 'git status'), allow('read', 'src/**'), allow('terminal', 'npm test')])
    assert.deepStrictEqual(rulesOf(), approved.permissions)
    const last = revisions.at(-1)!
    assert.deepStrictEqual(last.change.widenings, keys)
    assert.strictEqual(last.change.by, 'root@x.test')
    assert.match(last.change.note ?? '', /pedido de permissão pr-1 aprovado \(pedido por agent:theo \(conversa c-1\) por root@x.test\): publicar/)
    await assert.rejects(service.approve(pending!.id, keys, screen), PermissionRequestClosedError)
  })

  it('o agente mudou no meio: as ampliações são recalculadas, o confirm antigo é recusado com a lista nova', async () => {
    const { pending } = service.change(theoRef, { add: [allow('terminal', 'npm test'), allow('read', 'docs/**')], reason: 'x' }, asker)
    const old = pending!.widenings.map((item) => item.key)
    // Alguém liberou `npm *` pela tela: uma das ampliações já não amplia.
    agents.savePermissions('theo', [...rulesOf(), allow('terminal', 'npm *')], 'ana@x.test')
    const seen = service.get(pending!.id)
    assert.strictEqual(seen.changed, true)
    assert.deepStrictEqual(
      seen.widenings.map((item) => item.key),
      ['agent/theo@alfa#permissions+allow:read:docs/**'],
    )
    await assert.rejects(service.approve(pending!.id, old, screen), (error: unknown) => error instanceof CatalogWideningConfirmationError && error.widenings.length === 1)
    assert.strictEqual((await service.approve(pending!.id, ['agent/theo@alfa#permissions+allow:read:docs/**'], screen)).request.status, 'approved')
  })

  it('recusar: nada muda no agente; decidido não se decide de novo', async () => {
    const { pending } = service.change(theoRef, { add: [allow('terminal', 'npm test')], reason: 'x' }, asker)
    const before = revisions.length
    const rejected = service.reject(pending!.id, { by: 'root@x.test' }, 'não agora')
    assert.deepStrictEqual([rejected.status, rejected.decisionNote], ['rejected', 'não agora'])
    assert.strictEqual(revisions.length, before)
    assert.throws(() => service.reject(pending!.id, { by: 'root@x.test' }), PermissionRequestClosedError)
    await assert.rejects(service.approve(pending!.id, [], screen), PermissionRequestClosedError)
    assert.strictEqual(service.list().length, 0)
    assert.strictEqual(service.list({ all: true }).length, 1)
  })

  it('vencido (7 dias): aparece como vencido e não é aprovado; pode ser descartado', async () => {
    const { pending } = service.change(theoRef, { add: [allow('terminal', 'npm test')], reason: 'x' }, asker)
    now = new Date('2026-11-10T12:00:00Z')
    assert.strictEqual(service.list({ agentId: 'theo' })[0].status, 'expired')
    await assert.rejects(
      service.approve(
        pending!.id,
        pending!.widenings.map((item) => item.key),
        screen,
      ),
      (error: unknown) => error instanceof PermissionRequestClosedError && error.status === 'expired',
    )
    assert.strictEqual(service.reject(pending!.id, { by: 'root@x.test' }).status, 'rejected')
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
      assert.deepStrictEqual([result.pending?.kind, result.pending?.projectId, result.pending?.agentId], ['project-rules', 'alfa', undefined])
      assert.deepStrictEqual(
        result.pending?.widenings.map((item) => item.key),
        ['project-permissions/alfa#rules+allow:read:docs/**', 'project-permissions/alfa#rules-deny:write:**/*.lock'],
      )
      assert.match(result.notice, /Projeto Alfa → Permissões → Pedidos pendentes/)
      assert.deepStrictEqual(
        service.list({ projectId: 'alfa', kind: 'project-rules' }).map((request) => request.id),
        [result.pending!.id],
      )
      assert.strictEqual(service.rules(alfa).layer, 'project')
    })

    it('aprovar só na tela; aplica nas regras do projeto com as chaves na revisão', async () => {
      const { pending } = service.change(alfa, { add: [allow('read', 'docs/**')], reason: 'docs' }, asker)
      const keys = pending!.widenings.map((item) => item.key)
      await assert.rejects(service.approve(pending!.id, keys, { by: 'root@x.test', onScreen: false }), PermissionRequestForbiddenError)
      const approved = await service.approve(pending!.id, keys, screen)
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
      assert.deepStrictEqual([result.pending?.kind, result.pending?.patch], ['agent-patch', { allowedTools: ['read_doc', 'cap:terminal'] }])
      assert.deepStrictEqual(
        result.pending?.widenings.map((item) => item.key),
        ['agent/theo@alfa#allowedTools+cap:terminal'],
      )
      assert.match(result.notice, /PENDENTE — NÃO aplicado/)
      assert.match(result.notice, /Agentes → Theo 2 → Permissões → Pedidos pendentes/)
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
      const keys = pending!.widenings.map((item) => item.key)
      await assert.rejects(service.approve(pending!.id, keys, { by: 'root@x.test', onScreen: false }), PermissionRequestForbiddenError)
      await assert.rejects(service.approve(pending!.id, [], screen), CatalogWideningConfirmationError)
      const approved = await service.approve(pending!.id, keys, screen)
      assert.strictEqual(approved.request.status, 'approved')
      assert.deepStrictEqual(agents.entry('theo')!.agent.allowedTools, ['read_doc', 'cap:web.search'])
      assert.deepStrictEqual(revisions.at(-1)!.change.widenings, keys)
    })
  })
})
