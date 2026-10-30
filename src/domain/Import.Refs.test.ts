import assert from 'node:assert'
import { describe, it } from 'node:test'
import { candidateId, extractCitations, frontmatter, generatedSources, resolveCitation } from './Import.Refs'

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
