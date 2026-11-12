import assert from 'node:assert'
import { describe, it } from 'node:test'
import { InvalidLedgerError, LedgerNotFoundError } from '@domain/errors/Domain.Error'
import { TLedgerAuthor } from '@domain/models/Ledger.Model'
import { SqliteLedgerRepository } from '@infra/persistence/Sqlite.LedgerRepository'
import { ILedgerAgentInfo, LedgerService } from './Ledger.Service'

const AGENTS: Record<string, ILedgerAgentInfo> = {
  theo: { id: 'theo' },
  ana: { id: 'ana', projectId: 'xpto' },
  rui: { id: 'rui', projectId: 'crm' },
  ben: { id: 'ben', projectId: 'xpto' },
  zeus: { id: 'zeus', adminOnly: true },
  maya: { id: 'maya', adminOnly: true },
}
const THEO: TLedgerAuthor = { kind: 'agent', agentId: 'theo', conversationId: 'c-1' }
const ADMIN: TLedgerAuthor = { kind: 'admin', email: 'root@x.test' }

function service(clock = { now: new Date('2026-11-03T12:00:00Z') }) {
  return new LedgerService(new SqliteLedgerRepository(), { get: (id) => AGENTS[id] }, () => clock.now)
}

const create = (ledger: LedgerService, topic = 'build-oom', by = THEO) => ledger.write('theo', { action: 'criar', topic, trigger: 'quando o build estourar memória no CI' }, by)

describe('LedgerService — escrita', () => {
  it('criar: tema normalizado, gatilho obrigatório, revisão com o autor; criar de novo o mesmo tema é recusado', () => {
    const ledger = service()
    const result = ledger.write('theo', { action: 'criar', topic: 'Build OOM', trigger: '  quando o build estourar memória no CI ', playbook: '# heap' }, THEO)
    assert.strictEqual(result.topic, 'build-oom')
    assert.strictEqual(result.context?.trigger, 'quando o build estourar memória no CI')
    assert.strictEqual(result.context?.playbook, '# heap')
    assert.deepStrictEqual(result.context?.createdBy, THEO)
    assert.strictEqual(result.index.contexts.length, 1)
    assert.throws(
      () => create(ledger),
      (error: unknown) => error instanceof InvalidLedgerError && error.issues[0].message.startsWith('already exists'),
    )
    assert.throws(
      () => ledger.write('theo', { action: 'criar', topic: 'outro', trigger: 'curto' }, THEO),
      (error: unknown) => error instanceof InvalidLedgerError && error.issues[0].field === 'trigger',
    )
    const revisions = ledger.revisions('theo', 'build-oom')
    assert.strictEqual(revisions.length, 1)
    assert.deepStrictEqual(
      { action: revisions[0].action, by: revisions[0].by, after: revisions[0].after },
      {
        action: 'criar',
        by: THEO,
        after: { trigger: 'quando o build estourar memória no CI', playbook: '# heap' },
      },
    )
  })

  it('gatilho e playbook: antes e depois na revisão; o mesmo texto não grava nada', () => {
    const ledger = service()
    create(ledger)
    const changed = ledger.write('theo', { action: 'gatilho', topic: 'build-oom', trigger: 'quando o build do front estourar memória' }, ADMIN)
    assert.strictEqual(changed.changed, true)
    assert.deepStrictEqual(changed.context?.updatedBy, ADMIN)
    assert.strictEqual(ledger.write('theo', { action: 'gatilho', topic: 'build-oom', trigger: 'quando o build do front estourar memória' }, ADMIN).changed, false)
    ledger.write('theo', { action: 'playbook', topic: 'build-oom', playbook: '## Árvore\n- a' }, THEO)
    const cleared = ledger.write('theo', { action: 'playbook', topic: 'build-oom', playbook: '' }, THEO)
    assert.strictEqual(cleared.context?.playbook, '')
    const [last, middle, first] = ledger.revisions('theo', 'build-oom')
    assert.deepStrictEqual([last.action, middle.action, first.action], ['playbook', 'playbook', 'gatilho'])
    assert.deepStrictEqual(first.before, { trigger: 'quando o build estourar memória no CI', playbook: '' })
    assert.deepStrictEqual(first.by, ADMIN)
    assert.deepStrictEqual(last.after, { trigger: 'quando o build do front estourar memória', playbook: '' })
  })

  it('linha_nova, linha_editar, linha_apagar: validação, data de hoje por padrão, alias de tipo, revisão de cada uma', () => {
    const ledger = service()
    create(ledger)
    const added = ledger.write(
      'theo',
      { action: 'linha_nova', topic: 'build-oom', line: { type: 'regra' as never, trigger: 'build no CI', learning: 'subir o heap para 4 GB', ref: 'ci.yml' } },
      THEO,
    )
    const line = added.context!.lines[0]
    assert.deepStrictEqual({ date: line.date, type: line.type, learning: line.learning }, { date: '2026-11-03', type: 'APRENDIZADO', learning: 'subir o heap para 4 GB' })
    assert.throws(
      () => ledger.write('theo', { action: 'linha_nova', topic: 'build-oom', line: { type: 'APRENDIZADO', trigger: 'x', learning: 'y'.repeat(301) } }, THEO),
      (error: unknown) => error instanceof InvalidLedgerError && error.issues.some((issue) => issue.field === 'learning'),
    )
    const migrated = ledger.write(
      'theo',
      { action: 'linha_nova', topic: 'build-oom', line: { type: 'DIFICULDADE', trigger: 'lock', learning: 'bati num lock do git', date: '2026-06-09' } },
      THEO,
    )
    assert.strictEqual(migrated.context!.lines[1].date, '2026-06-09')

    const edited = ledger.write('theo', { action: 'linha_editar', topic: 'build-oom', lineId: line.id, line: { learning: 'subir o heap para 6 GB' } }, ADMIN)
    assert.strictEqual(edited.context!.lines[0].learning, 'subir o heap para 6 GB')
    assert.strictEqual(edited.context!.lines[0].ref, 'ci.yml')
    assert.throws(() => ledger.write('theo', { action: 'linha_editar', topic: 'build-oom', lineId: line.id, line: {} }, ADMIN), InvalidLedgerError)

    const removed = ledger.write('theo', { action: 'linha_apagar', topic: 'build-oom', lineId: line.id }, THEO)
    assert.strictEqual(removed.context!.lines.length, 1)
    assert.throws(() => ledger.write('theo', { action: 'linha_apagar', topic: 'build-oom', lineId: line.id }, THEO), LedgerNotFoundError)

    const actions = ledger.revisions('theo', 'build-oom').map((revision) => [revision.action, revision.lineId])
    assert.deepStrictEqual(actions, [
      ['linha_apagar', line.id],
      ['linha_editar', line.id],
      ['linha_nova', migrated.context!.lines[1].id],
      ['linha_nova', line.id],
      ['criar', undefined],
    ])
    const edit = ledger.revisions('theo', 'build-oom')[1]
    assert.strictEqual((edit.before as { learning: string }).learning, 'subir o heap para 4 GB')
    assert.strictEqual((edit.after as { learning: string }).learning, 'subir o heap para 6 GB')
  })

  it('⛔ a linha de OUTRO contexto não se edita pelo tema errado', () => {
    const ledger = service()
    create(ledger)
    create(ledger, 'wireguard')
    const line = ledger.write('theo', { action: 'linha_nova', topic: 'wireguard', line: { type: 'APRENDIZADO', trigger: 'vpn', learning: 'reiniciar o wg0' } }, THEO).context!
      .lines[0]
    assert.throws(() => ledger.write('theo', { action: 'linha_apagar', topic: 'build-oom', lineId: line.id }, THEO), LedgerNotFoundError)
  })

  it('excluir: sai com as linhas; a revisão guarda o que saiu e o histórico do tema continua legível', () => {
    const ledger = service()
    create(ledger)
    ledger.write('theo', { action: 'linha_nova', topic: 'build-oom', line: { type: 'APRENDIZADO', trigger: 'ci', learning: 'heap 4 GB' } }, THEO)
    const result = ledger.write('theo', { action: 'excluir', topic: 'build-oom' }, ADMIN)
    assert.strictEqual(result.context, undefined)
    assert.deepStrictEqual(result.index.contexts, [])
    assert.strictEqual(result.index.lineCount, 0)
    const [gone] = ledger.revisions('theo', 'build-oom')
    assert.strictEqual(gone.action, 'excluir')
    assert.strictEqual((gone.before as { lines: unknown[] }).lines.length, 1)
    assert.throws(() => ledger.context('theo', 'build-oom'), LedgerNotFoundError)
  })

  it('⛔ agente que não existe: nada se lê nem se escreve; contexto inexistente sugere o tema parecido', () => {
    const ledger = service()
    assert.throws(() => ledger.write('fantasma', { action: 'criar', topic: 'x-y', trigger: 'quando algo acontecer de novo' }, ADMIN), LedgerNotFoundError)
    create(ledger, 'wireguard-vpn')
    assert.throws(
      () => ledger.write('theo', { action: 'gatilho', topic: 'wireguard', trigger: 'quando a VPN cair de novo' }, THEO),
      (error: unknown) => error instanceof LedgerNotFoundError && error.message.includes('did you mean wireguard-vpn'),
    )
  })

  it('o ledger é POR AGENTE: o mesmo tema em dois agentes são dois contextos', () => {
    const ledger = service()
    create(ledger)
    ledger.write('ana', { action: 'criar', topic: 'build-oom', trigger: 'quando o build dela estourar memória' }, ADMIN)
    assert.strictEqual(ledger.context('theo', 'build-oom').trigger, 'quando o build estourar memória no CI')
    assert.strictEqual(ledger.context('ana', 'build-oom').trigger, 'quando o build dela estourar memória')
  })
})

describe('LedgerService — leitura', () => {
  it('índice com contagem e avisos; busca sem acento em linhas, gatilhos e playbooks', () => {
    const ledger = service()
    create(ledger)
    ledger.write('theo', { action: 'criar', topic: 'deploy', trigger: 'RETOMAR o deploy de produção amanhã', playbook: 'usar kubectl rollout' }, THEO)
    ledger.write('theo', { action: 'linha_nova', topic: 'build-oom', line: { type: 'APRENDIZADO', trigger: 'compilação', learning: 'subir o heap para 4 GB' } }, THEO)
    const index = ledger.index('theo')
    assert.deepStrictEqual(
      index.contexts.map((context) => [context.topic, context.lineCount, context.hasPlaybook]),
      [
        ['build-oom', 1, false],
        ['deploy', 0, true],
      ],
    )
    assert.ok(index.warnings.some((warning) => warning.code === 'state-verb' && warning.topic === 'deploy'))
    assert.deepStrictEqual(
      index.contexts.find((context) => context.topic === 'deploy')?.warnings.map((warning) => warning.code),
      ['state-verb'],
    )
    assert.deepStrictEqual(
      ledger.search('theo', 'COMPILACAO heap').lines.map((line) => line.topic),
      ['build-oom'],
    )
    assert.deepStrictEqual(
      ledger.search('theo', 'kubectl').contexts.map((context) => context.topic),
      ['deploy'],
    )
    assert.deepStrictEqual(ledger.search('theo', '   ').lines, [])
  })

  it('a seção do prompt é a do agente (só tema → gatilho)', () => {
    const ledger = service()
    assert.strictEqual(ledger.promptSection('theo'), undefined)
    create(ledger)
    ledger.write('theo', { action: 'linha_nova', topic: 'build-oom', line: { type: 'APRENDIZADO', trigger: 'ci', learning: 'segredo do conteúdo' } }, THEO)
    const section = ledger.promptSection('theo')!
    assert.ok(section.includes('- build-oom — quando o build estourar memória no CI'))
    assert.ok(!section.includes('segredo do conteúdo'), 'o conteúdo nunca vai no prompt')
    assert.strictEqual(ledger.promptSection('ana'), undefined)
  })

  it('⛔ visibilidade para ler o de outro: o global e os do projeto da conversa (ou do leitor); só-admin só para só-admin', () => {
    const ledger = service()
    assert.ok(ledger.canRead({ agentId: 'theo' }, 'theo'))
    assert.ok(ledger.canRead({ agentId: 'ana' }, 'theo'), 'global: todos leem')
    assert.ok(!ledger.canRead({ agentId: 'theo' }, 'ana'), 'de projeto: fora da conversa do projeto, não')
    assert.ok(ledger.canRead({ agentId: 'theo', conversationProjectId: 'xpto' }, 'ana'), 'na conversa do projeto dele, sim')
    assert.ok(!ledger.canRead({ agentId: 'ana', conversationProjectId: 'xpto' }, 'rui'), 'de outro projeto, não')
    assert.ok(!ledger.canRead({ agentId: 'theo' }, 'zeus'), 'só-admin: um agente comum não lê')
    // ⛔ Agente de projeto numa conversa de OUTRO projeto (compartilhado): os ledgers do projeto de origem ficam de fora.
    assert.ok(ledger.canRead({ agentId: 'ana' }, 'ben'), 'sem conversa de outro projeto, o projeto do leitor vale')
    assert.ok(!ledger.canRead({ agentId: 'ana', conversationProjectId: 'outro' }, 'ben'), 'a origem não vai junto')
    assert.ok(ledger.canRead({ agentId: 'ana', conversationProjectId: 'xpto' }, 'ana'), 'o próprio sempre')
    assert.ok(ledger.canRead({ agentId: 'maya' }, 'zeus'), 'só-admin lê só-admin')
    assert.ok(!ledger.canRead({ agentId: 'theo' }, 'fantasma'))
  })

  it('o export usa o formato das pastas', () => {
    const ledger = service()
    create(ledger)
    const files = ledger.exportFiles('theo')
    assert.deepStrictEqual(Object.keys(files).sort(), ['theo-ledger/contextos/build-oom.md', 'theo-ledger/index.md'])
  })
})

describe('LedgerService — o agente global num projeto', () => {
  const line = { type: 'APRENDIZADO' as const, trigger: 'deploy na .4', learning: 'nunca drenar o turno' }

  it('⚖️ o dono no projeto: o que ele aprende no bh fica no bh; a base aparece em todo projeto, marcada', () => {
    const ledger = service()
    create(ledger, 'deploy')
    ledger.write('theo', { action: 'linha_nova', topic: 'deploy', line }, THEO)
    const bh = ledger.owner('theo', 'bh')
    assert.strictEqual(bh, 'theo@bh')
    // Agente de projeto: o dono é ele mesmo, em qualquer conversa.
    assert.strictEqual(ledger.owner('ana', 'bh'), 'ana')
    assert.strictEqual(ledger.owner('theo', undefined), 'theo')

    ledger.write(bh, { action: 'criar', topic: 'crm-bh', trigger: 'quando mexer no CRM do BH' }, THEO)
    assert.deepStrictEqual(
      ledger.index(bh).contexts.map((context) => [context.topic, !!context.base]),
      [
        ['crm-bh', false],
        ['deploy', true],
      ],
    )
    assert.deepStrictEqual(
      ledger.index(ledger.owner('theo', 'xpto')).contexts.map((context) => context.topic),
      ['deploy'],
    )
    assert.deepStrictEqual(
      ledger.index('theo').contexts.map((context) => context.topic),
      ['deploy'],
    )
    assert.strictEqual(ledger.context(bh, 'deploy').base, true)
    assert.match(ledger.promptSection(bh) ?? '', /crm-bh/)
    assert.ok(!(ledger.promptSection('theo') ?? '').includes('crm-bh'))
  })

  it('⚖️ escrever num tema da base copia para o projeto (o id da linha lida segue valendo); a base não muda; apagar a base daqui, não', () => {
    const ledger = service()
    create(ledger, 'deploy')
    const baseLine = ledger.write('theo', { action: 'linha_nova', topic: 'deploy', line }, THEO).context!.lines[0].id
    const bh = ledger.owner('theo', 'bh')
    ledger.write(bh, { action: 'linha_editar', topic: 'deploy', lineId: baseLine, line: { learning: 'no BH, drenar com aviso' } }, THEO)
    assert.strictEqual(ledger.context(bh, 'deploy').base, undefined)
    assert.deepStrictEqual(
      ledger.context(bh, 'deploy').lines.map((item) => item.learning),
      ['no BH, drenar com aviso'],
    )
    assert.deepStrictEqual(
      ledger.context('theo', 'deploy').lines.map((item) => item.learning),
      ['nunca drenar o turno'],
    )
    assert.throws(() => ledger.write(ledger.owner('theo', 'xpto'), { action: 'excluir', topic: 'deploy' }, THEO), InvalidLedgerError)
    assert.throws(() => ledger.write(ledger.owner('theo', 'xpto'), { action: 'criar', topic: 'deploy', trigger: 'de novo, outra vez' }, THEO), InvalidLedgerError)
    // ⛔ Agente de projeto não tem dono por projeto.
    assert.throws(() => ledger.requireAgent('ana@bh'), LedgerNotFoundError)
  })
})
