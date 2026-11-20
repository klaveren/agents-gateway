import { isAbsolute, join, relative } from 'node:path'
import { IPermissionLayers, IPermissionRule, matches, opened, SYSTEM_RULES } from './Permission.Policy'

/**
 * O REPOSITÓRIO IRMÃO: numa conversa aberta no repositório A (ou numa worktree dele), o B do mesmo projeto
 * (`<projeto>/repositories/B`) só se LÊ, e só quando uma regra de leitura LIBERA o B pelo nome literal.
 *
 * ⚖️ Só LEITURA. Regra de escrita num irmão não tem efeito, e as ferramentas e o cerco seguem recusando gravar nele.
 * ⛔ O nome do repositório é literal: `repositories/*\/**` não abre irmão nenhum (liberar todos é decisão por nome).
 * Função pura, sem disco: quem chama confere que o irmão é um repositório de verdade (ver `siblingReader`).
 */

const GLOB_CHARS = /[*?[\]{}]/
const REPOSITORIES = 'repositories'

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * A pasta do irmão que o caminho (ou o padrão) nomeia: `<projeto>/repositories/<nome>`. O caminho é relativo ao projeto
 * (`repositories/B/**`) ou absoluto dentro dele. Nada se o nome tem curinga, é `_worktrees`, o caminho tem `..`, não
 * passa do nome, ou a pasta contém a raiz da conversa (o repositório dela) ou está dentro dela.
 */
export function siblingDir(path: string, projectRoot: string, root: string): string | undefined {
  const clean = path.trim().replace(/^\.\//, '')
  const prefix = `${projectRoot.replace(/\/+$/, '')}/${REPOSITORIES}/`
  const tail = isAbsolute(clean)
    ? clean.startsWith(prefix)
      ? clean.slice(prefix.length)
      : undefined
    : clean.startsWith(`${REPOSITORIES}/`)
      ? clean.slice(REPOSITORIES.length + 1)
      : undefined
  if (!tail) return undefined
  const parts = tail.split('/')
  const name = parts[0]!
  if (parts.length < 2 || !parts[1] || parts.includes('..') || parts.includes('.')) return undefined
  if (!name || GLOB_CHARS.test(name) || name === '_worktrees' || name.includes('\0')) return undefined
  const dir = join(projectRoot, REPOSITORIES, name)
  return inside(dir, root) || inside(root, dir) ? undefined : dir
}

/** O padrão que nomeia um irmão, em forma ABSOLUTA; nada se não nomeia. */
export function siblingPattern(pattern: string, projectRoot: string, root: string): string | undefined {
  if (!siblingDir(pattern, projectRoot, root)) return undefined
  const clean = pattern.trim().replace(/^\.\//, '')
  return isAbsolute(clean) ? clean : join(projectRoot, clean)
}

export interface ISiblingContext {
  /** A pasta do projeto, real. */
  projectRoot: string
  /** A pasta da conversa (repositório ou worktree), real. */
  root: string
  layers: IPermissionLayers
  /** As regras de sistema da instalação, somadas às fixas. */
  system?: readonly IPermissionRule[]
}

/**
 * O arquivo `abs` (caminho REAL, absoluto) de um irmão pode ser lido? Sim se alguma regra de LEITURA do agente ou do projeto
 * libera o irmão pelo nome e NENHUMA negação (sistema, agente, projeto) o pega: negar vence, em qualquer camada.
 */
export function siblingReadAllowed(abs: string, context: ISiblingContext): boolean {
  const { projectRoot, root, layers } = context
  if (layers.machine || !siblingDir(abs, projectRoot, root)) return false
  const subject = { category: 'read' as const, value: abs, aliases: [relative(projectRoot, abs)] }
  const rules = [...(layers.agent ?? []), ...(layers.project ?? [])].filter((rule) => rule.category === 'read')
  const denies = [...SYSTEM_RULES, ...(context.system ?? []), ...rules].filter((rule) => rule.category === 'read' && rule.decision === 'deny')
  if (denies.some((rule) => !opened(rule, layers) && matches(rule, subject))) return false
  return rules.some((rule) => {
    const pattern = rule.decision === 'allow' ? siblingPattern(rule.pattern, projectRoot, root) : undefined
    return !!pattern && matches({ ...rule, pattern }, subject)
  })
}
