import assert from 'node:assert'
import { describe, it } from 'node:test'
import { candidateId, citationNoise, citationsIn, extractCitations, frontmatter, generatedSources, ICitation, locateCitation, resolveCitation } from './Import.Refs'

describe('Import.Refs — as citações de um arquivo importado', () => {
  it('acha caminho solto, entre crases, em link de markdown e no {file:}; ignora URL', () => {
    const text = 'Leia `.agents/specs/a.md`, [b](../b.md#topo), {file:./p.md} e specs/c.yaml. Não: https://x.test/d.md e e.md/'
    assert.deepStrictEqual(extractCitations(text), ['./p.md', '../b.md', '.agents/specs/a.md', 'specs/c.yaml'])
  })

  it('cabeçalho de gerado devolve as fontes; sem marcador, não é gerado', () => {
    assert.deepStrictEqual(generatedSources('<!-- NÃO EDITAR: edite as fontes: a/x.md, b/y.md -->\n\ncorpo cita z.md'), ['a/x.md', 'b/y.md'])
    assert.deepStrictEqual(generatedSources('// DO NOT EDIT\n'), [])
    assert.strictEqual(generatedSources('# normal\nDO NOT EDIT só lá embaixo'.padStart(4000, ' ')), undefined)
  })

  it('⛔ a resolução nunca sai da raiz; tenta o arquivo, a raiz e o .agents/', () => {
    const files = new Set(['.agents/specs/a.md', 'docs/b.md'])
    const resolve = (path: string) => (files.has(path) ? path : undefined)
    assert.strictEqual(resolveCitation('specs/a.md', '.agents/skills/x/SKILL.md', resolve), '.agents/specs/a.md')
    assert.strictEqual(resolveCitation('../../docs/b.md', '.agents/x/y.md', resolve), 'docs/b.md')
    assert.strictEqual(resolveCitation('../../../etc/passwd.md', 'a.md', resolve), undefined)
    assert.strictEqual(resolveCitation('~/docs/b.md', 'a.md', resolve), undefined)
  })

  it('o id candidato segue o padrão do tipo e é cortado no limite', () => {
    assert.deepStrictEqual(candidateId('spec', 'Arquitetura/Decisão Única'), { id: 'arquitetura-decisao-unica', cut: false })
    const long = candidateId('skill', 'x'.repeat(60))
    assert.deepStrictEqual([long.id.length, long.cut], [48, true])
    assert.strictEqual(candidateId('agent', '!').id, 'item')
  })

  it('frontmatter: o nível de cima, como texto', () => {
    assert.deepStrictEqual(frontmatter('---\nagent: "maya"\ndescription: sobe\n---\ncorpo'), { agent: 'maya', description: 'sobe' })
    assert.deepStrictEqual(frontmatter('sem frontmatter'), {})
  })
})

describe('Import.Refs — o que não é referência quebrada', () => {
  const FILES = ['.agents/specs/core/anatomia.md', '.agents/agents/maya/soul.md', '.agents/agents/maya/triggers/01.md', 'a/README.md', 'b/README.md', 'docs/guia.md']
  const resolve = (path: string) => (FILES.includes(path) ? path : undefined)
  const byName = (name: string) => FILES.filter((path) => path.split('/').pop() === name)
  const locate = (citation: ICitation | string, from = '.agents/agents/maya/triggers/01.md') =>
    locateCitation(typeof citation === 'string' ? { cited: citation } : citation, from, resolve, byName)

  it('o token sai inteiro: marcador e coringa não viram caco (`-memory.md`, `.gen.md`)', () => {
    const text = 'Veja `{alias}-memory.md`, `<nome>-soul.md`, `*-evolution.md`, `generated/*.gen.md`, `$DIR/x.md`, `.../y.md` e <docs/guia.md>.'
    assert.deepStrictEqual(extractCitations(text), ['{alias}-memory.md', '<nome>-soul.md', '*-evolution.md', 'generated/*.gen.md', '$DIR/x.md', '.../y.md', 'docs/guia.md'])
  })

  it('uma forma de ruído por motivo', () => {
    const cases: Array<[string, string | undefined]> = [
      ['https://x.test/a.md', 'url'],
      ['*.md', 'glob'],
      ['specs/**/x.md', 'glob'],
      ['a/?.md', 'glob'],
      ['pages/[id].md', 'glob'],
      ['{a,b}.md', 'glob'],
      ['{alias}-soul.md', 'placeholder'],
      ['<nome>-memory.md', 'placeholder'],
      ['$HOME/x.md', 'placeholder'],
      ['${DIR}/x.md', 'placeholder'],
      ['%APPDATA%/x.md', 'placeholder'],
      ['.../x.md', 'placeholder'],
      ['IMP-XXX.md', 'placeholder'],
      ['ADR-NNN.md', 'placeholder'],
      ['YYYY-MM-DD-ata.md', 'placeholder'],
      ['path/to/file.md', 'placeholder'],
      ['path', 'placeholder'],
      ['-02.md', 'fragment'],
      ['.gen.md', 'fragment'],
      ['docs/guia.md', undefined],
      ['.eslintrc.json', 'fragment'],
      ['2026-08-14-ata.md', undefined],
    ]
    assert.deepStrictEqual(
      cases.map(([cited]) => [cited, citationNoise(cited)]),
      cases,
    )
  })

  it('ruído que existe na árvore resolve (a forma só decide quando NÃO resolve)', () => {
    assert.deepStrictEqual(locate('docs/guia.md'), { found: 'docs/guia.md' })
    assert.deepStrictEqual(locate('*.md'), { skip: 'glob' })
  })

  it('chamada de código não é citação: `r.json()`', () => {
    const [call] = citationsIn('const d = await fetch(u).then((r) => r.json())')
    assert.deepStrictEqual(call, { cited: 'r.json', call: true })
    assert.deepStrictEqual(locate(call), { skip: 'code' })
  })

  it('absoluto da máquina vira "fora do repositório"; absoluto do repositório resolve pela raiz', () => {
    assert.deepStrictEqual(extractCitations('Em /Users/ana/notas.md, ~/x.md e /docs/guia.md'), ['/Users/ana/notas.md', '~/x.md', '/docs/guia.md'])
    assert.deepStrictEqual(locate('/Users/ana/notas.md'), { skip: 'outside' })
    assert.deepStrictEqual(locate('/home/bob/a.md'), { skip: 'outside' })
    assert.deepStrictEqual(locate('~/x.md'), { skip: 'outside' })
    assert.deepStrictEqual(locate('/docs/guia.md'), { found: 'docs/guia.md' })
    assert.deepStrictEqual(locate('../../outro-repo/a.md', 'docs/guia.md'), { skip: 'outside' }, '⛔ subir acima da raiz é fora, nunca resolve')
  })

  it('bloco cercado e árvore desenhada marcam "em exemplo"; uma vez fora do exemplo já vale', () => {
    const text = ['```', 'x/so-exemplo.md', 'docs/guia.md', '```', '├── arvore.md', 'fora: docs/guia.md', '~~~', 'dentro.md', '```', 'ainda.md', '~~~'].join('\n')
    assert.deepStrictEqual(citationsIn(text), [
      { cited: 'x/so-exemplo.md', example: true },
      { cited: 'docs/guia.md' },
      { cited: 'arvore.md', example: true },
      { cited: 'dentro.md', example: true },
      { cited: 'ainda.md', example: true },
    ])
  })

  it('caminho real em bloco de código resolve; o que não existe nele é "em exemplo", não quebrado', () => {
    assert.deepStrictEqual(locate({ cited: 'docs/guia.md', example: true }), { found: 'docs/guia.md' })
    assert.deepStrictEqual(locate({ cited: 'x/so-exemplo.md', example: true }), { skip: 'example' })
  })

  it('acha subindo as pastas do arquivo que cita e, por último, pelo nome único na árvore', () => {
    assert.deepStrictEqual(locate('soul.md'), { found: '.agents/agents/maya/soul.md' })
    assert.deepStrictEqual(locate('anatomia.md'), { found: '.agents/specs/core/anatomia.md', byName: true })
    assert.deepStrictEqual(locate('core/anatomia.md'), { found: '.agents/specs/core/anatomia.md', byName: true })
    assert.deepStrictEqual(locate('ore/anatomia.md'), { broken: true }, 'o sufixo casa por pasta inteira')
  })

  it('nome em mais de um lugar é ambíguo; citação real que não existe continua quebrada', () => {
    assert.deepStrictEqual(locate('README.md'), { skip: 'ambiguous' })
    assert.deepStrictEqual(locate('a/README.md'), { found: 'a/README.md' })
    assert.deepStrictEqual(locate('.agents/specs/inexistente.md'), { broken: true })
    assert.deepStrictEqual(locate('inexistente.md'), { broken: true })
  })
})
