import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { TCatalogKind } from '@domain/Catalog.Document'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { CatalogRestoreInvalidError, CatalogRevisionConflictError, CatalogWideningConfirmationError, CatalogWideningForbiddenError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteAgentRepository } from '@infra/persistence/Sqlite.AgentRepository'
import { SqliteCatalogHistoryRepository } from '@infra/persistence/Sqlite.CatalogHistoryRepository'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SqlitePermissionRepository } from '@infra/persistence/Sqlite.PermissionRepository'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { AgentCatalog, ISaveAgentOptions } from './Agent.Catalog'
import { CatalogReader } from './Catalog.Reader'
import { CatalogWriter } from './Catalog.Writer'
import { CatalogHistoryService } from './CatalogHistory.Service'
import { CatalogRestoreUseCase, IRestoreCaller } from './CatalogRestore.Usecase'
import { GuidanceService } from './Guidance.Service'
import { McpServersService } from './McpServers.Service'
import { PermissionsService } from './Permissions.Service'
import { ProjectsService } from './Projects.Service'

const rules = { knownTools: ['alpha_tool', 'beta_tool'], providerOf: () => EProvider.GOOGLE }
const saving = (by: string, creating: boolean): ISaveAgentOptions => ({ rules, by, creating })

const agent = (id: string, patch: Partial<IAgent> = {}): IAgent => ({
  id,
  name: id.toUpperCase(),
  providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }],
  systemPrompt: `Prompt de ${id}`,
  modes: [EMode.CHAT],
  allowedTools: ['alpha_tool'],
  ...patch,
})

const ADMIN: IRestoreCaller = { by: 'root@x.test', viaAccessToken: false }
const CI: IRestoreCaller = { by: 'root@x.test', viaAccessToken: true }

/** Os serviços de escrita de verdade, o histórico ligado a todos, e o rollback por cima deles. */
function build() {
  const repos = {
    agents: new SqliteAgentRepository(':memory:'),
    guidance: new SqliteGuidanceRepository(':memory:'),
    permissions: new SqlitePermissionRepository(':memory:'),
    mcps: new SqliteMcpServerRepository(':memory:'),
    projects: new SqliteProjectRepository(':memory:'),
  }
  const repository = new SqliteCatalogHistoryRepository(':memory:')
  const reader = new CatalogReader(repos)
  const history = new CatalogHistoryService(repository, reader)
  const secrets = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:')
  const agents = new AgentCatalog(repos.agents)
  const guidance = new GuidanceService(
    repos.guidance,
    (projectId) => !!repos.projects.get(projectId),
    (agentId) => {
      const found = agents.rawEntries().find((entry) => entry.agent.id === agentId)?.agent
      return found ? { id: found.id, ...(found.projectId ? { projectId: found.projectId } : {}) } : undefined
    },
  )
  const permissions = new PermissionsService(repos.permissions, () => undefined)
  const mcps = new McpServersService(
    repos.mcps,
    secrets,
    () => agents.rawEntries().map((entry) => entry.agent),
    (projectId) => !!repos.projects.get(projectId),
  )
  const projects = new ProjectsService(
    repos.projects,
    () => agents.rawEntries().map((entry) => entry.agent),
    () => true,
    { create: (id) => `/tmp/${id}`, remove: () => undefined },
  )
  for (const service of [agents, guidance, permissions, mcps, projects]) service.history.use(() => history)

  const changed: string[] = []
  const writer = new CatalogWriter({
    guidance,
    permissions,
    mcps,
    projects,
    agents: { catalog: agents, rules: async () => rules, issues: () => [], defaultAgentId: async () => undefined, removed: (id) => guidance.removeAgent(id) },
    mcpChanged: async (server) => {
      changed.push(`changed:${server.id}`)
    },
    mcpRemoved: async (server) => {
      changed.push(`removed:${server.id}`)
    },
  })
  let ids = 0
  const restore = new CatalogRestoreUseCase({ repository, history, reader, writer, newId: () => `revert-${++ids}` })

  const revisions = (kind: TCatalogKind, id: string) => repository.revisions(kind, id)
  const last = (kind: TCatalogKind, id: string) => repository.latest(kind, id)!.revision
  return { repository, history, reader, secrets, agents, guidance, permissions, mcps, projects, restore, revisions, last, changed }
}

/** Espera a recusa do tipo dado e a devolve. */
async function refused<T extends Error>(work: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await work
  } catch (error: unknown) {
    assert.ok(error instanceof type, `esperava ${type.name}, veio ${String(error)}`)
    return error as T
  }
  throw new assert.AssertionError({ message: `esperava ${type.name}, mas aplicou` })
}

describe('CatalogRestoreUseCase — restaurar uma revisão', () => {
  it('update: o conteúdo antigo volta como revisão NOVA (op restore, nota, quem), sem apagar nenhuma', async () => {
    const { guidance, restore, revisions } = build()
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'Tabelas', body: 'v1' }, 'ana')
    guidance.updateResource('tabela', { body: 'v2' }, 'bia')
    const before = revisions('skill', 'tabela').map((revision) => revision.hash)

    const result = await restore.restore({ item: { kind: 'skill', itemId: 'tabela' }, revision: 1, expectedRevision: 2 }, ADMIN)

    assert.strictEqual(guidance.resource('tabela').body, 'v1')
    assert.strictEqual(result.unchanged, false)
    assert.strictEqual(result.revision?.revision, 3)
    const list = revisions('skill', 'tabela')
    assert.deepStrictEqual(
      list.slice(0, 2).map((revision) => revision.hash),
      before,
    )
    assert.deepStrictEqual([list[2].op, list[2].source, list[2].by, list[2].note], ['restore', 'restore', 'root@x.test', 'restaurado da rev 1'])
    assert.strictEqual(list[2].hash, list[0].hash)
  })

  it('delete: o item apagado volta com o mesmo id; a rule volta no fim da lista do escopo', async () => {
    const { guidance, restore, revisions, last } = build()
    guidance.createDoc({ id: 'guia', kind: 'spec', title: 'Guia', summary: 'S', body: 'B' }, 'ana')
    guidance.deleteDoc('guia', 'bia')
    const rule = guidance.createRule({ title: 'A', body: 'a' }, 'ana')
    guidance.createRule({ title: 'B', body: 'b' }, 'ana')
    guidance.deleteRule(rule.id, 'bia')

    await restore.restore({ item: { kind: 'spec', itemId: 'guia' }, revision: 1, expectedRevision: 2 }, ADMIN)
    await restore.restore({ item: { kind: 'rule', itemId: rule.id }, revision: 1, expectedRevision: last('rule', rule.id) }, ADMIN)

    assert.strictEqual(guidance.doc('guia').body, 'B')
    assert.deepStrictEqual(
      revisions('spec', 'guia').map((revision) => revision.op),
      ['create', 'delete', 'restore'],
    )
    const restored = guidance.rule(rule.id)
    assert.deepStrictEqual([restored.title, restored.position], ['A', 2])
  })

  it('restaurar a revisão de um delete apaga o item (op delete, source restore)', async () => {
    const { guidance, restore, revisions } = build()
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'Tabelas', body: 'v1' }, 'ana')
    guidance.deleteResource('tabela', 'bia')
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'Tabelas', body: 'v3' }, 'caio')

    const result = await restore.restore({ item: { kind: 'skill', itemId: 'tabela' }, revision: 2, expectedRevision: 3 }, ADMIN)

    assert.strictEqual(result.exists, false)
    assert.throws(() => guidance.resource('tabela'))
    const gone = revisions('skill', 'tabela').at(-1)!
    assert.deepStrictEqual([gone.op, gone.source, gone.document], ['delete', 'restore', undefined])
  })

  it('409 com expectedRevision velho (alguém mexeu no meio), e com mudança fora do histórico', async () => {
    const { guidance, restore, repository } = build()
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'Tabelas', body: 'v1' }, 'ana')
    guidance.updateResource('tabela', { body: 'v2' }, 'bia')

    const stale = await refused(restore.restore({ item: { kind: 'skill', itemId: 'tabela' }, revision: 1, expectedRevision: 1 }, ADMIN), CatalogRevisionConflictError)
    assert.strictEqual((stale.current as { revision: number }).revision, 2)

    // Mudou direto no banco: a última revisão não é o estado atual.
    const resource = guidance.resource('tabela')
    ;(guidance as unknown as { repository: { saveResource(item: unknown): void } }).repository.saveResource({ ...resource, body: 'por fora' })
    await refused(restore.restore({ item: { kind: 'skill', itemId: 'tabela' }, revision: 1, expectedRevision: 2 }, ADMIN), CatalogRevisionConflictError)
    assert.strictEqual(repository.revisions('skill', 'tabela').length, 2)
  })

  it('a versão que não passa mais nas regras de hoje é recusada com os problemas (e nada é gravado)', async () => {
    const { guidance, restore, revisions, last } = build()
    guidance.createDoc({ id: 'guia', kind: 'spec', title: 'Guia', summary: 'S', body: 'B' }, 'ana')
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'Tabelas', body: 'v1', docIds: ['guia'] }, 'ana')
    // Apagar o doc o tira da skill (a cascata grava a revisão 2 dela).
    guidance.deleteDoc('guia', 'bia')

    const error = await refused(
      restore.restore({ item: { kind: 'skill', itemId: 'tabela' }, revision: 1, expectedRevision: last('skill', 'tabela') }, ADMIN),
      CatalogRestoreInvalidError,
    )
    assert.deepStrictEqual(error.issues, [{ field: 'docIds', message: 'no such document: guia' }])
    assert.deepStrictEqual(guidance.resource('tabela').docIds, [])
    assert.strictEqual(revisions('skill', 'tabela').length, 2)
  })

  it('versão igual à atual: nada a gravar', async () => {
    const { guidance, restore, revisions } = build()
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'Tabelas', body: 'v1' }, 'ana')
    guidance.updateResource('tabela', { body: 'v2' }, 'bia')
    guidance.updateResource('tabela', { body: 'v1' }, 'caio')

    const result = await restore.restore({ item: { kind: 'skill', itemId: 'tabela' }, revision: 1, expectedRevision: 3 }, ADMIN)
    assert.strictEqual(result.unchanged, true)
    assert.strictEqual(revisions('skill', 'tabela').length, 3)
  })
})

describe('CatalogRestoreUseCase — ampliação de permissão', () => {
  /** Agente com `alpha_tool` e `beta_tool` (rev 1), depois só `alpha_tool` (rev 2): voltar à rev 1 amplia. */
  function widened() {
    const built = build()
    built.agents.save(agent('pesquisa', { allowedTools: ['alpha_tool', 'beta_tool'] }), saving('ana', true))
    built.agents.save(agent('pesquisa'), saving('bia', false))
    return built
  }
  const KEY = 'agent/pesquisa#allowedTools+beta_tool'
  const request = (confirm?: string[]) => ({ item: { kind: 'agent' as const, itemId: 'pesquisa' }, revision: 1, expectedRevision: 2, ...(confirm ? { confirm } : {}) })

  it('sem confirm: recusa com a lista certa (e nada muda)', async () => {
    const { agents, restore } = widened()
    const error = await refused(restore.restore(request(), ADMIN), CatalogWideningConfirmationError)
    assert.deepStrictEqual(
      error.widenings.map((item) => item.key),
      [KEY],
    )
    assert.deepStrictEqual(agents.get('pesquisa')!.allowedTools, ['alpha_tool'])
  })

  it('confirm errado (a mais, a menos, outra chave): recusa', async () => {
    const { restore } = widened()
    for (const confirm of [[], [KEY, 'agent/pesquisa#allowedTools+run_bash'], ['agent/pesquisa#allowedTools+outra']])
      await refused(restore.restore(request(confirm), ADMIN), CatalogWideningConfirmationError)
  })

  it('confirm certo: aplica e grava na revisão as chaves aceitas e quem aceitou', async () => {
    const { agents, restore, revisions } = widened()
    const result = await restore.restore(request([KEY]), ADMIN)

    assert.deepStrictEqual(agents.get('pesquisa')!.allowedTools.sort(), ['alpha_tool', 'beta_tool'])
    assert.deepStrictEqual(
      result.widenings.map((item) => item.key),
      [KEY],
    )
    const saved = revisions('agent', 'pesquisa').at(-1)!
    assert.deepStrictEqual([saved.op, saved.by, saved.widenings], ['restore', 'root@x.test', [KEY]])
  })

  it('token de acesso (CI): recusa mesmo com o confirm certo', async () => {
    const { agents, restore } = widened()
    const error = await refused(restore.restore(request([KEY]), CI), CatalogWideningForbiddenError)
    assert.deepStrictEqual(
      error.widenings.map((item) => item.key),
      [KEY],
    )
    assert.deepStrictEqual(agents.get('pesquisa')!.allowedTools, ['alpha_tool'])
  })

  it('token de acesso aplica o que não amplia', async () => {
    const { agents, restore } = build()
    agents.save(agent('pesquisa'), saving('ana', true))
    agents.save(agent('pesquisa', { allowedTools: ['alpha_tool', 'beta_tool'] }), saving('bia', false))
    await restore.restore({ item: { kind: 'agent', itemId: 'pesquisa' }, revision: 1, expectedRevision: 2 }, CI)
    assert.deepStrictEqual(agents.get('pesquisa')!.allowedTools, ['alpha_tool'])
  })

  it('triggers não ampliam: voltar a versão com outro trigger não pede confirm', async () => {
    const { agents, restore } = build()
    agents.save(agent('pesquisa', { triggers: [{ id: 'deploy', when: 'Sempre', body: 'Rode.' }] }), saving('ana', true))
    agents.save(agent('pesquisa', { triggers: [{ id: 'deploy', when: 'Nunca', body: 'Rode.' }] }), saving('bia', false))
    agents.save(agent('pesquisa'), saving('caio', false))

    await restore.restore({ item: { kind: 'agent', itemId: 'pesquisa' }, revision: 1, expectedRevision: 3 }, CI)
    assert.deepStrictEqual(agents.get('pesquisa')!.triggers, [{ id: 'deploy', when: 'Sempre', body: 'Rode.' }])
  })
})

describe('CatalogRestoreUseCase — MCP', () => {
  it('restaurado sem o segredo: o cofre não é tocado, e o resultado diz o que falta', async () => {
    const { mcps, secrets, restore, last } = build()
    mcps.create({ id: 'n8n', name: 'N8N', url: 'https://n8n.example/mcp', auth: 'header', headerName: 'X-Key', secret: 's3gr3d0' }, 'ana')
    mcps.remove('n8n', 'bia')
    assert.strictEqual(secrets.get('mcp:n8n'), undefined)

    const request = { item: { kind: 'mcp' as const, itemId: 'n8n' }, revision: 1, expectedRevision: last('mcp', 'n8n') }
    // MCP novo global com segredo fixo: amplia — a pessoa vê a lista e confirma.
    const asked = await refused(restore.restore(request, ADMIN), CatalogWideningConfirmationError)
    const result = await restore.restore({ ...request, confirm: asked.widenings.map((item) => item.key) }, ADMIN)

    assert.strictEqual(mcps.get('n8n').auth, 'header')
    assert.strictEqual(mcps.get('n8n').headerName, 'X-Key')
    assert.deepStrictEqual(result.missingSecrets, ['header'])
    assert.strictEqual(secrets.get('mcp:n8n'), undefined)
  })

  it('update: a instância de pé é avisada; desligado volta desligado', async () => {
    const { mcps, restore, changed } = build()
    mcps.create({ id: 'n8n', name: 'N8N', url: 'https://n8n.example/mcp' }, 'ana')
    mcps.update('n8n', { enabled: false }, 'ana')
    mcps.update('n8n', { name: 'Outro nome' }, 'bia')

    await restore.restore({ item: { kind: 'mcp', itemId: 'n8n' }, revision: 2, expectedRevision: 3 }, ADMIN)
    assert.deepStrictEqual([mcps.get('n8n').name, mcps.get('n8n').enabled], ['N8N', false])
    assert.deepStrictEqual(changed, ['changed:n8n'])
  })
})

describe('CatalogRestoreUseCase — reverter lote', () => {
  /**
   * Um lote "de import" (o PR 9 vai gravar assim): doc → skill que o anexa → agente que libera a skill → permissões do
   * projeto com um `deny` novo. Cada passo grava a revisão com o `batchId`.
   */
  function batched() {
    const built = build()
    const { projects, agents, guidance, permissions, history, repository } = built
    projects.create({ id: 'alfa', name: 'Alfa' }, 'ana')
    permissions.saveProjectRules('alfa', [{ category: 'terminal', pattern: 'git *', decision: 'allow' }], 'ana')
    agents.save(agent('pesquisa'), saving('ana', true))
    guidance.setAgentResources('pesquisa', { skills: [], commands: [] }, 'ana')

    repository.createBatch({ id: 'lote-1', at: new Date(), by: 'ci', kind: 'import', scope: 'all', summary: {}, widenings: [], status: 'applied' })
    const step = (kind: TCatalogKind, id: string, work: () => void) => history.within({ kind, id }, { by: 'ci', source: 'import', op: 'import', batchId: 'lote-1' }, work)
    step('spec', 'guia', () => guidance.createDoc({ id: 'guia', kind: 'spec', title: 'Guia', summary: 'S', body: 'B' }, 'ci'))
    step('skill', 'tabela', () => guidance.createResource({ id: 'tabela', kind: 'skill', description: 'Tabelas', body: 'faça', docIds: ['guia'] }, 'ci'))
    step('agent', 'pesquisa', () => guidance.setAgentResources('pesquisa', { skills: ['tabela'], commands: [] }, 'ci'))
    step('project-permissions', 'alfa', () =>
      permissions.saveProjectRules(
        'alfa',
        [
          { category: 'terminal', pattern: 'git *', decision: 'allow' },
          { category: 'terminal', pattern: 'git push *', decision: 'deny' },
        ],
        'ci',
      ),
    )
    return built
  }
  const DENY = 'project-permissions/alfa#rules-deny:terminal:git push *'

  it('em ordem inversa, como um lote novo; a ampliação é calculada sobre o conjunto', async () => {
    const { restore, repository, guidance, permissions } = batched()

    const asked = await refused(restore.revert({ batchId: 'lote-1' }, ADMIN), CatalogWideningConfirmationError)
    assert.deepStrictEqual(
      asked.widenings.map((item) => item.key),
      [DENY],
    )
    await refused(restore.revert({ batchId: 'lote-1', confirm: [DENY] }, CI), CatalogWideningForbiddenError)

    const result = await restore.revert({ batchId: 'lote-1', confirm: [DENY] }, ADMIN)

    assert.deepStrictEqual(
      repository.batchRevisions(result.batch.id).map((revision) => `${revision.kind}/${revision.itemId}:${revision.op}`),
      ['project-permissions/alfa:restore', 'agent/pesquisa:restore', 'skill/tabela:delete', 'spec/guia:delete'],
    )
    assert.deepStrictEqual([result.batch.kind, result.batch.status, result.batch.by], ['revert', 'applied', 'root@x.test'])
    assert.deepStrictEqual(
      result.batch.widenings.map((item) => item.key),
      [DENY],
    )
    assert.strictEqual(repository.batch('lote-1')!.status, 'reverted')
    assert.deepStrictEqual(repository.latest('project-permissions', 'alfa')!.widenings, [DENY])
    assert.throws(() => guidance.doc('guia'))
    assert.throws(() => guidance.resource('tabela'))
    assert.deepStrictEqual(guidance.agentResources('pesquisa').skills, [])
    assert.strictEqual(permissions.projectRules('alfa').rules.length, 1)

    // Já revertido: não reverte de novo.
    await refused(restore.revert({ batchId: 'lote-1', confirm: [DENY] }, ADMIN), CatalogRevisionConflictError)
  })

  it('item que mudou depois do lote é pulado (conflito) e o lote fica partial; com overwrite, entra', async () => {
    const { restore, guidance, repository } = batched()
    guidance.updateDoc('guia', { body: 'mexido depois' }, 'bia')

    const result = await restore.revert({ batchId: 'lote-1', confirm: [DENY] }, ADMIN)
    assert.deepStrictEqual(
      result.conflicts.map((item) => item.ref),
      ['spec/guia'],
    )
    assert.strictEqual(result.batch.status, 'partial')
    assert.strictEqual(guidance.doc('guia').body, 'mexido depois')
    assert.strictEqual(repository.batch('lote-1')!.status, 'applied')

    // O resto já voltou; o doc, só confirmado um a um. Na segunda volta o resto não muda (`unchanged`).
    const again = await restore.revert({ batchId: 'lote-1', overwrite: ['spec/guia'] }, ADMIN)
    assert.deepStrictEqual(
      again.reverted.map((item) => item.ref),
      ['spec/guia'],
    )
    assert.strictEqual(again.batch.status, 'applied')
    assert.throws(() => guidance.doc('guia'))
  })
})
