import { basename } from 'node:path'

/**
 * AS PERMISSÕES DOS AGENTES: o que cada um pode fazer dentro das ferramentas — que comandos roda, que arquivos lê e
 * escreve, que destinos de rede, que ferramentas de MCP, skills e delegações. As capacidades (`cap:`) dizem QUE
 * ferramenta o agente tem; as permissões, O QUE ele faz com ela.
 *
 * ⚖️ CAMADAS (ver docs/research/agent-permissions-research.md):
 * 1. SISTEMA — fixa, sem exceção: `.env`, chaves, os comandos destrutivos. Negação aqui é final (como o `forbid` do
 *    Cedar e as SCP da AWS): nenhuma regra de projeto ou de agente a levanta.
 * 2. AGENTE — se alguma regra dele casa, ela decide: é assim que o agente libera o que o projeto fechou.
 * 3. PROJETO — o que o agente não cobriu.
 * 4. NENHUMA casou — negado (padrão seguro).
 * Dentro de uma camada, NEGAR VENCE PERMITIR, qualquer que seja a ordem: sem arrastar regras, e a leitura de uma
 * lista não depende de onde cada linha está.
 *
 * ⛔ Regra vale onde a ferramenta EXECUTA (o terminal, as ferramentas de arquivo, o hook do Claude, o catálogo de
 * MCP), nunca no prompt.
 */
export type TPermissionCategory = 'terminal' | 'read' | 'write' | 'network' | 'mcp' | 'skill' | 'delegate'
export type TPermissionDecision = 'allow' | 'deny'
export type TPermissionLayer = 'system' | 'agent' | 'project' | 'default'

export const PERMISSION_CATEGORIES: readonly TPermissionCategory[] = ['terminal', 'read', 'write', 'network', 'mcp', 'skill', 'delegate']

export interface IPermissionRule {
  category: TPermissionCategory
  pattern: string
  decision: TPermissionDecision
  note?: string
}

/** O que se pede: um comando (as palavras dele), um caminho, um destino, uma ferramenta, uma skill, um agente. */
export interface IPermissionSubject {
  category: TPermissionCategory
  /** Caminho: relativo à pasta de trabalho (`apps/x.ts`) ou absoluto, se fora dela. Comando: o texto, para exibir. */
  value: string
  /** Comando: as palavras já analisadas (aspas resolvidas). */
  argv?: string[]
}

export interface IPermissionVerdict {
  allowed: boolean
  layer: TPermissionLayer
  rule?: IPermissionRule
  /** Para quem lê: a regra e a camada que decidiram. */
  reason: string
}

export interface IPermissionLayers {
  agent?: readonly IPermissionRule[]
  project?: readonly IPermissionRule[]
}

export const PERMISSION_LIMITS = { rules: 300, pattern: 300, note: 200 } as const

/** ⛔ A camada SISTEMA: segredos e comandos que derrubam o servidor. Sem exceção em nenhuma camada. */
export const SYSTEM_RULES: readonly IPermissionRule[] = [
  ...['**/.env', '**/.env.*', '**/*.key', '**/*.pem', '**/id_rsa*', '**/id_ed25519*', '**/secrets.*'].flatMap((pattern) => [
    { category: 'read' as const, pattern, decision: 'deny' as const, note: 'segredo' },
    { category: 'write' as const, pattern, decision: 'deny' as const, note: 'segredo' },
  ]),
  ...['rm -rf /', 'rm -rf /*', 'rm -fr /', 'mkfs*', 'mkfs* *', 'shutdown *', 'reboot *', 'halt *', 'poweroff *', 'sudo *', 'doas *', 'chmod -R 777 /', 'dd * of=/dev/*'].map(
    (pattern) => ({ category: 'terminal' as const, pattern, decision: 'deny' as const, note: 'pode derrubar o servidor' }),
  ),
  // `curl … | sh`: o shell lendo da entrada padrão (sem script) executa o que chegar pela rede.
  ...['sh', 'bash', 'zsh', 'dash'].map((pattern) => ({ category: 'terminal' as const, pattern, decision: 'deny' as const, note: 'shell lendo da entrada' })),
]

/**
 * A decisão para um pedido, com as camadas do agente e do projeto. `system` extra: regras de sistema da instalação
 * (a pasta de dados do gateway, em caminho absoluto), somadas às fixas.
 */
export function decide(subject: IPermissionSubject, layers: IPermissionLayers, system: readonly IPermissionRule[] = []): IPermissionVerdict {
  const floor = [...SYSTEM_RULES, ...system].find((rule) => rule.decision === 'deny' && matches(rule, subject))
  if (floor) return { allowed: false, layer: 'system', rule: floor, reason: `negado pelo sistema (${floor.pattern}${floor.note ? ` — ${floor.note}` : ''})` }
  for (const layer of ['agent', 'project'] as const) {
    const hit = (layers[layer] ?? []).filter((rule) => matches(rule, subject))
    if (!hit.length) continue
    const rule = hit.find((item) => item.decision === 'deny') ?? hit[0]
    const where = layer === 'agent' ? 'do agente' : 'do projeto'
    return { allowed: rule.decision === 'allow', layer, rule, reason: `${rule.decision === 'allow' ? 'permitido' : 'negado'} pela regra ${where} "${rule.pattern}"` }
  }
  return { allowed: false, layer: 'default', reason: `negado: nenhuma regra de ${CATEGORY_LABEL[subject.category]} permite "${subject.value}"` }
}

export const CATEGORY_LABEL: Readonly<Record<TPermissionCategory, string>> = {
  terminal: 'terminal',
  read: 'leitura',
  write: 'escrita',
  network: 'rede',
  mcp: 'MCP',
  skill: 'skill',
  delegate: 'delegação',
}

export function matches(rule: IPermissionRule, subject: IPermissionSubject): boolean {
  if (rule.category !== subject.category) return false
  switch (rule.category) {
    case 'terminal':
      return commandMatches(rule.pattern, subject.argv ?? subject.value.trim().split(/\s+/))
    case 'read':
    case 'write':
      return pathMatches(rule.pattern, subject.value)
    case 'network':
      return hostMatches(rule.pattern, subject.value)
    default:
      return globMatches(rule.pattern, subject.value)
  }
}

/**
 * Comando por PALAVRAS: `git push *` casa `git push origin main`; um `*` sozinho casa qualquer sequência de palavras
 * (inclusive nenhuma), e dentro de uma palavra casa caracteres (`npm run test*`). O nome do comando vale pela base:
 * `/bin/rm` é `rm` — senão bastaria o caminho inteiro para fugir da regra.
 */
export function commandMatches(pattern: string, argv: readonly string[]): boolean {
  const want = pattern.trim().split(/\s+/).filter(Boolean)
  if (!want.length || !argv.length) return false
  const got = [basename(argv[0]), ...argv.slice(1)]
  const walk = (i: number, j: number): boolean => {
    if (i === want.length) return j === got.length
    if (want[i] === '*') return walk(i + 1, j) || (j < got.length && walk(i, j + 1))
    return j < got.length && wordMatches(want[i], got[j]) && walk(i + 1, j + 1)
  }
  return walk(0, 0)
}

function wordMatches(pattern: string, word: string): boolean {
  return new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`, 's').test(word)
}

/**
 * Caminho em glob, sempre sobre o caminho CANÔNICO (quem chama já resolveu `..` e links): `apps/**`, `src/*.ts`.
 * Padrão sem `/` casa o nome em qualquer pasta (`*.env`), como no `.gitignore`. Absoluto (`/srv/x/**`, `~/.ssh/k`):
 * fora da pasta de trabalho.
 */
export function pathMatches(pattern: string, path: string): boolean {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const target = pattern.trim().replace(/^\.\//, '')
  if (!target.includes('/')) return globToRegex(target).test(clean.split('/').pop() ?? clean) || globToRegex(target).test(clean)
  // `apps/**` vale também para a própria pasta `apps` (a busca e a listagem pedem a pasta).
  if (target.endsWith('/**') && clean === target.slice(0, -3)) return true
  return globToRegex(target).test(clean)
}

function globToRegex(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      // `**/` casa zero ou mais pastas; `**` no fim casa tudo o que vem abaixo.
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += escape(char)
  }
  return new RegExp(`^${source}$`)
}

/** Destino de rede: `api.github.com`, `*.logiccus.com` (subdomínios), com porta opcional (`prod.x.com:22`). */
export function hostMatches(pattern: string, target: string): boolean {
  const [wantHost, wantPort] = splitHost(pattern.trim().toLowerCase())
  const [host, port] = splitHost(target.trim().toLowerCase())
  if (wantPort && wantPort !== port) return false
  if (wantHost === '*') return true
  if (wantHost.startsWith('*.')) return host.endsWith(wantHost.slice(1)) && host.length > wantHost.length - 1
  return host === wantHost
}

function splitHost(value: string): [string, string | undefined] {
  const at = value.lastIndexOf(':')
  return at > 0 && /^\d+$/.test(value.slice(at + 1)) ? [value.slice(0, at), value.slice(at + 1)] : [value, undefined]
}

function globMatches(pattern: string, value: string): boolean {
  return new RegExp(`^${pattern.trim().split('*').map(escape).join('.*')}$`).test(value)
}

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/** O que está errado numa lista de regras (o salvamento recusa com isto). */
export function permissionIssues(rules: unknown): Array<{ field: string; message: string }> {
  if (rules === undefined) return []
  if (!Array.isArray(rules)) return [{ field: 'permissions', message: 'a list of { category, pattern, decision }' }]
  if (rules.length > PERMISSION_LIMITS.rules) return [{ field: 'permissions', message: `at most ${PERMISSION_LIMITS.rules} rules` }]
  const issues: Array<{ field: string; message: string }> = []
  rules.forEach((rule, index) => {
    const entry = rule as Partial<IPermissionRule> | null
    const at = `permissions[${index}]`
    if (!PERMISSION_CATEGORIES.includes(entry?.category as TPermissionCategory)) issues.push({ field: at, message: `category: one of ${PERMISSION_CATEGORIES.join(', ')}` })
    if (entry?.decision !== 'allow' && entry?.decision !== 'deny') issues.push({ field: at, message: 'decision: allow or deny' })
    const pattern = typeof entry?.pattern === 'string' ? entry.pattern.trim() : ''
    if (!pattern) issues.push({ field: at, message: 'pattern: required' })
    else if (pattern.length > PERMISSION_LIMITS.pattern) issues.push({ field: at, message: `pattern: at most ${PERMISSION_LIMITS.pattern} characters` })
    if (entry?.note !== undefined && (typeof entry.note !== 'string' || entry.note.length > PERMISSION_LIMITS.note))
      issues.push({ field: at, message: `note: at most ${PERMISSION_LIMITS.note} characters` })
  })
  return issues
}

/** As regras limpas para gravar (espaços aparados, sem nota vazia). */
export function cleanRules(rules: readonly IPermissionRule[]): IPermissionRule[] {
  return rules.map((rule) => ({ category: rule.category, pattern: rule.pattern.trim(), decision: rule.decision, ...(rule.note?.trim() ? { note: rule.note.trim() } : {}) }))
}
