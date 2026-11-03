import assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  ledgerExportFiles,
  ledgerPromptSection,
  ledgerWarnings,
  lineIssues,
  lineText,
  lineTypeOf,
  similarTopics,
  stateVerbOf,
  topicIssues,
  topicSlug,
  triggerIssues,
} from './Ledger.Policy'

const at = (day: number) => new Date(Date.UTC(2026, 10, day))

describe('Ledger.Policy — validação', () => {
  it('o tema vira slug (sem acento, minúsculo, hífen) e o slug curto demais é recusado', () => {
    assert.strictEqual(topicSlug('  Diagnóstico de Rede (VPN) '), 'diagnostico-de-rede-vpn')
    assert.deepStrictEqual(topicIssues(topicSlug('build-oom')), [])
    assert.strictEqual(topicIssues(topicSlug('!')).length, 1)
    assert.strictEqual(topicIssues('x').length, 1)
  })

  it('⛔ o gatilho é obrigatório, de uma linha e com substância (≥ 15 caracteres)', () => {
    assert.deepStrictEqual(triggerIssues('ao subir o build e estourar memória'), [])
    assert.ok(triggerIssues(undefined).some((issue) => issue.message === 'required'))
    assert.ok(triggerIssues('   ').some((issue) => issue.message === 'required'))
    assert.ok(triggerIssues('curto').some((issue) => issue.message.startsWith('too short')))
    assert.ok(triggerIssues('quando o build\nestourar memória').some((issue) => issue.message === 'must be a single line'))
  })

  it('a linha: tipo do enum, campos de uma linha, aprendizado até 300, data AAAA-MM-DD; a edição só confere o que veio', () => {
    const ok = { type: 'APRENDIZADO' as const, trigger: 'build no CI', learning: 'subir o heap para 4 GB resolve', ref: 'ci.yml' }
    assert.deepStrictEqual(lineIssues(ok), [])
    assert.deepStrictEqual(
      lineIssues({ ...ok, type: 'OUTRO' as never })
        .map((issue) => issue.field)
        .sort(),
      ['type'],
    )
    assert.ok(lineIssues({ ...ok, learning: 'x'.repeat(301) }).some((issue) => issue.field === 'learning'))
    assert.ok(lineIssues({ ...ok, learning: 'duas\nlinhas' }).some((issue) => issue.message === 'must be a single line'))
    assert.ok(lineIssues({ ...ok, date: '03/11/2026' }).some((issue) => issue.field === 'date'))
    assert.ok(lineIssues({ type: 'POSTURA' }).some((issue) => issue.field === 'learning'))
    assert.deepStrictEqual(lineIssues({ learning: 'só o aprendizado' }, true), [])
  })

  it('o tipo aceita os dois nomes de cada classe da spec (REGRA, MODO, FALHA) e o rótulo inteiro', () => {
    assert.strictEqual(lineTypeOf('regra'), 'APRENDIZADO')
    assert.strictEqual(lineTypeOf('MODO'), 'POSTURA')
    assert.strictEqual(lineTypeOf('Falha'), 'DIFICULDADE')
    assert.strictEqual(lineTypeOf('DIFICULDADE/FALHA'), 'DIFICULDADE')
    assert.strictEqual(lineTypeOf('qualquer'), undefined)
  })
})

describe('Ledger.Policy — saúde', () => {
  it('⚠️ verbo de estado de missão (RETOMAR, PRÓXIMO PASSO, pendente, aguarda), sem acento nem caixa', () => {
    assert.strictEqual(stateVerbOf('RETOMAR o deploy'), 'retomar')
    assert.strictEqual(stateVerbOf('Próximo passo: rodar'), 'proximo passo')
    assert.strictEqual(stateVerbOf('ainda aguardando o review'), 'aguardando')
    assert.strictEqual(stateVerbOf('quando o build estourar memória'), undefined)
  })

  it('temas parecidos: prefixo por palavra ou iguais espremidos; temas só com a mesma primeira palavra não', () => {
    assert.ok(similarTopics('wireguard', 'wireguard-vpn'))
    assert.ok(similarTopics('build-oom', 'buildooms'))
    assert.ok(!similarTopics('build-oom', 'build-cache'))
    assert.ok(!similarTopics('a-b', 'a-b'))
  })

  it('cada aviso: gatilho ausente e fraco, verbo de estado (gatilho e linha), contexto vazio, > 40 linhas, temas parecidos', () => {
    const warnings = ledgerWarnings({
      contexts: [
        { topic: 'sem-gatilho', trigger: 'curto', playbook: 'algo' },
        { topic: 'fraco', trigger: 'deploy-de-producao-kubernetes', playbook: '' },
        { topic: 'missao', trigger: 'RETOMAR a migração do banco amanhã', playbook: 'x' },
        { topic: 'wireguard', trigger: 'quando a VPN entre nós cair', playbook: '' },
        { topic: 'wireguard-vpn', trigger: 'quando a VPN entre nós cair de novo', playbook: '' },
      ],
      lines: [
        ...Array.from({ length: 41 }, (_, index) => ({ id: index + 1, topic: 'fraco', trigger: 'deploy', learning: 'aplicar com --wait' })),
        { id: 99, topic: 'wireguard', trigger: 'vpn caiu', learning: 'pendente: falar com o time de rede' },
      ],
    })
    const codes = (topic: string | undefined) =>
      warnings
        .filter((warning) => warning.topic === topic)
        .map((warning) => warning.code)
        .sort()
    assert.deepStrictEqual(codes('sem-gatilho'), ['trigger-missing'])
    assert.deepStrictEqual(codes('fraco'), ['trigger-weak'])
    assert.deepStrictEqual(codes('missao'), ['state-verb'])
    assert.deepStrictEqual(codes('wireguard'), ['similar-topics', 'state-verb'])
    assert.deepStrictEqual(codes('wireguard-vpn'), ['empty-context'])
    assert.deepStrictEqual(codes(undefined), ['too-many-lines'])
    assert.strictEqual(warnings.find((warning) => warning.code === 'similar-topics')?.related, 'wireguard-vpn')
    assert.strictEqual(warnings.find((warning) => warning.code === 'state-verb' && warning.topic === 'wireguard')?.lineId, 99)
  })
})

describe('Ledger.Policy — o índice no prompt', () => {
  it('só tema → gatilho e a regra de leitura e escrita; nada sem contexto', () => {
    assert.strictEqual(ledgerPromptSection([]), undefined)
    const section = ledgerPromptSection([
      { topic: 'wireguard', trigger: 'quando a VPN entre nós cair', updatedAt: at(2) },
      { topic: 'build-oom', trigger: 'quando o build estourar memória', updatedAt: at(1) },
    ])!
    assert.ok(section.startsWith('## Ledger'))
    assert.ok(section.includes('Antes de diagnosticar, operar ou de tarefa recorrente'))
    assert.ok(section.includes('`ledger_read`') && section.includes('`ledger_write`'))
    // Em ordem de tema, sem o conteúdo.
    assert.ok(section.indexOf('- build-oom — quando o build estourar memória') < section.indexOf('- wireguard — quando a VPN entre nós cair'))
    assert.ok(!section.includes('mais:'))
  })

  it('⚖️ com teto: 60 contextos (os mais recentes) e o rabo "…N mais"', () => {
    const contexts = Array.from({ length: 70 }, (_, index) => ({
      topic: `tema-${String(index).padStart(2, '0')}`,
      trigger: 'quando algo acontece',
      updatedAt: at(1 + (index % 28)),
    }))
    contexts[69].updatedAt = new Date(Date.UTC(2027, 0, 1))
    const section = ledgerPromptSection(contexts)!
    assert.strictEqual(section.split('\n').filter((line) => line.startsWith('- tema-')).length, 60)
    assert.ok(section.includes('- tema-69 —'), 'o mais recente entra')
    assert.ok(section.endsWith('- …10 mais: `ledger_read` sem tema.'))
  })

  it('⚖️ com teto de ~4 KB: gatilhos longos cortam antes dos 60', () => {
    const contexts = Array.from({ length: 40 }, (_, index) => ({ topic: `tema-${index}`, trigger: `quando ${'x'.repeat(200)}`, updatedAt: at(1) }))
    const section = ledgerPromptSection(contexts)!
    assert.ok(section.length <= 4_000 + 60)
    const shown = section.split('\n').filter((line) => line.startsWith('- tema-')).length
    assert.ok(shown < 40)
    assert.ok(section.endsWith(`- …${40 - shown} mais: \`ledger_read\` sem tema.`))
  })
})

describe('Ledger.Policy — export no formato das pastas', () => {
  it('`<agente>-ledger/index.md` (mapa de gatilhos) e `contextos/<tema>.md` com o @trigger no stamp, as linhas e o playbook', () => {
    const files = ledgerExportFiles('theo', [
      {
        context: { topic: 'build-oom', trigger: 'quando o build | estourar memória', playbook: '```\nheap\n```', updatedAt: at(3), updatedBy: { kind: 'agent', agentId: 'theo' } },
        lines: [{ date: '2026-11-01', type: 'APRENDIZADO', trigger: 'build no CI', learning: 'subir o heap para 4 GB', ref: 'ci.yml' }],
      },
    ])
    assert.deepStrictEqual(Object.keys(files).sort(), ['theo-ledger/contextos/build-oom.md', 'theo-ledger/index.md'])
    assert.ok(files['theo-ledger/index.md'].includes('| build-oom | quando o build \\| estourar memória | [contextos/build-oom.md](contextos/build-oom.md) |'))
    const context = files['theo-ledger/contextos/build-oom.md']
    assert.ok(context.includes('# @trigger     quando o build | estourar memória'))
    assert.ok(context.includes('- [2026-11-01] | APRENDIZADO/REGRA | build no CI | subir o heap para 4 GB | ci.yml'))
    assert.ok(context.includes('## Playbook\n\n```\nheap\n```'))
  })

  it('a linha sem ref não ganha o separador do fim', () => {
    assert.strictEqual(
      lineText({ date: '2026-11-01', type: 'POSTURA', trigger: 'review', learning: 'perguntar antes de reescrever', ref: '' }),
      '[2026-11-01] | POSTURA/MODO | review | perguntar antes de reescrever',
    )
  })
})
