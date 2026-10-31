import assert from 'node:assert'
import { describe, it } from 'node:test'
import { applyImportOps, builderKindForItem, IImportApplied, IImportSourceText, missingRemovalOks, TImportOp, verifyImportDraft } from './Import.Draft'

const SPEC = [
  '<!-- gerado por agents-sync em 2026-01-01 -->',
  '# Arquitetura',
  '',
  'Última revisão: 2025-12-02 por maya',
  '',
  'Leia `.agents/specs/filas.md` antes de mexer.',
  '',
  '### Camadas',
  'Domínio no centro.',
  '',
  '## Histórico',
  'Tudo que mudou.',
  '',
].join('\n')

const spec = (text = SPEC): IImportSourceText[] => [{ path: '.agents/specs/arquitetura.md', aliases: ['.claude/specs/arquitetura.md'], text }]
const META: TImportOp[] = [
  { op: 'setMeta', field: 'id', value: 'arquitetura' },
  { op: 'setMeta', field: 'title', value: 'Arquitetura' },
  { op: 'setMeta', field: 'summary', value: 'As camadas do projeto.' },
]

function applied(result: ReturnType<typeof applyImportOps>): IImportApplied {
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.issues))
  return result.applied
}

function issues(result: ReturnType<typeof applyImportOps>): string[] {
  assert.ok(!result.ok, 'devia recusar')
  return result.issues.map((issue) => `${issue.field}: ${issue.message}`)
}

describe('Import.Draft — operações', () => {
  it('só metadados: o corpo é a fonte, sem as linhas em branco das pontas', () => {
    const out = applied(applyImportOps('spec', spec(), META))
    assert.strictEqual(out.outputs.length, 1)
    assert.strictEqual(out.outputs[0].fields.body, SPEC.trimEnd())
    assert.deepStrictEqual(out.meta, { id: 'arquitetura', title: 'Arquitetura', summary: 'As camadas do projeto.' })
    assert.ok(out.diffs[0].diff.equal)
  })

  it('remove: tira o trecho exato, com motivo; trecho inexistente falha', () => {
    const out = applied(applyImportOps('spec', spec(), [...META, { op: 'remove', text: 'Última revisão: 2025-12-02 por maya\n\n', reason: 'carimbo de histórico' }]))
    assert.ok(!out.outputs[0].fields.body!.includes('Última revisão'))
    assert.deepStrictEqual(
      out.removals.map((removal) => [removal.op, removal.reason, removal.whole]),
      [[3, 'carimbo de histórico', false]],
    )
    assert.strictEqual(out.diffs[0].diff.removed, 2)
    assert.match(issues(applyImportOps('spec', spec(), [...META, { op: 'remove', text: 'não está lá', reason: 'x' }])).join('\n'), /ops\[3\]\.text: excerpt not found/)
    assert.match(issues(applyImportOps('spec', spec(), [...META, { op: 'remove', text: 'Domínio', reason: '' }])).join('\n'), /reason: required/)
  })

  it('a ocorrência: trecho repetido sem ocorrência falha; com ela, tira a certa; ocorrência que não existe falha', () => {
    const text = 'a\nCARIMBO\nb\nCARIMBO\nc'
    assert.match(issues(applyImportOps('spec', spec(text), [...META, { op: 'remove', text: 'CARIMBO\n', reason: 'x' }])).join('\n'), /appears 2 times/)
    const out = applied(applyImportOps('spec', spec(text), [...META, { op: 'remove', text: 'CARIMBO\n', occurrence: 2, reason: 'x' }]))
    assert.strictEqual(out.outputs[0].fields.body, 'a\nCARIMBO\nb\nc')
    assert.match(issues(applyImportOps('spec', spec(text), [...META, { op: 'remove', text: 'CARIMBO\n', occurrence: 3, reason: 'x' }])).join('\n'), /2 occurrence/)
  })

  it('remove whole: a fonte inteira sai (com motivo), e não pode ser usada depois', () => {
    const sources: IImportSourceText[] = [
      { path: 'a.md', text: '# A\n' },
      { path: 'gerado.md', text: '<!-- NÃO EDITAR -->\nmontado\n' },
    ]
    const out = applied(
      applyImportOps('spec', sources, [
        ...META,
        { op: 'remove', whole: true, source: 'gerado.md', reason: 'bootstrap gerado' },
        { op: 'compose', into: 'body', sources: ['a.md'] },
      ]),
    )
    assert.strictEqual(out.outputs[0].fields.body, '# A')
    assert.strictEqual(out.removals[0].whole, true)
    assert.strictEqual(out.removals[0].text, '<!-- NÃO EDITAR -->\nmontado\n')
    const after = issues(
      applyImportOps('spec', sources, [
        ...META,
        { op: 'remove', whole: true, source: 'gerado.md', reason: 'x' },
        { op: 'remove', source: 'gerado.md', text: 'montado', reason: 'x' },
      ]),
    )
    assert.match(after.join('\n'), /removed whole/)
  })

  it('linkCitation: o caminho vira o id e o vínculo vai ao painel; o tipo do vínculo depende do tipo', () => {
    const op: TImportOp = { op: 'linkCitation', text: '.agents/specs/filas.md', target: 'filas', link: 'reference' }
    const out = applied(applyImportOps('spec', spec(), [...META, op]))
    assert.ok(out.outputs[0].fields.body!.includes('Leia `filas` antes de mexer.'))
    assert.deepStrictEqual(out.links, [{ op: 3, source: '.agents/specs/arquitetura.md', text: '.agents/specs/filas.md', target: 'filas', link: 'reference' }])
    assert.match(issues(applyImportOps('spec', spec(), [...META, { ...op, link: 'initialContext' }])).join('\n'), /attach or reference/)
    assert.match(issues(applyImportOps('rule', spec(), [{ op: 'setMeta', field: 'title', value: 'x' }, op])).join('\n'), /no panel link/)
    // ⛔ Não é atalho para trocar texto: o trecho tem de parecer um caminho citado.
    assert.match(issues(applyImportOps('spec', spec(), [...META, { ...op, text: 'Domínio no centro.' }])).join('\n'), /cited path/)
    assert.match(issues(applyImportOps('spec', spec(), [...META, { ...op, target: 'Outro Texto' }])).join('\n'), /target/)
  })

  it('heading: muda o nível da linha inteira; trecho que não é a linha de um título falha', () => {
    const out = applied(applyImportOps('spec', spec(), [...META, { op: 'heading', text: '### Camadas', level: 2 }]))
    assert.ok(out.outputs[0].fields.body!.includes('\n## Camadas\n'))
    assert.match(issues(applyImportOps('spec', spec(), [...META, { op: 'heading', text: 'Camadas', level: 2 }])).join('\n'), /whole markdown heading line/)
    assert.match(issues(applyImportOps('spec', spec(), [...META, { op: 'heading', text: '### Camadas', level: 3 }])).join('\n'), /already level 3/)
  })

  it('split: a seção do título vira outro item, até o próximo título do mesmo nível ou acima', () => {
    const out = applied(
      applyImportOps('spec', spec(), [...META, { op: 'split', text: '## Histórico', meta: { id: 'arquitetura-historico', title: 'Histórico', summary: 'O que mudou.' } }]),
    )
    assert.strictEqual(out.outputs.length, 2)
    assert.ok(!out.outputs[0].fields.body!.includes('Histórico'))
    assert.deepStrictEqual(out.outputs[1], {
      from: 'split',
      meta: { id: 'arquitetura-historico', title: 'Histórico', summary: 'O que mudou.' },
      fields: { body: '## Histórico\nTudo que mudou.' },
    })
    assert.match(issues(applyImportOps('spec', spec(), [...META, { op: 'split', text: '## Histórico', meta: { title: 'sem id' } }])).join('\n'), /meta\.id: required/)
  })

  it('metadados: só os do tipo, obrigatórios presentes, id em slug', () => {
    const found = issues(
      applyImportOps('spec', spec(), [
        { op: 'setMeta', field: 'id', value: 'Não Slug' },
        { op: 'setMeta', field: 'body', value: 'texto livre' },
      ]),
    )
    assert.match(found.join('\n'), /meta\.id: lowercase/)
    assert.match(found.join('\n'), /meta\.body: not a spec field/)
    assert.match(found.join('\n'), /meta\.title: required/)
  })

  it('compose de agente: junta as fontes declaradas na soul e no prompt, na ordem, sem reescrever; fonte esquecida falha', () => {
    const sources: IImportSourceText[] = [
      { path: 'maya/identity.md', text: '# Maya\nQuem sou.\n' },
      { path: 'maya/soul.md', text: 'A alma.\n' },
      { path: 'maya/AGENT.md', text: '# Regras\nFaça X.\n' },
      { path: 'maya/bootstrap.md', text: '<!-- gerado -->\n' },
    ]
    const meta: TImportOp[] = [
      { op: 'setMeta', field: 'id', value: 'maya' },
      { op: 'setMeta', field: 'name', value: 'Maya' },
    ]
    const ops: TImportOp[] = [
      ...meta,
      { op: 'compose', into: 'soul', sources: ['maya/identity.md', 'maya/soul.md'] },
      { op: 'compose', into: 'systemPrompt', sources: ['maya/AGENT.md'] },
      { op: 'remove', whole: true, source: 'maya/bootstrap.md', reason: 'gerado das outras fontes' },
    ]
    const out = applied(applyImportOps('agent', sources, ops))
    assert.deepStrictEqual(out.outputs[0].fields, { soul: '# Maya\nQuem sou.\n\nA alma.', systemPrompt: '# Regras\nFaça X.' })
    assert.match(issues(applyImportOps('agent', sources, ops.slice(0, 4))).join('\n'), /left out: maya\/bootstrap\.md/)
    assert.match(issues(applyImportOps('agent', sources, [...meta, { op: 'compose', into: 'body', sources: ['maya/soul.md'] }])).join('\n'), /soul or systemPrompt/)
    assert.match(issues(applyImportOps('agent', sources, [...meta, { op: 'remove', text: 'Faça X.', reason: 'x' }])).join('\n'), /say which/)
    assert.match(issues(applyImportOps('agent', sources, [...meta, { op: 'split', source: 'maya/AGENT.md', text: '# Regras', meta: {} }])).join('\n'), /not split/)
  })

  it('a fonte pode ser dita pelo alias (o mesmo arquivo por link)', () => {
    const out = applied(applyImportOps('spec', spec(), [...META, { op: 'heading', source: '.claude/specs/arquitetura.md', text: '### Camadas', level: 2 }]))
    assert.ok(out.outputs[0].fields.body!.includes('## Camadas'))
  })

  it('não há operação de texto livre: tipo desconhecido é recusado', () => {
    const ops = [...META, { op: 'replace', text: 'Domínio', with: 'Outra coisa' } as unknown as TImportOp]
    assert.match(issues(applyImportOps('spec', spec(), ops)).join('\n'), /ops\[3\]\.op: one of/)
  })

  it('o construtor de cada tipo: trigger vai ao de agentes; mcp e config não têm', () => {
    assert.strictEqual(builderKindForItem('trigger'), 'agent')
    assert.strictEqual(builderKindForItem('knowledge'), 'knowledge')
    assert.strictEqual(builderKindForItem('mcp'), undefined)
    assert.strictEqual(builderKindForItem('unknown'), undefined)
  })
})

describe('Import.Draft — conferência', () => {
  const ops: TImportOp[] = [
    ...META,
    { op: 'remove', text: '<!-- gerado por agents-sync em 2026-01-01 -->\n', reason: 'cabeçalho de gerado' },
    { op: 'linkCitation', text: '.agents/specs/filas.md', target: 'filas', link: 'attach' },
  ]
  const draft = () => ({ kind: 'spec' as const, ops, ...applied(applyImportOps('spec', spec(), ops)) })

  it('o rascunho que veio das operações confere', () => {
    assert.deepStrictEqual(verifyImportDraft(draft(), spec()), [])
  })

  it('⛔ qualquer mudança no texto final fora das operações é recusada (um caractere, uma linha a mais)', () => {
    const one = draft()
    one.outputs[0].fields.body = one.outputs[0].fields.body!.replace('Domínio no centro.', 'Domínio no centro!')
    assert.match(JSON.stringify(verifyImportDraft(one, spec())), /differs from source \+ operations/)
    const extra = draft()
    extra.outputs[0].fields.body += '\n\nUma regra que o modelo inventou.'
    assert.notDeepStrictEqual(verifyImportDraft(extra, spec()), [])
  })

  it('⛔ remoção, vínculo ou metadado que não estão nas operações são recusados', () => {
    const removal = draft()
    removal.removals = []
    assert.match(JSON.stringify(verifyImportDraft(removal, spec())), /removals/)
    const link = draft()
    link.links = [{ ...link.links[0], target: 'outra' }]
    assert.match(JSON.stringify(verifyImportDraft(link, spec())), /links/)
    const meta = draft()
    meta.meta = { ...meta.meta, title: 'Outro título' }
    assert.match(JSON.stringify(verifyImportDraft(meta, spec())), /metadata/)
  })

  it('⛔ a fonte mudou: as operações não aplicam mais (ou o texto final difere)', () => {
    assert.notDeepStrictEqual(verifyImportDraft(draft(), spec(SPEC.replace('<!-- gerado por agents-sync em 2026-01-01 -->\n', ''))), [])
    assert.notDeepStrictEqual(verifyImportDraft(draft(), spec(`${SPEC}\nlinha nova\n`)), [])
  })

  it('o OK de cada remoção: a que falta aparece pelo índice da operação', () => {
    assert.deepStrictEqual(missingRemovalOks(draft(), []), [3])
    assert.deepStrictEqual(missingRemovalOks(draft(), [3]), [])
  })
})
