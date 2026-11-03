import { ignoreIssues, ignoreMatcher, normalizeIgnore } from './Import.Ignore'

/**
 * O AMBIENTE AGÊNTICO de um repositório: o que o importador olha. ⚖️ Lista do que ENTRA, não "tudo menos o ignorado": o
 * código do projeto (`src/`, `packages/`…) nunca entra no inventário; o citado de lá vira só referência.
 *
 * Por dedução, os lugares conhecidos de cada ferramenta (`AGENTIC_SCOPE_DEFAULTS`), relativos à raiz:
 * - `/` no fim = a pasta inteira (`.claude/`);
 * - sem `/` no fim = o arquivo, ou a pasta com esse nome (`.clinerules` é um ou outro);
 * - `**\/NOME` = só o arquivo de entrada nas SUBPASTAS (`packages/api/AGENTS.md`), nunca a subpasta inteira.
 *
 * O admin desliga lugares e soma caminhos (`extra`, com a semântica do ignorar) por projeto. O ignorar vale DENTRO.
 */

/** Uma ferramenta e os lugares em que ela guarda o ambiente. */
export interface IAgenticTool {
  id: string
  label: string
  places: readonly string[]
}

export const AGENTIC_SCOPE_DEFAULTS: readonly IAgenticTool[] = [
  { id: 'agents', label: '.agents (canônico legado)', places: ['.agents/'] },
  { id: 'claude', label: 'Claude Code', places: ['.claude/', 'CLAUDE.md', '.mcp.json'] },
  { id: 'opencode', label: 'opencode', places: ['.opencode/', 'opencode.json', 'opencode.jsonc', 'AGENTS.md'] },
  { id: 'codex', label: 'Codex', places: ['.codex/', 'AGENTS.md'] },
  { id: 'cursor', label: 'Cursor', places: ['.cursor/', '.cursorrules'] },
  { id: 'copilot', label: 'GitHub Copilot', places: ['.github/copilot-instructions.md', '.github/chatmodes/', '.github/prompts/', '.github/instructions/'] },
  { id: 'gemini', label: 'Gemini', places: ['.gemini/', 'GEMINI.md'] },
  { id: 'windsurf', label: 'Windsurf', places: ['.windsurf/', '.windsurfrules'] },
  { id: 'cline', label: 'Cline', places: ['.clinerules'] },
  { id: 'roo', label: 'Roo', places: ['.roo/'] },
  { id: 'continue', label: 'Continue', places: ['.continue/'] },
  { id: 'subfolders', label: 'Entradas em subpastas', places: ['**/AGENTS.md', '**/CLAUDE.md', '**/GEMINI.md'] },
]

/** Os lugares padrão, sem repetir (o `AGENTS.md` é do opencode e do Codex: um lugar só, um interruptor só). */
export const AGENTIC_PLACES: readonly string[] = [...new Set(AGENTIC_SCOPE_DEFAULTS.flatMap((tool) => tool.places))]

/** O ambiente guardado no projeto: os lugares padrão DESLIGADOS (o resto vale, inclusive o que entrar depois) e os a mais. */
export interface IAgenticScope {
  disabled: string[]
  extra: string[]
}

/** A forma guardada: só lugares conhecidos, na ordem dos padrões; os a mais como o ignorar (`normalizeIgnore`). */
export function normalizeScope(scope: { disabled?: readonly string[]; extra?: readonly string[] } = {}): IAgenticScope {
  const off = new Set(scope.disabled ?? [])
  return { disabled: AGENTIC_PLACES.filter((place) => off.has(place)), extra: normalizeIgnore(scope.extra ?? []) }
}

/** O que está errado no ambiente pedido (o salvamento recusa com isto). */
export function scopeIssues(scope: { disabled?: unknown; extra?: unknown }): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  if (!Array.isArray(scope.disabled)) issues.push({ field: 'disabled', message: 'must be a list of default places' })
  else
    scope.disabled.forEach((place, index) => {
      if (typeof place !== 'string' || !AGENTIC_PLACES.includes(place)) issues.push({ field: `disabled.${index}`, message: 'not a default place' })
    })
  issues.push(...ignoreIssues(scope.extra, 'extra'))
  return issues
}

/** Um lugar padrão compilado: casa o caminho (de arquivo, relativo à raiz). Sem diferença de caixa. */
export function placeMatcher(place: string): (path: string) => boolean {
  const lower = place.toLowerCase()
  if (lower.startsWith('**/')) {
    const name = lower.slice(3)
    return (path) => path.includes('/') && path.slice(path.lastIndexOf('/') + 1).toLowerCase() === name
  }
  if (lower.endsWith('/')) return (path) => path.toLowerCase().startsWith(lower)
  return (path) => {
    const candidate = path.toLowerCase()
    return candidate === lower || candidate.startsWith(`${lower}/`)
  }
}

/** O ambiente com que uma análise rodou (`IInventoryScope` do trabalho), de volta à forma guardada. */
export function analysedScope(scope: { places: ReadonlyArray<{ place: string; enabled: boolean }>; extra: ReadonlyArray<{ pattern: string }> }): IAgenticScope {
  return normalizeScope({ disabled: scope.places.filter((place) => !place.enabled).map((place) => place.place), extra: scope.extra.map((one) => one.pattern) })
}

/** ⛔ O predicado do ambiente: o caminho está num lugar ligado ou num caminho a mais. */
export function scopeMatcher(scope: IAgenticScope): (path: string) => boolean {
  const off = new Set(scope.disabled)
  const matchers = [
    ...AGENTIC_PLACES.filter((place) => !off.has(place)).map(placeMatcher),
    ...normalizeIgnore(scope.extra).map((pattern) => {
      const matcher = ignoreMatcher(pattern)
      return (path: string) => matcher.matches(path)
    }),
  ]
  return (path) => {
    const clean = path.replace(/^\.\//, '')
    return matchers.some((matches) => matches(clean))
  }
}
