import assert from 'node:assert'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

/**
 * A regra de dependência, executável.
 *
 * Sem isto a camada é só convenção de pastas — e convenção não segura nada: a seta já foi
 * invertida uma vez e ninguém percebeu por duas fases. Um teste custa menos que um plugin de
 * lint (nenhuma dependência nova) e quebra o build do mesmo jeito.
 *
 * Arquivos de teste ficam de fora: montar dublê e fiação é o trabalho deles, e eles não vão
 * para produção. A regra governa o código que roda.
 */

const SRC = __dirname

interface ILayerRule {
  layer: string
  forbidden: string[]
  because: string
}

const LAYER_RULES: ILayerRule[] = [
  {
    layer: 'domain',
    forbidden: ['@infra', '@application', '@composition'],
    because: 'o domínio é o centro do hexágono: nada de fora pode aparecer na assinatura dele',
  },
  {
    layer: 'application',
    forbidden: ['@infra', '@composition'],
    because: 'a aplicação orquestra o domínio; quem conhece detalhe de entrega é o adapter',
  },
  {
    layer: 'infra',
    forbidden: ['@composition'],
    because: 'o composition root é a camada mais externa: ele conhece todos, ninguém conhece ele',
  },
]

/** Pacotes que só podem aparecer no adapter de entrega. */
const DELIVERY_ONLY = [{ specifier: 'express', allowedUnder: path.join('infra', 'http') }]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) return []
    return [full]
  })
}

/** Comentário citando um módulo não é dependência. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

function importsOf(file: string): string[] {
  const code = stripComments(readFileSync(file, 'utf8'))
  const found: string[] = []

  for (const match of code.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    found.push(match[1])
  }

  return found
}

const FILES = sourceFiles(SRC).map((file) => ({
  relative: path.relative(SRC, file),
  imports: importsOf(file),
}))

describe('regra de dependência', () => {
  it('encontra os arquivos de produção para inspecionar', () => {
    assert.ok(FILES.length > 20, `esperava a árvore inteira, achei ${FILES.length} arquivos`)
  })

  for (const rule of LAYER_RULES) {
    it(`${rule.layer} não importa ${rule.forbidden.join(', ')}`, () => {
      const offenders = FILES.filter((file) => file.relative.startsWith(`${rule.layer}${path.sep}`)).flatMap((file) =>
        file.imports.filter((specifier) => rule.forbidden.some((alias) => specifier.startsWith(alias))).map((specifier) => `${file.relative} → ${specifier}`),
      )

      assert.deepStrictEqual(offenders, [], `${rule.because}\n  ${offenders.join('\n  ')}`)
    })
  }

  for (const rule of DELIVERY_ONLY) {
    it(`${rule.specifier} só aparece em ${rule.allowedUnder}`, () => {
      const offenders = FILES.filter((file) => file.imports.includes(rule.specifier) && !file.relative.startsWith(rule.allowedUnder + path.sep)).map((file) => file.relative)

      assert.deepStrictEqual(offenders, [], `só o adapter de entrega fala ${rule.specifier}`)
    })
  }
})
