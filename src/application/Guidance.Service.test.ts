import assert from 'node:assert'
import { describe, it } from 'node:test'
import { GuidanceNotFoundError, InvalidGuidanceError } from '@domain/errors/Domain.Error'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { GuidanceService } from './Guidance.Service'

describe('GuidanceService', () => {
  const build = () => new GuidanceService(new SqliteGuidanceRepository(':memory:'), (id) => ['xpto', 'crm'].includes(id))
  const rule = (title: string, projectId?: string | null) => ({ title, body: `corpo de ${title}`, projectId })
  const doc = (id: string, projectId?: string | null) => ({ id, kind: 'spec' as const, title: `T ${id}`, summary: `resumo ${id}`, body: `# ${id}\n\ntexto`, projectId })

  it('numera as rules por escopo (Rule 1, 2…) e renumera depois de apagar', () => {
    const service = build()
    const a = service.createRule(rule('a'), 'root')
    service.createRule(rule('b'), 'root')
    const c = service.createRule(rule('c'), 'root')
    const local = service.createRule(rule('x', 'xpto'), 'root')
    assert.deepStrictEqual([a.position, c.position, local.position], [1, 3, 1])

    service.deleteRule(a.id)
    assert.deepStrictEqual(
      service.rules(null).map((item) => [item.title, item.position]),
      [
        ['b', 1],
        ['c', 2],
      ],
    )
  })

  it('sobe e desce trocando com a vizinha; na ponta fica onde está', () => {
    const service = build()
    service.createRule(rule('a'), 'root')
    const b = service.createRule(rule('b'), 'root')
    assert.deepStrictEqual(
      service.moveRule(b.id, 'up', 'root').map((item) => item.title),
      ['b', 'a'],
    )
    assert.deepStrictEqual(
      service.moveRule(b.id, 'up', 'root').map((item) => item.title),
      ['b', 'a'],
    )
  })

  it('trocar o escopo leva a rule para o fim do novo e renumera o antigo', () => {
    const service = build()
    const a = service.createRule(rule('a'), 'root')
    service.createRule(rule('b'), 'root')
    service.createRule(rule('x', 'xpto'), 'root')
    const moved = service.updateRule(a.id, { projectId: 'xpto' }, 'root')
    assert.deepStrictEqual([moved.projectId, moved.position], ['xpto', 2])
    assert.deepStrictEqual(
      service.rules(null).map((item) => [item.title, item.position]),
      [['b', 1]],
    )
  })

  it('⛔ recusa rule sem título ou corpo e projeto que não existe, tudo de uma vez', () => {
    const service = build()
    assert.throws(
      () => service.createRule({ title: '', body: ' ', projectId: 'nada' }, 'root'),
      (error: unknown) => error instanceof InvalidGuidanceError && error.issues.map((issue) => issue.field).join() === 'title,body,projectId',
    )
    assert.throws(() => service.updateRule('nao-existe', { title: 'x' }, 'root'), GuidanceNotFoundError)
  })

  it('o documento: id em slug e único; o corpo é obrigatório', () => {
    const service = build()
    service.createDoc(doc('api-v2'), 'root')
    assert.throws(
      () => service.createDoc(doc('api-v2'), 'root'),
      (error: unknown) => error instanceof InvalidGuidanceError && error.issues[0].message.startsWith('already exists'),
    )
    assert.throws(
      () => service.createDoc({ ...doc('Com Espaço'), body: '' }, 'root'),
      (error: unknown) => error instanceof InvalidGuidanceError && error.issues.length === 2,
    )
  })

  it('o prompt: rules ligadas (globais e depois as do projeto) e o índice de documentos; nada cadastrado, nada', () => {
    const service = build()
    assert.strictEqual(service.environmentFor('xpto'), undefined)

    service.createRule(rule('Português'), 'root')
    service.createRule({ ...rule('Desligada'), enabled: false }, 'root')
    service.createRule(rule('Só no XPTO', 'xpto'), 'root')
    service.createRule(rule('Só no CRM', 'crm'), 'root')
    service.createDoc(doc('global-doc'), 'root')
    service.createDoc({ ...doc('adr-1', 'xpto'), kind: 'adr' }, 'root')

    const text = service.environmentFor('xpto')!
    assert.match(text, /## Regras do ambiente[\s\S]*1\. \*\*Português\*\* — corpo de Português\n2\. \*\*Só no XPTO\*\*/)
    assert.doesNotMatch(text, /Desligada|Só no CRM/)
    assert.match(text, /## Documentos de referência[\s\S]*- \[spec\] global-doc — T global-doc: resumo global-doc\n- \[adr\] adr-1 — T adr-1/)
    assert.doesNotMatch(service.environmentFor()!, /XPTO|adr-1/)
  })

  it('⛔ read_doc: o global e o do projeto da conversa; o de outro projeto é como se não existisse', () => {
    const service = build()
    service.createDoc(doc('global-doc'), 'root')
    service.createDoc(doc('do-crm', 'crm'), 'root')
    assert.strictEqual(service.readDoc('global-doc', 'xpto')?.id, 'global-doc')
    assert.strictEqual(service.readDoc('do-crm', 'crm')?.id, 'do-crm')
    assert.strictEqual(service.readDoc('do-crm', 'xpto'), undefined)
    assert.strictEqual(service.readDoc('do-crm'), undefined)
    assert.deepStrictEqual([service.hasDocs('xpto'), build().hasDocs('xpto')], [true, false])
  })

  it('apagar o projeto leva as rules e os documentos dele', () => {
    const service = build()
    service.createRule(rule('g'), 'root')
    service.createRule(rule('x', 'xpto'), 'root')
    service.createDoc(doc('do-xpto', 'xpto'), 'root')
    service.removeProject('xpto')
    assert.deepStrictEqual([service.rules('xpto').length, service.docs('xpto').length, service.rules(null).length], [0, 0, 1])
  })
})
