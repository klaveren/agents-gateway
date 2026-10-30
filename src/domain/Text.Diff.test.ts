import assert from 'node:assert'
import { describe, it } from 'node:test'
import { diffText, EDIT_LIMIT, IDiffLine, ITextDiff } from './Text.Diff'

const lines = (...items: string[]) => items.map((item) => `${item}\n`).join('')

/** Refaz os dois lados a partir do roteiro inteiro (contexto enorme = um trecho só com tudo). */
function rebuild(diff: ITextDiff): { before: string[]; after: string[] } {
  const all: IDiffLine[] = diff.hunks.flatMap((hunk) => hunk.lines)
  return { before: all.filter((line) => line.op !== 'add').map((line) => line.text), after: all.filter((line) => line.op !== 'remove').map((line) => line.text) }
}

/** O tamanho da maior subsequência comum, por programação dinâmica: o Myers tem de chegar ao mesmo número de edições. */
function lcs(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1])
      diagonal = up
    }
  }
  return row[b.length]
}

describe('diff de linhas (Text.Diff)', () => {
  it('textos iguais: sem trecho, texto unificado vazio', () => {
    const diff = diffText(lines('a', 'b'), lines('a', 'b'))
    assert.deepStrictEqual([diff.equal, diff.added, diff.removed, diff.hunks, diff.unified], [true, 0, 0, [], ''])
    assert.strictEqual(diffText('', '').equal, true)
  })

  it('inserção no meio: um trecho com o contexto em volta e os números das linhas', () => {
    const diff = diffText(lines('a', 'b', 'c'), lines('a', 'b', 'x', 'c'), { fromLabel: 'agent/theo@1', toLabel: 'agent/theo@2' })
    assert.deepStrictEqual([diff.added, diff.removed], [1, 0])
    assert.strictEqual(diff.unified, ['--- agent/theo@1', '+++ agent/theo@2', '@@ -1,3 +1,4 @@', ' a', ' b', '+x', ' c', ''].join('\n'))
    assert.deepStrictEqual(diff.hunks[0].lines[2], { op: 'add', text: 'x', newLine: 3 })
    assert.deepStrictEqual(diff.hunks[0].lines[3], { op: 'equal', text: 'c', oldLine: 3, newLine: 4 })
  })

  it('remoção: a linha sai com o número dela no texto de antes', () => {
    const diff = diffText(lines('a', 'b', 'c'), lines('a', 'c'))
    assert.deepStrictEqual([diff.added, diff.removed], [0, 1])
    assert.deepStrictEqual(diff.hunks[0].lines[1], { op: 'remove', text: 'b', oldLine: 2 })
    assert.strictEqual(diff.unified.split('\n')[2], '@@ -1,3 +1,2 @@')
  })

  it('troca: sai a velha, entra a nova', () => {
    const diff = diffText(lines('{', '  "name": "Theo"', '}'), lines('{', '  "name": "Theodoro"', '}'))
    assert.deepStrictEqual(
      diff.hunks[0].lines.map((line) => `${line.op}:${line.text}`),
      ['equal:{', 'remove:  "name": "Theo"', 'add:  "name": "Theodoro"', 'equal:}'],
    )
  })

  it('vazio → conteúdo e conteúdo → vazio: o lado vazio começa em 0 (como o diff -u)', () => {
    const created = diffText('', lines('a', 'b'))
    assert.strictEqual(created.unified, ['--- a', '+++ b', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n'))
    const deleted = diffText(lines('a'), '')
    assert.strictEqual(deleted.unified, ['--- a', '+++ b', '@@ -1 +0,0 @@', '-a', ''].join('\n'))
  })

  it('linhas repetidas: o menor número de edições, sem trocar linha igual de lugar', () => {
    const before = lines('x', 'a', 'x', 'a', 'x')
    const after = lines('a', 'x', 'a', 'x', 'a')
    const diff = diffText(before, after, { context: 100 })
    assert.strictEqual(diff.added + diff.removed, 2)
    assert.deepStrictEqual(rebuild(diff), { before: ['x', 'a', 'x', 'a', 'x'], after: ['a', 'x', 'a', 'x', 'a'] })
  })

  it('mudanças longe uma da outra viram dois trechos; perto, um só', () => {
    const base = Array.from({ length: 20 }, (_, index) => `l${index + 1}`)
    const far = [...base]
    far[1] = 'X'
    far[17] = 'Y'
    assert.deepStrictEqual(
      diffText(lines(...base), lines(...far)).hunks.map((hunk) => [hunk.oldStart, hunk.oldLines]),
      [
        [1, 5],
        [15, 6],
      ],
    )
    const near = [...base]
    near[1] = 'X'
    near[7] = 'Y'
    assert.strictEqual(diffText(lines(...base), lines(...near)).hunks.length, 1)
    assert.strictEqual(diffText(lines(...base), lines(...far), { context: 0 }).unified.split('\n')[2], '@@ -2 +2 @@')
  })

  it('a falta de quebra no fim é diferença e sai marcada', () => {
    const diff = diffText('a\nb\n', 'a\nb')
    assert.deepStrictEqual([diff.added, diff.removed], [1, 1])
    assert.ok(diff.unified.endsWith('-b\n+b\n\\ No newline at end of file\n'))
  })

  it('aleatório: refaz os dois lados e acha o mesmo número de edições da maior subsequência comum', () => {
    let seed = 7
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648
    for (let round = 0; round < 200; round++) {
      const make = () => Array.from({ length: Math.floor(random() * 12) }, () => 'abc'[Math.floor(random() * 3)])
      const a = make()
      const b = make()
      const diff = diffText(lines(...a), lines(...b), { context: 1_000 })
      // Sem mudança não há trecho: os dois lados são iguais.
      assert.deepStrictEqual(diff.equal ? { before: a, after: a } : rebuild(diff), { before: a, after: b })
      assert.strictEqual(diff.added + diff.removed, a.length + b.length - 2 * lcs(a, b))
    }
  })

  it('além do teto de esforço: o miolo sai inteiro, e o resultado continua certo', () => {
    const a = Array.from({ length: EDIT_LIMIT + 10 }, (_, index) => `a${index}`)
    const b = Array.from({ length: EDIT_LIMIT + 10 }, (_, index) => `b${index}`)
    const diff = diffText(lines('topo', ...a, 'fim'), lines('topo', ...b, 'fim'), { context: 1 })
    assert.deepStrictEqual([diff.removed, diff.added, diff.hunks.length], [a.length, b.length, 1])
    assert.deepStrictEqual(rebuild(diff), { before: ['topo', ...a, 'fim'], after: ['topo', ...b, 'fim'] })
  })
})
