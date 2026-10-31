import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { TCanonicalBody } from './Catalog.Document'
import { frontmatterCodec, FrontmatterError, IFrontmatter, isPlainText, parseFrontmatter, stringifyFrontmatter } from './Frontmatter.Codec'

const roundTrip = (frontmatter: IFrontmatter) => {
  const text = stringifyFrontmatter(frontmatter)
  const back = parseFrontmatter(text)
  assert.deepStrictEqual(back, frontmatter)
  // Estável: a volta dá o MESMO texto.
  assert.strictEqual(stringifyFrontmatter(back), text)
  return text
}

describe('Frontmatter.Codec — ida e volta exata', () => {
  it('texto simples sai sem aspas, chaves em ordem, LF', () => {
    const text = roundTrip({ data: { title: 'Revisão de código', id: 'review', position: 2, enabled: true }, body: '# Corpo\n' })
    assert.strictEqual(text, '---\nenabled: true\nid: review\nposition: 2\ntitle: Revisão de código\n---\n# Corpo\n')
  })

  it('aspas, dois-pontos, cerquilha e espaço nas pontas saem como string JSON', () => {
    const data: TCanonicalBody = {
      a: 'diz "olá"',
      b: 'chave: valor',
      c: 'texto # comentário?',
      d: ' com espaço ',
      e: "it's",
      f: '\\barra\\',
      g: '',
    }
    const text = roundTrip({ data, body: '' })
    assert.ok(text.includes('a: "diz \\"olá\\""\n'))
    assert.ok(text.includes('b: "chave: valor"\n'))
    assert.ok(text.includes('d: " com espaço "\n'))
    assert.ok(text.includes("e: it's\n"))
    assert.ok(text.includes('g: ""\n'))
  })

  it('o que o YAML leria como outra coisa vai com aspas: booleano, nulo, número, data, indicador', () => {
    const tricky = ['true', 'yes', 'No', 'null', '~', '12', '1.5', '0x10', '2026-10-30', '-item', '[x]', '{x}', '*ref', '&anchor', '!tag', '|', '>', '@a', '`a`', '%a']
    const data = Object.fromEntries(tricky.map((value, index) => [`k${index}`, value]))
    const text = roundTrip({ data, body: 'x' })
    for (const value of tricky) assert.ok(text.includes(`: ${JSON.stringify(value)}\n`), value)
    for (const value of tricky) assert.strictEqual(isPlainText(value), false, value)
  })

  it('multilinha: string JSON com \\n (bloco `|` está fora do subconjunto)', () => {
    const text = roundTrip({ data: { summary: 'linha 1\nlinha 2\n\tcom tab' }, body: 'corpo' })
    assert.ok(text.includes('summary: "linha 1\\nlinha 2\\n\\tcom tab"\n'))
  })

  it('listas, objetos, números e booleanos: literal JSON numa linha, chaves do objeto em ordem', () => {
    const data: TCanonicalBody = { docs: ['spec-a', 'adr-b'], vazio: [], obj: { z: 1, a: [true, 'x'] }, n: -3.25, big: 1e21, flag: false }
    const text = roundTrip({ data, body: 'b' })
    assert.ok(text.includes('docs: ["spec-a","adr-b"]\n'))
    assert.ok(text.includes('vazio: []\n'))
    assert.ok(text.includes('obj: {"a":[true,"x"],"z":1}\n'))
  })

  it('unicode: acento, CJK, emoji, RTL e surrogate solto voltam iguais', () => {
    const data: TCanonicalBody = { pt: 'Ação çedilha', cjk: '日本語のテキスト', emoji: 'deploy 🚀', rtl: 'مرحبا', lone: 'x\ud800y', nbsp: 'a b' }
    const text = roundTrip({ data, body: 'Corpo com ✓ e 日本\n' })
    assert.ok(text.includes('pt: Ação çedilha\n'))
    assert.ok(text.includes('cjk: 日本語のテキスト\n'))
    assert.ok(text.includes('emoji: "deploy 🚀"\n'))
  })

  it('`---` no corpo é só texto: o bloco termina no primeiro `---`', () => {
    const body = '---\nisto não é frontmatter: nao\n---\n\nTexto\n---\n'
    roundTrip({ data: { id: 'x' }, body })
    roundTrip({ data: {}, body })
    assert.strictEqual(parseFrontmatter('---\n---\n---\n').body, '---\n')
  })

  it('corpo vazio, sem quebra no fim, com CRLF dentro: byte a byte', () => {
    roundTrip({ data: { id: 'a' }, body: '' })
    roundTrip({ data: { id: 'a' }, body: 'sem quebra' })
    roundTrip({ data: { id: 'a' }, body: 'linha\r\noutra\r\n' })
  })

  it('sem bloco no começo: tudo é corpo, sem metadado', () => {
    assert.deepStrictEqual(parseFrontmatter('# Só markdown\n'), { data: {}, body: '# Só markdown\n' })
    assert.deepStrictEqual(parseFrontmatter(''), { data: {}, body: '' })
  })

  it('o codec exposto é o par parse/stringify', () => {
    const frontmatter = { data: { a: 'b' }, body: 'c' }
    assert.deepStrictEqual(frontmatterCodec.parse(frontmatterCodec.stringify(frontmatter)), frontmatter)
  })
})

describe('Frontmatter.Codec — ⛔ fora do subconjunto lança, sem adivinhar', () => {
  const bad = (text: string, pattern: RegExp) =>
    assert.throws(
      () => parseFrontmatter(text),
      (error: unknown) => error instanceof FrontmatterError && pattern.test(error.message),
    )

  it('YAML de bloco, lista de bloco, comentário, âncora, alias e tag', () => {
    bad('---\ndesc: |\n  linha\n---\n', /subconjunto|vazio/)
    bad('---\ndocs:\n  - a\n---\n', /vazio/)
    bad('---\n# comentário\n---\n', /linha fora do subconjunto/)
    bad('---\na: &x valor\n---\n', /fora do subconjunto/)
    bad('---\na: *x\n---\n', /fora do subconjunto/)
    bad('---\na: !!str 1\n---\n', /fora do subconjunto/)
    bad("---\na: 'aspas simples'\n---\n", /fora do subconjunto/)
  })

  it('valor vazio (nulo em YAML), null, JSON quebrado, chave repetida, linha vazia', () => {
    bad('---\na:\n---\n', /vazio/)
    bad('---\na: null\n---\n', /fora do subconjunto/)
    bad('---\na: [1, null]\n---\n', /null/)
    bad('---\na: ["x"\n---\n', /JSON inválido/)
    bad('---\na: b\na: c\n---\n', /repetida/)
    bad('---\na: b\n\n---\n', /linha fora/)
    bad('---\na: b: c\n---\n', /fora do subconjunto/)
    bad('---\na: valor # comentário\n---\n', /fora do subconjunto/)
  })

  it('sem fechamento e CRLF no bloco', () => {
    bad('---\na: b\n', /fechamento/)
    bad('---\r\na: b\r\n---\r\n', /CRLF/)
    bad('---\na: b\r\n---\n', /CRLF/)
  })

  it('a linha do erro vem na mensagem', () => {
    assert.throws(
      () => parseFrontmatter('---\na: b\nc: d: e\n---\n'),
      (error: unknown) => error instanceof FrontmatterError && error.line === 3,
    )
  })

  it('stringify recusa chave fora do subconjunto e número não finito', () => {
    assert.throws(() => stringifyFrontmatter({ data: { 'com espaço': 'x' }, body: '' }), FrontmatterError)
    assert.throws(() => stringifyFrontmatter({ data: { n: Number.NaN }, body: '' }), FrontmatterError)
  })
})
