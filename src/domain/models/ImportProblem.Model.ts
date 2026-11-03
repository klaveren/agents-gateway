import { IPermissionRule, PERMISSION_CATEGORIES, TPermissionCategory } from '../Permission.Policy'

/**
 * Um PROBLEMA DA IMPORTAÇÃO que fica DENTRO do artefato importado (doc, skill, command, agente): o que dá para
 * consertar depois não impede a gravação — o item entra sem o vínculo quebrado, o problema fica registrado nele e as
 * telas o mostram. Depois, um agente importado (ou a pessoa) resolve e marca como resolvido.
 *
 * ⚖️ É conteúdo do item (entra no documento canônico: histórico, diff, export). Só o importador cria; a edição normal
 * mantém a lista, e "resolvido" tira um.
 *
 * ⛔ O que o próprio agente não pode errar (título acima do limite, fonte mudada, segredo, conflito de id, agente sem
 * modelo) continua BLOQUEANDO — não vira problema.
 */
export interface IImportProblem {
  code: TImportProblemCode
  /** Em português, para a pessoa e para o agente que vai resolver. */
  message: string
  /** O id do que o vínculo citava (o doc, a skill, o command). */
  target?: string
  /** O vínculo que ficou de fora, para voltar sozinho (`link-pending`, `skill-missing`, `command-missing`). */
  link?: TImportProblemLink
  /** `delegate-missing`/`mcp-missing` (`link: 'reach'`): as regras do agente que ficaram de fora, exatas, para voltar. */
  rules?: IPermissionRule[]
  /** E as entradas de `allowedTools` (`agent:<id>`, `mcp:<servidor>/…`) que ficaram de fora. */
  tools?: string[]
}

export type TImportProblemCode =
  /** Cita algo que não é documento (um agente, um command, uma skill, um arquivo de memória). */
  | 'link-not-document'
  /** O contexto inicial só leva spec: o citado é ADR ou estudo. */
  | 'link-not-spec'
  /** Não existe no catálogo nem na importação. */
  | 'link-missing'
  /** É de outro projeto. */
  | 'link-scope'
  /** É documento da importação que ainda não está no catálogo: volta quando ele for gravado. */
  | 'link-pending'
  /** O agente libera uma skill que ainda não está no catálogo: entra quando ela for gravada. */
  | 'skill-missing'
  | 'command-missing'
  /** Regra do agente que libera delegar a um agente que não existe (nem entra nesta gravação): fica guardada no problema. */
  | 'delegate-missing'
  /** Regra (ou ferramenta) do agente que cita um servidor MCP que ele não enxerga: fica guardada no problema. */
  | 'mcp-missing'

export const IMPORT_PROBLEM_CODES: readonly TImportProblemCode[] = [
  'link-not-document',
  'link-not-spec',
  'link-missing',
  'link-scope',
  'link-pending',
  'skill-missing',
  'command-missing',
  'delegate-missing',
  'mcp-missing',
]

/**
 * `attach`/`reference`: `docIds` (e `docRefs`); `initialContext`: o do agente; `skill`/`command`: `resources`;
 * `reach`: o alcance do agente (`permissions` e `allowedTools`, o que veio em `rules` e `tools`).
 */
export type TImportProblemLink = 'attach' | 'reference' | 'initialContext' | 'skill' | 'command' | 'reach'

const LINKS: readonly TImportProblemLink[] = ['attach', 'reference', 'initialContext', 'skill', 'command', 'reach']

/**
 * Os PENDENTES: voltam sozinhos quando o alvo é gravado por uma importação seguinte. "Descartar" um tira o problema e
 * esquece o que ficou guardado (nada volta depois).
 */
export const RESTORABLE_CODES: readonly TImportProblemCode[] = ['link-pending', 'skill-missing', 'command-missing', 'delegate-missing', 'mcp-missing']

/** Qual resolver: o código e, quando dado, o alvo; ou todos os pendentes de uma vez (`pending`). */
export type IImportProblemMatch = { code: string; target?: string } | { pending: true }

export const matchesProblem = (problem: IImportProblem, match: IImportProblemMatch): boolean =>
  'pending' in match ? RESTORABLE_CODES.includes(problem.code) : problem.code === match.code && (match.target === undefined || problem.target === match.target)

/** Para a mensagem do 404: o que se pediu para resolver. */
export const describeMatch = (match: IImportProblemMatch): string => ('pending' in match ? 'pending issues' : `${match.code}${match.target ? ` ${match.target}` : ''}`)

/** A lista sem os que casam; `undefined` = nenhum casou (não há o que resolver). */
export function withoutProblem(issues: readonly IImportProblem[] | undefined, match: IImportProblemMatch): IImportProblem[] | undefined {
  const all = issues ?? []
  const rest = all.filter((issue) => !matchesProblem(issue, match))
  return rest.length === all.length ? undefined : rest
}

/** A lista gravada (JSON) de volta: o que não tem a forma fica de fora. */
export function problemList(value: unknown): IImportProblem[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && typeof item.code === 'string' && typeof item.message === 'string')
    .map((item) => ({
      code: item.code as TImportProblemCode,
      message: item.message as string,
      ...(typeof item.target === 'string' ? { target: item.target } : {}),
      ...(typeof item.link === 'string' && LINKS.includes(item.link as TImportProblemLink) ? { link: item.link as TImportProblemLink } : {}),
      ...nonEmpty('rules', Array.isArray(item.rules) ? item.rules.filter(isRule).map(cleanRule) : []),
      ...nonEmpty('tools', Array.isArray(item.tools) ? item.tools.filter((tool): tool is string => typeof tool === 'string') : []),
    }))
}

const nonEmpty = <K extends string, V>(key: K, list: V[]) => (list.length ? ({ [key]: list } as Record<K, V[]>) : {})

function isRule(value: unknown): value is IPermissionRule {
  const rule = value as Partial<IPermissionRule> | null
  return (
    !!rule &&
    typeof rule === 'object' &&
    PERMISSION_CATEGORIES.includes(rule.category as TPermissionCategory) &&
    (rule.decision === 'allow' || rule.decision === 'deny') &&
    typeof rule.pattern === 'string'
  )
}

const cleanRule = (rule: IPermissionRule): IPermissionRule => ({
  category: rule.category,
  pattern: rule.pattern,
  decision: rule.decision,
  ...(typeof rule.note === 'string' ? { note: rule.note } : {}),
})
