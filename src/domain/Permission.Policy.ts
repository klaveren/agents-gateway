import { basename } from 'node:path'

/**
 * AS PERMISSÕES DOS AGENTES: o que cada um pode fazer dentro das ferramentas — que comandos roda, que arquivos lê e
 * escreve, que destinos de rede, que ferramentas de MCP, skills, delegações e contas do projeto. As capacidades (`cap:`) dizem QUE
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
export type TPermissionCategory = 'terminal' | 'read' | 'write' | 'network' | 'mcp' | 'skill' | 'delegate' | 'account' | 'repository' | 'trigger'
export type TPermissionDecision = 'allow' | 'deny'
export type TPermissionLayer = 'system' | 'agent' | 'project' | 'default'

export const PERMISSION_CATEGORIES: readonly TPermissionCategory[] = ['terminal', 'read', 'write', 'network', 'mcp', 'skill', 'delegate', 'account', 'repository', 'trigger']

export interface IPermissionRule {
  category: TPermissionCategory
  pattern: string
  decision: TPermissionDecision
  note?: string
}

/** A regra de SISTEMA (fixa, nunca gravada): pode poupar o que o padrão pega mas ela não quer (os modelos `.env.example`). */
export interface ISystemRule extends IPermissionRule {
  except?: readonly string[]
}

/** O que se pede: um comando (as palavras dele), um caminho, um destino, uma ferramenta, uma skill, um agente. */
export interface IPermissionSubject {
  category: TPermissionCategory
  /** Caminho: relativo à pasta de trabalho (`apps/x.ts`) ou absoluto, se fora dela. Comando: o texto, para exibir. */
  value: string
  /** Comando: as palavras já analisadas (aspas resolvidas). */
  argv?: string[]
  /**
   * Caminho: o MESMO arquivo visto de outra pasta-base. Numa conversa aberta numa worktree (ou num repositório), a pasta
   * de trabalho é a worktree, mas as regras do projeto costumam ser escritas a partir da pasta do PROJETO
   * (`repositories/x/_worktrees/*\/**`). A regra casa com qualquer uma das formas; a negação continua vencendo.
   */
  aliases?: string[]
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
/**
 * Os MODELOS de segredo: `.env.example`, `.env.local.sample`… vão para o repositório de propósito, sem valor. Escondidos,
 * o git do cerco quebra (o arquivo versionado vira `/dev/null`: "unsupported file type").
 */
export const SECRET_TEMPLATES: readonly string[] = ['**/*.example', '**/*.sample', '**/*.template', '**/*.dist']

/** `secrets.*` só em arquivo de DADOS: `secrets.js`, `secrets.sh` são código (quem lê o valor), não o segredo. */
const SECRET_DATA = ['json', 'yaml', 'yml', 'toml', 'env', 'txt', 'ini'].map((extension) => `**/secrets.${extension}`)

const SECRETS: readonly { pattern: string; except?: readonly string[] }[] = [
  { pattern: '**/.env' },
  { pattern: '**/.env.*', except: SECRET_TEMPLATES },
  // ⛔ A pasta de credenciais: o env do PRÓPRIO gateway mora num `.credentials/` do repositório do projeto (lido no
  // cerco em 07/11). ⚖️ Não `**/*.env`: o repositório versiona perfis `*.env` sem segredo, e mascará-los suja o git.
  { pattern: '**/.credentials/**' },
  ...['**/*.key', '**/*.pem', '**/id_rsa*', '**/id_ed25519*', ...SECRET_DATA].map((pattern) => ({ pattern })),
]

export const SYSTEM_RULES: readonly ISystemRule[] = [
  ...SECRETS.flatMap((secret) =>
    (['read', 'write'] as const).map((category) => ({
      category,
      pattern: secret.pattern,
      decision: 'deny' as const,
      note: 'segredo',
      ...(secret.except ? { except: secret.except } : {}),
    })),
  ),
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
    // ⚖️ Entre as que liberam, a EXATA vem antes do curinga: o portão só deixa a rede local passar com regra exata, e um
    // `network *` salvo antes de `10.10.0.1:22` fazia o `*` decidir (e a rede local ser recusada).
    const rule = hit.find((item) => item.decision === 'deny') ?? hit.find((item) => !item.pattern.includes('*')) ?? hit[0]
    const where = layer === 'agent' ? 'do agente' : 'do projeto'
    return { allowed: rule.decision === 'allow', layer, rule, reason: `${rule.decision === 'allow' ? 'permitido' : 'negado'} pela regra ${where} "${rule.pattern}"` }
  }
  if (OPEN_BY_DEFAULT.includes(subject.category))
    return { allowed: true, layer: 'default', reason: `permitido: sem regra, ${CATEGORY_LABEL[subject.category]} do projeto vale para os agentes dele` }
  return { allowed: false, layer: 'default', reason: `negado: nenhuma regra de ${CATEGORY_LABEL[subject.category]} permite "${subject.value}"` }
}

/**
 * ⚖️ O que vale SEM regra. O repositório é escopo, não ação: o projeto já delimita onde o agente trabalha, e o que ele
 * faz lá dentro (ler, gravar, rodar) segue negado sem regra. A regra `repository` só serve para RESTRINGIR (Negar).
 */
const OPEN_BY_DEFAULT: readonly TPermissionCategory[] = ['repository']

export const CATEGORY_LABEL: Readonly<Record<TPermissionCategory, string>> = {
  terminal: 'terminal',
  read: 'leitura',
  write: 'escrita',
  network: 'rede',
  mcp: 'MCP',
  skill: 'skill',
  delegate: 'delegação',
  account: 'conta',
  repository: 'repositório',
  trigger: 'trigger',
}

export function matches(rule: ISystemRule, subject: IPermissionSubject): boolean {
  if (rule.category !== subject.category) return false
  switch (rule.category) {
    case 'terminal': {
      const argv = subject.argv ?? subject.value.trim().split(/\s+/)
      // ⛔ NEGAR olha também o comando sem as opções globais (`git -C . push`, `kubectl -n x delete`) e na dúvida pega.
      // LIBERAR não: é a palavra literal, nunca mais larga (e o apelido `-c alias.*` do git não é liberado por curinga).
      return rule.decision === 'deny' ? denyCommandMatches(rule.pattern, argv) : !hasGitAlias(argv) && commandMatches(rule.pattern, argv)
    }
    case 'read':
    case 'write':
      // ⛔ Liberação RELATIVA vale só dentro da pasta: `**` não alcança `/outra/pasta` nem `~/.ssh` (fora dela, o caminho
      // chega absoluto). Para liberar fora, a regra é absoluta. A negação vale em qualquer lugar (`**/.env`).
      return [subject.value, ...(subject.aliases ?? [])].some((value) => {
        if (rule.decision === 'allow' && isOutsidePath(value) && !isOutsidePath(rule.pattern.trim())) return false
        return pathMatches(rule.pattern, value) && !rule.except?.some((pattern) => pathMatches(pattern, value))
      })
    case 'network':
      return hostMatches(rule.pattern, subject.value)
    default:
      return globMatches(rule.pattern, subject.value)
  }
}

/**
 * Comando por PALAVRAS: `git push *` casa `git push origin main`; um `*` sozinho casa qualquer sequência de palavras
 * (inclusive nenhuma), e dentro de uma palavra casa caracteres (`npm run test*`); colado na última palavra, cobre também as
 * palavras seguintes (`git status*` casa `git status --short`). O nome do comando vale pela base:
 * `/bin/rm` é `rm` — senão bastaria o caminho inteiro para fugir da regra.
 */
export function commandMatches(pattern: string, argv: readonly string[]): boolean {
  const want = pattern.trim().split(/\s+/).filter(Boolean)
  if (!want.length || !argv.length) return false
  const got = [basename(argv[0]), ...argv.slice(1)]
  const walk = (i: number, j: number): boolean => {
    if (i === want.length) return j === got.length
    if (want[i] === '*') return walk(i + 1, j) || (j < got.length && walk(i, j + 1))
    // ⚖️ O `*` colado na ÚLTIMA palavra (`git status*`) é prefixo do comando, como se escreve no Claude Code: cobre
    // `git status --short`. Antes cobria só a palavra, e a regra aprovada `git status*` recusava `git status --short`.
    if (i === want.length - 1 && want[i].endsWith('*') && /[^*]/.test(want[i])) return j < got.length && wordMatches(want[i], got[j])
    return j < got.length && wordMatches(want[i], got[j]) && walk(i + 1, j + 1)
  }
  return walk(0, 0)
}

/**
 * ⛔ As opções GLOBAIS (antes do subcomando) de cada ferramenta, com as que levam valor: `git -C . push`, `kubectl -n prod
 * delete` não podem escapar de `deny git push *` / `deny kubectl delete *`. Opção fora da lista vale como flag sem valor.
 */
const GLOBAL_OPTIONS: Record<string, readonly string[]> = {
  git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--attr-source'],
  kubectl: [
    '-n',
    '--namespace',
    '--context',
    '--kubeconfig',
    '--cluster',
    '--user',
    '-s',
    '--server',
    '--token',
    '--as',
    '--as-group',
    '--as-uid',
    '--request-timeout',
    '-v',
    '--v',
    '--certificate-authority',
    '--client-certificate',
    '--client-key',
    '--cache-dir',
    '--tls-server-name',
    '--profile',
    '--profile-output',
    '--username',
    '--password',
  ],
  docker: ['-H', '--host', '--context', '-c', '-l', '--log-level', '--config', '--tlscacert', '--tlscert', '--tlskey'],
  helm: [
    '-n',
    '--namespace',
    '--kube-context',
    '--kubeconfig',
    '--kube-apiserver',
    '--kube-token',
    '--kube-as-user',
    '--kube-as-group',
    '--kube-ca-file',
    '--kube-tls-server-name',
    '--burst-limit',
    '--qps',
    '--registry-config',
    '--repository-cache',
    '--repository-config',
  ],
  gh: ['-R', '--repo', '--hostname'],
  systemctl: ['-H', '--host', '-M', '--machine', '--root', '-t', '--type', '-p', '--property', '--state', '--kill-whom', '-s', '--signal', '-n', '--lines', '-o', '--output'],
}
GLOBAL_OPTIONS.oc = GLOBAL_OPTIONS.kubectl
GLOBAL_OPTIONS.podman = GLOBAL_OPTIONS.docker

/** O argv sem as opções globais antes do subcomando. `valueless`: toda opção vale como flag, sem valor na palavra seguinte. */
function withoutGlobalOptions(argv: readonly string[], valueless = false): string[] {
  const known = GLOBAL_OPTIONS[basename(argv[0])]
  if (!known) return [...argv]
  let i = 1
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '-') {
    if (argv[i] === '--') {
      i += 1
      break
    }
    // `--opt=valor` e `-nvalor` trazem o valor junto; `-n valor` e `--opt valor` levam a palavra seguinte.
    i += !valueless && known.includes(argv[i]) ? 2 : 1
  }
  return [argv[0], ...argv.slice(i)]
}

/** `-c alias.p=push p`: o subcomando real some atrás de um apelido definido na própria linha do git. */
function hasGitAlias(argv: readonly string[]): boolean {
  if (basename(argv[0] ?? '') !== 'git') return false
  let i = 1
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--') {
    if ((argv[i] === '-c' || argv[i] === '--config-env') && /^alias\./i.test(argv[i + 1] ?? '')) return true
    if (/^(-c|--config-env=)alias\./i.test(argv[i])) return true
    i += GLOBAL_OPTIONS.git.includes(argv[i]) ? 2 : 1
  }
  return false
}

/**
 * Os subcomandos que o git traz (embutidos e os scripts que ele instala): o git resolve esses ANTES de qualquer apelido, então
 * um apelido nunca os sobrepõe. Qualquer outro nome pode ser um apelido (`alias.p=push` no `.gitconfig`) para outro subcomando.
 */
const GIT_KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set(
  (
    'add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick ' +
    'citool clean clone column commit commit-graph commit-tree config count-objects credential describe diagnose diff diff-files diff-index diff-tree difftool fast-export ' +
    'fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id gitk grep gui hash-object help hook index-pack ' +
    'init init-db instaweb interpret-trailers log ls-files ls-remote ls-tree maintenance mailinfo mailsplit merge merge-base merge-file merge-index merge-tree mergetool mktag ' +
    'mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase receive-pack reflog ' +
    'remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-index show-ref sparse-checkout ' +
    'stage stash status stripspace submodule subtree switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive upload-pack ' +
    'var verify-commit verify-pack verify-tag version whatchanged worktree write-tree'
  ).split(' '),
)

/** O subcomando do git (depois das opções globais, lidas com os valores delas, como o git lê); `undefined` se não há. */
function gitSubcommand(argv: readonly string[]): string | undefined {
  if (basename(argv[0] ?? '') !== 'git') return undefined
  return withoutGlobalOptions(argv)[1]
}

/**
 * ⛔ Subcomando que NÃO é do git (`git p origin main`): pode ser um apelido (`alias.p=push`, gravado no `.gitconfig` do
 * projeto ou com `git config alias.p push`), então vale como qualquer subcomando e casa toda negação do git (falha fechada).
 */
function unknownGitSubcommand(argv: readonly string[]): boolean {
  const sub = gitSubcommand(argv)
  return !!sub && !sub.startsWith('-') && !GIT_KNOWN_SUBCOMMANDS.has(sub)
}

/**
 * ⛔ `git config alias.p push` (também `--global`, `--file`, `--add`): é como se cria o desvio de uma negação do git.
 * Quem chama decide se vale (só há problema com negação de git ativa).
 */
export function definesGitAlias(argv: readonly string[]): boolean {
  if (gitSubcommand(argv) !== 'config') return false
  return argv.slice(argv.indexOf('config') + 1).some((word) => /^alias\./i.test(word))
}

/** Há regra de terminal que NEGA comandos do git (`git push *`, `git *`)? */
export function hasGitDeny(rules: readonly IPermissionRule[]): boolean {
  return rules.some((rule) => rule.category === 'terminal' && rule.decision === 'deny' && wordMatches(rule.pattern.trim().split(/\s+/)[0] ?? '', 'git'))
}

/**
 * ⛔ NEGAR casa o comando como escrito OU sem as opções globais (das duas leituras: a das opções com valor e a que trata
 * toda opção como flag): na dúvida, vence a negação. E o apelido definido na linha (`-c alias.*`) casa toda negação do
 * git, porque o subcomando real é incerto.
 */
export function denyCommandMatches(pattern: string, argv: readonly string[]): boolean {
  if (!argv.length) return false
  if (commandMatches(pattern, argv)) return true
  const gitPattern = wordMatches(pattern.trim().split(/\s+/)[0] ?? '', 'git')
  if (gitPattern && (hasGitAlias(argv) || unknownGitSubcommand(argv))) return true
  return [withoutGlobalOptions(argv), withoutGlobalOptions(argv, true)].some((candidate) => candidate.length < argv.length && commandMatches(pattern, candidate))
}

function wordMatches(pattern: string, word: string): boolean {
  return new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`, 's').test(word)
}

/**
 * Caminho em glob, sempre sobre o caminho CANÔNICO (quem chama já resolveu `..` e links): `apps/**`, `src/*.ts`.
 * Padrão sem `/` casa o nome em qualquer pasta (`*.env`), como no `.gitignore`. Absoluto (`/srv/x/**`, `~/.ssh/k`):
 * fora da pasta de trabalho.
 */
/** Caminho de fora da pasta de trabalho: absoluto ou da casa (`~`). Os de dentro chegam relativos. */
function isOutsidePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)
}

export function pathMatches(pattern: string, path: string): boolean {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const target = pattern.trim().replace(/^\.\//, '')
  if (!target.includes('/')) return globToRegex(target).test(clean.split('/').pop() ?? clean) || globToRegex(target).test(clean)
  // `apps/**` vale também para a própria pasta `apps` (a busca e a listagem pedem a pasta).
  if (target.endsWith('/**') && clean === target.slice(0, -3)) return true
  return globToRegex(target).test(clean)
}

export function globToRegex(pattern: string): RegExp {
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

/**
 * ⛔ `**` no terminal: o padrão é por palavras, e só o `*` sozinho vale qualquer sequência. `**` vira curinga de UMA
 * palavra — casa `ls`, não `cat arquivo` —, e quem o escreve quer "qualquer comando" (é o que ele quer dizer em caminho).
 */
const LONE_STARS = /(^|\s)\*{2,}(\s|$)/

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
    else if (entry?.category === 'terminal' && LONE_STARS.test(pattern))
      issues.push({ field: at, message: 'pattern: in a terminal rule use * for any arguments (** matches a single word only)' })
    if (entry?.note !== undefined && (typeof entry.note !== 'string' || entry.note.length > PERMISSION_LIMITS.note))
      issues.push({ field: at, message: `note: at most ${PERMISSION_LIMITS.note} characters` })
  })
  return issues
}

/** As regras limpas para gravar (espaços aparados, sem nota vazia). */
export function cleanRules(rules: readonly IPermissionRule[]): IPermissionRule[] {
  return rules.map((rule) => ({ category: rule.category, pattern: rule.pattern.trim(), decision: rule.decision, ...(rule.note?.trim() ? { note: rule.note.trim() } : {}) }))
}
