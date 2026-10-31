import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentDocument, docDocument, ICatalogDocument, mcpDocument, projectDocument, resourceDocument } from '@domain/Catalog.Document'
import { withBody } from '@domain/Catalog.Import'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { CatalogImportBlockedError, CatalogPlanChangedError, CatalogWideningConfirmationError, CatalogWideningForbiddenError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { buildCatalogStack } from '../testing/Catalog.Fixture'
import { IRestoreCaller } from './CatalogRestore.Usecase'

const at = new Date('2026-10-30T12:00:00.000Z')
const ADMIN: IRestoreCaller = { by: 'root@x.test', viaAccessToken: false }
const CI: IRestoreCaller = { by: 'ci@x.test', viaAccessToken: true }

const spec = (id: string, body = 'Corpo', projectId?: string) =>
  docDocument({ id, kind: 'spec', ...(projectId ? { projectId } : {}), title: id.toUpperCase(), summary: 'S', body, docIds: [], createdAt: at, updatedAt: at })
const skill = (id: string, docIds: string[] = [], projectId?: string) =>
  resourceDocument({ id, kind: 'skill', ...(projectId ? { projectId } : {}), description: 'D', body: 'Corpo', docIds, createdAt: at, updatedAt: at })
const agent = (patch: Partial<IAgent> & { id: string }, links = { resources: { skills: ['*'], commands: ['*'] }, initialContext: [] as string[] }) =>
  agentDocument(
    {
      name: patch.id.toUpperCase(),
      providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }],
      systemPrompt: `Prompt de ${patch.id}`,
      modes: [EMode.CHAT],
      allowedTools: [],
      ...patch,
    },
    links,
  )

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

describe('CatalogImportApplier — aplicar o import', () => {
  it('create e update na ordem do plano, cada escrita com revisão import/import dentro de UM lote applied', async () => {
    const stack = buildCatalogStack()
    stack.guidance.createDoc({ id: 'guia', kind: 'spec', title: 'GUIA', summary: 'S', body: 'v1' }, 'ana')
    const documents = [skill('tabela', ['guia', 'novo']), spec('novo'), withBody(stack.reader.read('spec', 'guia')!, { ...stack.reader.read('spec', 'guia')!.body, body: 'v2' })]
    const { plan } = await stack.applier.plan({ documents })
    assert.deepStrictEqual(
      plan.order.map((step) => step.ref),
      ['spec/guia', 'spec/novo', 'skill/tabela'],
    )

    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN)

    assert.strictEqual(stack.guidance.doc('guia').body, 'v2')
    assert.deepStrictEqual(stack.guidance.resource('tabela').docIds, ['guia', 'novo'])
    assert.strictEqual(result.batch?.status, 'applied')
    assert.strictEqual(result.batch?.kind, 'import')
    assert.strictEqual(result.failed, undefined)
    assert.deepStrictEqual(
      result.applied.map((step) => [step.ref, step.op, step.revision]),
      [
        ['spec/guia', 'update', 2],
        ['spec/novo', 'create', 1],
        ['skill/tabela', 'create', 1],
      ],
    )
    const revisions = stack.repository.batchRevisions(result.batch!.id)
    assert.deepStrictEqual(
      revisions.map((revision) => [`${revision.kind}/${revision.itemId}`, revision.op, revision.source, revision.by]),
      [
        ['spec/guia', 'import', 'import', 'root@x.test'],
        ['spec/novo', 'import', 'import', 'root@x.test'],
        ['skill/tabela', 'import', 'import', 'root@x.test'],
      ],
    )
    assert.deepStrictEqual((result.batch!.summary as { applied: string[] }).applied, ['spec/guia', 'spec/novo', 'skill/tabela'])

    // De novo, o mesmo: tudo unchanged, nada a gravar, nenhum lote.
    const again = await stack.applier.plan({ documents })
    const noop = await stack.applier.apply({ documents, planHash: again.plan.planHash }, ADMIN)
    assert.strictEqual(noop.batch, undefined)
    assert.deepStrictEqual(noop.applied, [])
  })

  it('planHash velho: 409 com o plano novo, nada gravado', async () => {
    const stack = buildCatalogStack()
    const documents = [spec('novo')]
    const { plan } = await stack.applier.plan({ documents })
    stack.guidance.createDoc({ id: 'novo', kind: 'spec', title: 'X', summary: 'S', body: 'outro' }, 'bia')

    const error = await refused(stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN), CatalogPlanChangedError)
    const fresh = error.plan as typeof plan
    assert.notStrictEqual(fresh.planHash, plan.planHash)
    assert.strictEqual(fresh.items[0].op, 'update')
    assert.strictEqual(stack.guidance.doc('novo').body, 'outro')
    assert.deepStrictEqual(stack.repository.batches({}, { offset: 0, limit: 10 }).total, 0)
  })

  it('item com error ou conflict bloqueia o apply inteiro: nada é gravado, nem o que estava certo', async () => {
    const stack = buildCatalogStack()
    stack.guidance.createResource({ id: 'ocupado', kind: 'command', description: 'D', body: 'B' }, 'ana')
    // `fantasma` cita um doc que não existe (error); `ocupado` é command e o pacote diz skill (conflict).
    const documents = [spec('ok'), skill('fantasma', ['nao-existe']), skill('ocupado')]
    const { plan } = await stack.applier.plan({ documents })
    assert.deepStrictEqual(
      plan.items.map((item) => `${item.ref}:${item.op}`),
      ['spec/ok:create', 'skill/fantasma:error', 'skill/ocupado:conflict'],
    )

    const error = await refused(stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN), CatalogImportBlockedError)
    assert.deepStrictEqual(
      error.blockers.map((item) => `${item.ref}:${item.op}`),
      ['skill/fantasma:error', 'skill/ocupado:conflict'],
    )
    assert.strictEqual(stack.reader.read('spec', 'ok'), undefined)
    assert.strictEqual(stack.repository.batches({}, { offset: 0, limit: 10 }).total, 0)
  })

  it('ampliação: sem confirm e com confirm errado = 409; por token = 403 mesmo com confirm; confirm certo grava e registra quem aceitou', async () => {
    const stack = buildCatalogStack()
    const documents = [agent({ id: 'theo', allowedTools: ['alpha_tool'] })]
    const { plan } = await stack.applier.plan({ documents })
    const keys = plan.widenings.map((widening) => widening.key)
    assert.ok(keys.includes('agent/theo#allowedTools+alpha_tool'), keys.join(', '))

    await refused(stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN), CatalogWideningConfirmationError)
    await refused(stack.applier.apply({ documents, planHash: plan.planHash, confirm: ['agent/theo#allowedTools+beta_tool'] }, ADMIN), CatalogWideningConfirmationError)
    await refused(stack.applier.apply({ documents, planHash: plan.planHash, confirm: keys }, CI), CatalogWideningForbiddenError)
    assert.strictEqual(stack.agents.entry('theo'), undefined)

    // Por token, o plano marca o item: a ampliação não se aplica assim.
    const viaToken = await stack.applier.plan({ documents }, { viaAccessToken: true })
    assert.strictEqual(viaToken.plan.items[0].blockedByToken, true)
    assert.strictEqual(viaToken.plan.planHash, plan.planHash)

    const result = await stack.applier.apply({ documents, planHash: plan.planHash, confirm: keys }, ADMIN)
    assert.deepStrictEqual(stack.agents.entry('theo')?.agent.allowedTools, ['alpha_tool'])
    assert.deepStrictEqual(
      result.batch!.widenings.map((widening) => [widening.kind, widening.itemId, widening.key]),
      keys.map((key) => ['agent', 'theo', key]),
    )
    const revision = stack.repository.latest('agent', 'theo')!
    assert.deepStrictEqual([revision.op, revision.by, revision.batchId, revision.widenings], ['import', 'root@x.test', result.batch!.id, keys])

    // Sem ampliação, confirm a mais também é recusado: a pessoa viu outra coisa.
    const quiet = [spec('so-texto')]
    const quietPlan = await stack.applier.plan({ documents: quiet })
    await refused(stack.applier.apply({ documents: quiet, planHash: quietPlan.plan.planHash, confirm: keys }, ADMIN), CatalogWideningConfirmationError)
    // E por token, o que não amplia passa.
    const viaCi = await stack.applier.apply({ documents: quiet, planHash: quietPlan.plan.planHash }, CI)
    assert.strictEqual(viaCi.batch?.status, 'applied')
  })

  it('falha no meio: o lote fica partial, a resposta aponta a reversão, e reverter desfaz o que entrou', async () => {
    const stack = buildCatalogStack({
      wrapWriter: (writer) => ({
        prepare: async (target, current) => {
          if (target?.id === 'quebra') throw new Error('o disco encheu')
          return writer.prepare(target, current)
        },
      }),
    })
    const documents = [spec('primeiro'), spec('segundo'), skill('quebra', ['primeiro']), skill('depois')]
    const { plan } = await stack.applier.plan({ documents })
    assert.deepStrictEqual(
      plan.order.map((step) => step.ref),
      ['spec/primeiro', 'spec/segundo', 'skill/depois', 'skill/quebra'],
    )

    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN)

    assert.strictEqual(result.batch?.status, 'partial')
    assert.deepStrictEqual(result.failed, { ref: 'skill/quebra', message: 'o disco encheu' })
    assert.deepStrictEqual(result.pending, [])
    assert.deepStrictEqual(result.revert, { batchId: result.batch!.id, method: 'POST', path: `/v1/catalog/batches/${result.batch!.id}/revert` })
    const summary = stack.repository.batch(result.batch!.id)!.summary as { applied: string[]; failed: { ref: string } }
    assert.deepStrictEqual(summary.applied, ['spec/primeiro', 'spec/segundo', 'skill/depois'])
    assert.strictEqual(summary.failed.ref, 'skill/quebra')
    assert.ok(stack.reader.read('spec', 'primeiro'))
    assert.strictEqual(stack.reader.read('skill', 'quebra'), undefined)

    const revert = await stack.restore.revert({ batchId: result.batch!.id }, ADMIN)
    assert.strictEqual(revert.batch.status, 'applied')
    assert.strictEqual(stack.repository.batch(result.batch!.id)!.status, 'reverted')
    assert.strictEqual(stack.reader.read('spec', 'primeiro'), undefined)
    assert.strictEqual(stack.reader.read('spec', 'segundo'), undefined)
    assert.strictEqual(stack.reader.read('skill', 'depois'), undefined)
  })

  it('para no primeiro erro: os passos seguintes ficam pendentes e intactos', async () => {
    const stack = buildCatalogStack({
      wrapWriter: (writer) => ({
        prepare: async (target, current) => {
          if (target?.id === 'aaa') throw new Error('falhou')
          return writer.prepare(target, current)
        },
      }),
    })
    const documents = [spec('aaa'), spec('bbb'), skill('ccc')]
    const { plan } = await stack.applier.plan({ documents })
    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN)
    assert.deepStrictEqual(result.applied, [])
    assert.deepStrictEqual(result.pending, [{ ref: 'spec/bbb' }, { ref: 'skill/ccc' }])
    assert.strictEqual(stack.reader.read('spec', 'bbb'), undefined)
    assert.strictEqual(result.batch?.status, 'partial')
  })

  it('MCP que pede segredo que o cofre não tem entra DESLIGADO, e a resposta diz o que falta', async () => {
    const stack = buildCatalogStack()
    const documents = [
      mcpDocument({
        id: 'crm',
        name: 'CRM',
        url: 'https://crm.example.com/mcp',
        transport: 'auto',
        auth: 'header',
        headerName: 'X-Key',
        enabled: true,
        createdAt: at,
        updatedAt: at,
      }),
    ]
    const { plan } = await stack.applier.plan({ documents })
    assert.strictEqual(plan.items[0].entersDisabled, true)
    assert.deepStrictEqual(plan.items[0].missingSecrets, ['header'])

    const result = await stack.applier.apply({ documents, planHash: plan.planHash, confirm: plan.widenings.map((widening) => widening.key) }, ADMIN)
    assert.strictEqual(stack.mcps.list().find((server) => server.id === 'crm')?.enabled, false)
    assert.deepStrictEqual(result.entersDisabled, ['mcp/crm'])
    assert.deepStrictEqual(result.missingSecrets, [{ ref: 'mcp/crm', secrets: ['header'] }])
    assert.deepStrictEqual((result.batch!.summary as { entersDisabled: string[] }).entersDisabled, ['mcp/crm'])
  })

  it('projeto em duas partes: o registro sem o contexto inicial, os docs, e depois o contexto (links)', async () => {
    const stack = buildCatalogStack()
    const documents: ICatalogDocument[] = [projectDocument({ id: 'beta', name: 'Beta', createdAt: at, updatedAt: at }, ['sb']), spec('sb', 'Corpo', 'beta')]
    const { plan } = await stack.applier.plan({ documents })
    assert.deepStrictEqual(
      plan.order.map((step) => `${step.ref}${step.part ? `#${step.part}` : ''}`),
      ['project/beta#record', 'spec/sb', 'project/beta#links'],
    )

    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN)
    assert.strictEqual(result.batch?.status, 'applied')
    assert.deepStrictEqual(stack.reader.read('project', 'beta')?.body.initialContext, ['sb'])
    const project = stack.repository.revisions('project', 'beta')
    assert.strictEqual(project.length, 2)
    assert.deepStrictEqual(
      project.map((revision) => [revision.op, revision.batchId, revision.note]),
      [
        ['import', result.batch!.id, `import do lote ${result.batch!.id} (o registro, sem o contexto inicial)`],
        ['import', result.batch!.id, `import do lote ${result.batch!.id} (o contexto inicial)`],
      ],
    )
    assert.deepStrictEqual(stack.reader.read('project', 'beta')?.hash, documents[0].hash)
  })

  it('a ida e volta: o pacote do export de um gateway aplicado num banco limpo dá o mesmo hash item a item', async () => {
    const source = buildCatalogStack()
    source.projects.create({ id: 'alfa', name: 'Alfa', description: 'Projeto' }, 'ana')
    source.guidance.createDoc({ id: 'arq', kind: 'spec', projectId: 'alfa', title: 'Arq', summary: 'S', body: 'B' }, 'ana')
    source.guidance.createResource({ id: 'revisar', kind: 'skill', projectId: 'alfa', description: 'D', body: 'B', docIds: ['arq'] }, 'ana')
    source.guidance.setInitialContext('alfa', ['arq'], 'ana')
    const documents = source.reader.list({ kind: 'all' })

    const target = buildCatalogStack()
    const { plan } = await target.applier.plan({ documents })
    const result = await target.applier.apply({ documents, planHash: plan.planHash }, ADMIN)
    assert.strictEqual(result.batch?.status, 'applied')
    assert.deepStrictEqual(
      target.reader.list({ kind: 'all' }).map((document) => [document.kind, document.id, document.hash]),
      documents.map((document) => [document.kind, document.id, document.hash]),
    )
  })

  it('lista de lotes: do mais novo ao mais velho, com o estado e quantos itens; filtro por projeto e por tipo', async () => {
    const stack = buildCatalogStack()
    stack.projects.create({ id: 'alfa', name: 'Alfa' }, 'ana')
    const global = [spec('g1')]
    const local = [spec('a1', 'B', 'alfa'), spec('a2', 'B', 'alfa')]
    const one = await stack.applier.apply({ documents: global, planHash: (await stack.applier.plan({ documents: global })).plan.planHash }, ADMIN)
    const two = await stack.applier.apply(
      {
        documents: local,
        scope: { kind: 'project', projectId: 'alfa' },
        planHash: (await stack.applier.plan({ documents: local, scope: { kind: 'project', projectId: 'alfa' } })).plan.planHash,
      },
      ADMIN,
    )
    const all = stack.repository.batches({}, { offset: 0, limit: 10 })
    assert.strictEqual(all.total, 2)
    assert.deepStrictEqual(
      all.batches.map((batch) => [batch.id, batch.scope, batch.status, batch.items]),
      [
        [two.batch!.id, 'project:alfa', 'applied', 2],
        [one.batch!.id, 'all', 'applied', 1],
      ],
    )
    assert.deepStrictEqual(
      stack.repository.batches({ projectId: 'alfa' }, { offset: 0, limit: 10 }).batches.map((batch) => batch.id),
      [two.batch!.id],
    )
    // O lote de escopo `all` que gravou no global aparece no global.
    assert.deepStrictEqual(
      stack.repository.batches({ projectId: '' }, { offset: 0, limit: 10 }).batches.map((batch) => batch.id),
      [one.batch!.id],
    )
    assert.strictEqual(stack.repository.batches({ kind: 'revert' }, { offset: 0, limit: 10 }).total, 0)
  })
})
