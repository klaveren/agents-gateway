import { globToRegex } from './Permission.Policy'

/**
 * O IGNORAR da varredura do importador: globs que o admin define por projeto (e que a chamada pode somar), para tirar do
 * inventário o que é do projeto e não é recurso (`.agents/benchmark/results/**`, saídas de ferramenta…).
 *
 * ⚖️ A semântica é a do `.gitignore`, no que importa aqui:
 * - padrão sem `/` casa o NOME em qualquer pasta (`results` tira toda pasta `results`; `*.log`, todo `.log`);
 * - padrão com `/` é a partir da raiz do repositório (`.agents/benchmark/results`, `docs/**\/rascunho-*.md`);
 * - casar uma pasta tira tudo abaixo dela; `/` no fim é aceito e só diz "pasta".
 *
 * Nada aqui vem embutido: o que é artefato de UM projeto fica com o admin dele.
 */

export const IMPORT_IGNORE_MAX = 100
export const IMPORT_IGNORE_PATTERN_MAX = 200

/** A forma guardada: sem espaço nas pontas, `/` no lugar de `\`, sem `./` no começo nem `/` no fim, sem repetir. */
export function normalizeIgnore(patterns: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of patterns) {
    const clean = raw
      .trim()
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/\/+$/, '')
    if (clean && !out.includes(clean)) out.push(clean)
  }
  return out
}

/** O que está errado numa lista de padrões (o salvamento e a varredura recusam com isto). */
export function ignoreIssues(patterns: unknown, field = 'patterns'): Array<{ field: string; message: string }> {
  if (!Array.isArray(patterns)) return [{ field, message: 'must be a list of glob patterns' }]
  const issues: Array<{ field: string; message: string }> = []
  if (patterns.length > IMPORT_IGNORE_MAX) issues.push({ field, message: `at most ${IMPORT_IGNORE_MAX} patterns` })
  patterns.forEach((pattern, index) => {
    const at = `${field}.${index}`
    if (typeof pattern !== 'string') return issues.push({ field: at, message: 'must be a string' })
    const clean = normalizeIgnore([pattern])[0] ?? ''
    if (!clean) return issues.push({ field: at, message: 'empty pattern' })
    if (clean.length > IMPORT_IGNORE_PATTERN_MAX) return issues.push({ field: at, message: `at most ${IMPORT_IGNORE_PATTERN_MAX} characters` })
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(clean)) return issues.push({ field: at, message: 'control characters are not allowed' })
    if (clean.startsWith('/') || clean.startsWith('~') || /^[A-Za-z]:\//.test(clean)) return issues.push({ field: at, message: 'must be relative to the repository root' })
    if (clean.split('/').includes('..')) return issues.push({ field: at, message: '".." is not allowed' })
    return undefined
  })
  return issues
}

/** Um padrão compilado: casa o caminho (de arquivo) se casa ele ou uma das pastas acima dele. */
export interface IIgnoreMatcher {
  pattern: string
  matches(path: string): boolean
}

export function ignoreMatcher(pattern: string): IIgnoreMatcher {
  const anchored = pattern.includes('/')
  const regex = globToRegex(pattern)
  const test = (path: string) => (anchored ? regex.test(path) : regex.test(path.slice(path.lastIndexOf('/') + 1)))
  return {
    pattern,
    matches(path: string) {
      const clean = path.replace(/^\.\//, '')
      if (test(clean)) return true
      // As pastas acima: `a/b/c.md` → `a/b`, `a`.
      for (let at = clean.lastIndexOf('/'); at > 0; at = clean.lastIndexOf('/', at - 1)) if (test(clean.slice(0, at))) return true
      return false
    },
  }
}
