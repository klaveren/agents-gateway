import { isAbsolute, join, relative } from 'node:path'
import { IPermissionLayers, IPermissionRule, SYSTEM_RULES } from './Permission.Policy'

/**
 * O CERCO MONTADO DAS REGRAS: as listas de leitura e escrita que o sistema operacional aplica ao comando do terminal
 * (`@anthropic-ai/sandbox-runtime`). É a segunda trava, a que vale mesmo para o que a análise do comando não vê:
 * `node -e "fs.readFileSync('.env')"` passa pela regra de comando (`node *`) e cai no cerco.
 *
 * ⚖️ O cerco NUNCA libera mais que as regras; em conflito entre camadas pode ser MAIS restrito. O sistema operacional
 * resolve negar-vence-permitir em qualquer camada, então uma negação do projeto que o agente reabriu só sai da lista
 * quando a liberação do agente está DENTRO dela (`infra/**` negado, `infra/k8s/**` liberado). Falha fechada.
 *
 * Semântica do runtime (provada na prática): `allowRead` reabre dentro de um `denyRead`, salvo quando o `denyRead` é
 * mais específico; `denyWrite` vence `allowWrite`.
 */
export interface ICercoPlan {
  readAllow: string[]
  readDeny: string[]
  writeAllow: string[]
  writeDeny: string[]
}

export interface ICercoBase {
  /** A pasta de trabalho do comando (a do projeto, ou a da conversa no agente global). */
  root: string
  /** Pastas que o comando sempre lê e escreve: HOME, TMPDIR e caches (na pasta do projeto, fora de uma worktree). */
  scratch: readonly string[]
  /** O que se lê sempre (o auxiliar do runtime, as ferramentas instaladas pela guia Pacotes). */
  alwaysRead: readonly string[]
  /**
   * O que nunca se lê nem escreve, além das regras: a casa de quem roda o gateway, a pasta do app, os dados. Na escrita,
   * a que CONTÉM a raiz sai (o runtime faz a negação vencer a liberação, e a escrita já é fechada por padrão).
   */
  alwaysDeny: readonly string[]
  /** Regras de sistema da instalação (absolutas). */
  system?: readonly IPermissionRule[]
  /**
   * O `.git` do repositório quando a pasta é um repositório ou uma worktree (o da worktree fica FORA dela): liberado
   * para ler e gravar (objetos, refs, locks — `status`, `commit`, `push`), menos o que roda código fora do cerco.
   */
  gitCommonDir?: string
}

/**
 * ⛔ O que o comando nunca grava no `.git`, mesmo liberado: a config (`core.hooksPath`, `core.fsmonitor`), a config da
 * worktree e os hooks. Rodam no PRÓXIMO git de quem não está no cerco (a API, o gateway): seria código fora dele.
 */
export function gitWriteDenies(gitCommonDir: string): string[] {
  return [join(gitCommonDir, 'config'), join(gitCommonDir, 'hooks'), join(gitCommonDir, 'worktrees', '*', 'config.worktree')]
}

/** O padrão de uma regra como caminho para o runtime: relativo vira absoluto na raiz; sem barra vale em qualquer pasta. */
export function toSandboxPath(pattern: string, root: string): string {
  const clean = pattern.trim().replace(/^\.\//, '')
  if (isAbsolute(clean) || clean.startsWith('~')) return clean
  return join(root, clean.includes('/') || clean.startsWith('**') ? clean : `**/${clean}`)
}

/** A negação `deny` sai se uma liberação da camada de cima mora dentro dela (o agente reabriu um pedaço). */
function reopened(deny: string, allows: readonly IPermissionRule[]): boolean {
  const base = deny.replace(/\/\*\*$/, '')
  return allows.some((allow) => allow.pattern === deny || allow.pattern.startsWith(`${base}/`))
}

export function cercoPlan(layers: IPermissionLayers, base: ICercoBase): ICercoPlan {
  const pick = (rules: readonly IPermissionRule[] | undefined, category: 'read' | 'write', decision: 'allow' | 'deny') =>
    (rules ?? []).filter((rule) => rule.category === category && rule.decision === decision)
  const lists = (category: 'read' | 'write') => {
    const agentAllow = pick(layers.agent, category, 'allow')
    const projectAllow = pick(layers.project, category, 'allow')
    const system = [...SYSTEM_RULES, ...(base.system ?? [])].filter((rule) => rule.category === category && rule.decision === 'deny')
    const deny = [...system, ...pick(layers.agent, category, 'deny'), ...pick(layers.project, category, 'deny').filter((rule) => !reopened(rule.pattern, agentAllow))]
    return {
      allow: [...new Set([...agentAllow, ...projectAllow].map((rule) => toSandboxPath(rule.pattern, base.root)))],
      deny: [...new Set(deny.map((rule) => toSandboxPath(rule.pattern, base.root)))],
    }
  }
  const read = lists('read')
  const write = lists('write')
  const git = base.gitCommonDir ? [base.gitCommonDir] : []
  return {
    // A raiz fechada para leitura por padrão: só o que as regras liberam (e as pastas de trabalho) se lê dentro dela.
    readDeny: [...new Set([...base.alwaysDeny, base.root, ...read.deny])],
    readAllow: [...new Set([...base.scratch, ...base.alwaysRead, ...git, ...read.allow])],
    writeAllow: [...new Set([...base.scratch, ...git, ...write.allow])],
    writeDeny: [...new Set([...base.alwaysDeny.filter((path) => !contains(path, base.root)), ...write.deny, ...(base.gitCommonDir ? gitWriteDenies(base.gitCommonDir) : [])])],
  }
}

/** `parent` contém `child` (ou é ele)? */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
