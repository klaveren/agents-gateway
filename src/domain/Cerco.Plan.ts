import { isAbsolute, join, relative } from 'node:path'
import { siblingDir, siblingPattern } from './SiblingRepository.Policy'
import { decide, globToRegex, IPermissionLayers, IPermissionRule, ISystemRule, opened, pathMatches, SYSTEM_RULES } from './Permission.Policy'

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
  /**
   * A pasta do PROJETO, quando a raiz é um repositório ou uma worktree dele: as regras do projeto costumam ser escritas
   * de lá (`repositories/x/infra/**`), e valem também ancoradas nela (ver `IPermissionSubject.aliases`).
   */
  projectRoot?: string
  /** Pastas que o comando sempre lê e escreve: HOME, TMPDIR e caches (na pasta do projeto, fora de uma worktree). */
  scratch: readonly string[]
  /** O que se lê sempre (o auxiliar do runtime, as ferramentas instaladas pela guia Pacotes). */
  alwaysRead: readonly string[]
  /**
   * O que nunca se lê nem escreve, além das regras: a casa de quem roda o gateway, a pasta do app, os dados. Na escrita,
   * a que CONTÉM a raiz sai (o runtime faz a negação vencer a liberação, e a escrita já é fechada por padrão).
   */
  alwaysDeny: readonly string[]
  /**
   * As pastas SÓ LEITURA: os arquivos de recurso (skills, commands, agentes; ver `ResourceFile.Model`). Lidas sempre,
   * gravadas nunca — nem com uma regra de escrita que as cubra: quem grava é o gateway.
   */
  readOnly?: readonly string[]
  /**
   * ⛔ LISTA DE LEITURA (`CERCO_READ_ALLOWLIST=1`): quando presente, o host inteiro (`/`) fecha para leitura e só estes
   * caminhos reabrem (o sistema que os programas precisam: `/usr`, `/lib`, `/etc/ssl`…). Ausente = como sempre foi: o
   * comando lê o que o usuário do servidor lê, menos o que `alwaysDeny` nega.
   */
  readAllowlist?: readonly string[]
  /** Regras de sistema da instalação (absolutas). */
  system?: readonly IPermissionRule[]
  /**
   * ⛔ A PASTA PRIVADA do agente do comando, pelas capacidades dele (ver `agentFolderAccess`), sem regra: lida com `read`,
   * gravada com `write`. As dos outros agentes vão em `alwaysDeny`.
   */
  agentFolder?: { dir: string; read: boolean; write: boolean }
  /**
   * O `.git` do repositório quando a pasta é um repositório ou uma worktree (o da worktree fica FORA dela): liberado
   * para ler e gravar (objetos, refs, locks — `status`, `commit`, `push`), menos o que roda código fora do cerco.
   */
  gitCommonDir?: string
  /** O diretório git da worktree (`<comum>/worktrees/<nome>`): calculado pelo servidor; ausente no modo só repositório. */
  worktreeGitDir?: string
  /**
   * Os arquivos que um padrão pega dentro da raiz (relativos a ela). Com ele, o modelo que a regra de sistema poupa
   * (`.env.example` sob `**\/.env.*`) é reaberto para leitura, um a um: o runtime não tem negação no padrão.
   */
  find?: (pattern: string) => string[]
  /**
   * 🖥️ Onde as regras sem caminho absoluto (`**\/.env`, os segredos) valem no CERCO ABERTO, além da raiz: a máquina toda
   * no Mac (`/`, o perfil aceita o padrão); no Linux, a casa e a pasta de dados (lá o runtime percorre as pastas).
   */
  anywhere?: readonly string[]
  /**
   * Os repositórios de verdade do projeto (`<projeto>/repositories/<nome>`, com `.git` diretório), caminhos reais. Com eles: o
   * irmão do repositório da conversa nunca se grava, e na conversa sem repositório o `.git` de cada um fica protegido.
   */
  repositories?: readonly string[]
  /**
   * ⚖️ A WORKTREE LÊ O REPOSITÓRIO PRINCIPAL: a pasta dele (`dir`) e as entradas que se leem (`entries`, caminhos reais: tudo
   * menos o `.git`, que já vem por `gitCommonDir`, e menos a pasta que contém a worktree, `_worktrees`, com as das outras
   * conversas). Quem sobe as pastas (esbuild, vite, o Node atrás de `node_modules`) passa pela raiz do repositório: fechada,
   * o `package.json` dela virava device ilegível. Só leitura; as negações de leitura (segredos, regras) valem ancoradas nela.
   */
  checkout?: { dir: string; entries: readonly string[] }
}

/**
 * ⛔ O que o comando nunca grava no `.git`, mesmo liberado: a config (`core.hooksPath`, `core.fsmonitor`), a config da
 * worktree, os hooks, os submódulos (config e hooks deles) e os atributos do repositório (filtros). Rodam no PRÓXIMO git
 * de quem não está no cerco (a API, o gateway): seria código fora dele.
 *
 * Na worktree, também o que diz ONDE está o git dela: o arquivo `<worktree>/.git`, o `commondir` e o `gitdir` do
 * diretório dela. Caminhos literais calculados pelo servidor (o runtime ignora curinga no Linux; o do `worktrees/*` se
 * expande onde o cerco é montado).
 */
export function gitWriteDenies(gitCommonDir: string, worktree?: { dir: string; gitDir: string }): string[] {
  return [
    join(gitCommonDir, 'config'),
    join(gitCommonDir, 'config.worktree'),
    join(gitCommonDir, 'hooks'),
    join(gitCommonDir, 'modules'),
    join(gitCommonDir, 'info', 'attributes'),
    join(gitCommonDir, 'worktrees', '*', 'config.worktree'),
    ...(worktree ? [join(worktree.dir, '.git'), join(worktree.gitDir, 'commondir'), join(worktree.gitDir, 'gitdir'), join(worktree.gitDir, 'config.worktree')] : []),
  ]
}

/** O padrão de uma regra como caminho para o runtime: relativo vira absoluto na raiz; sem barra vale em qualquer pasta. */
export function toSandboxPath(pattern: string, root: string): string {
  const clean = pattern.trim().replace(/^\.\//, '')
  if (isAbsolute(clean) || clean.startsWith('~')) return clean
  return join(root, clean.includes('/') || clean.startsWith('**') ? clean : `**/${clean}`)
}

/**
 * O padrão escrito a partir da pasta do projeto, levado para dentro da raiz: `repositories/x/infra/**` numa raiz
 * `<projeto>/repositories/x` vira `<raiz>/infra/**`; `repositories/x/_worktrees/*\/evidence/**` vale na worktree `EP-1`.
 * Nada quando o padrão não chega à raiz, é absoluto ou vale em qualquer pasta (sem barra, `**` no começo).
 */
export function projectAnchored(pattern: string, root: string, projectRoot: string | undefined): string | undefined {
  if (!projectRoot || projectRoot === root) return undefined
  const clean = pattern.trim().replace(/^\.\//, '')
  if (isAbsolute(clean) || clean.startsWith('~') || !clean.includes('/') || clean.startsWith('**')) return undefined
  const prefix = relative(projectRoot, root)
  if (!prefix || prefix.startsWith('..') || isAbsolute(prefix)) return undefined
  const steps = prefix.split(/[\\/]/)
  const parts = clean.split('/')
  for (let i = 0; i < steps.length; i += 1) {
    if (parts[i] === '**') return join(root, parts.slice(i).join('/'))
    if (i >= parts.length || !globToRegex(parts[i]!).test(steps[i]!)) return undefined
  }
  return join(root, parts.slice(steps.length).join('/'))
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
    const system = [...SYSTEM_RULES, ...(base.system ?? [])].filter((rule) => rule.category === category && rule.decision === 'deny' && !opened(rule, layers))
    const deny = [...system, ...pick(layers.agent, category, 'deny'), ...pick(layers.project, category, 'deny').filter((rule) => !reopened(rule.pattern, agentAllow))]
    // ⚖️ Numa worktree ou num repositório, a regra escrita da pasta do projeto vale ancorada nela. A NEGAÇÃO vale também
    // ancorada na raiz (falha fechada); a LIBERAÇÃO, não: `<raiz>/repositories/x/infra` não existe, e o gateway criava a
    // pasta vazia dentro do repositório (ver `writeFolders`).
    const paths = (rules: readonly IPermissionRule[], both: boolean) =>
      rules.flatMap((rule) => {
        const anchored = projectAnchored(rule.pattern, base.root, base.projectRoot)
        return anchored ? (both ? [toSandboxPath(rule.pattern, base.root), anchored] : [anchored]) : [toSandboxPath(rule.pattern, base.root)]
      })
    // ⚖️ O REPOSITÓRIO IRMÃO (ver `SiblingRepository.Policy`): só a LEITURA o abre. A liberação que o nomeia vale pelo caminho
    // absoluto (`repositories/B/**` ancorado na raiz não existe), e as negações valem também nele, ancoradas na pasta dele.
    // A ESCRITA nunca: nenhuma liberação de escrita fica numa pasta de irmão.
    const projectRoot = base.projectRoot
    const sibling = (pattern: string) => (projectRoot ? siblingPattern(pattern, projectRoot, base.root) : undefined)
    const siblingDirs =
      category === 'read' && projectRoot ? [...new Set([...agentAllow, ...projectAllow].flatMap((rule) => siblingDir(rule.pattern, projectRoot, base.root) ?? []))] : []
    const allowPaths = paths([...agentAllow, ...projectAllow], false)
    return {
      allow:
        category === 'read'
          ? [...new Set([...allowPaths, ...[...agentAllow, ...projectAllow].flatMap((rule) => sibling(rule.pattern) ?? [])])]
          : [...new Set(allowPaths)].filter((path) => !(projectRoot && siblingDir(path, projectRoot, base.root))),
      deny: [
        ...new Set([
          ...paths(deny, true),
          ...(category === 'read'
            ? deny.flatMap((rule) => [...[sibling(rule.pattern)].filter((path): path is string => !!path), ...siblingDirs.map((dir) => toSandboxPath(rule.pattern, dir))])
            : []),
        ]),
      ],
    }
  }
  const read = lists('read')
  const write = lists('write')
  // As negações de leitura também no repositório principal que a worktree lê (o `.env` da raiz dele, as regras do projeto).
  const checkoutDeny = base.checkout ? readDenyRules(layers, base).flatMap((rule) => checkoutPaths(rule.pattern, base.checkout!.dir, base.projectRoot)) : []
  const git = base.gitCommonDir ? [base.gitCommonDir] : []
  const repositories = base.repositories ?? []
  // Conversa SEM repositório (a raiz é o projeto): o `.git` de cada repositório dentro dela, como no caso de um só (ver `gitWriteDenies`).
  const inner = repositories.filter((dir) => dir !== base.root && contains(base.root, dir)).flatMap((dir) => gitWriteDenies(join(dir, '.git')))
  // Conversa NUM repositório: os irmãos não se gravam, nem por regra absoluta.
  const siblings = repositories.filter((dir) => !contains(dir, base.root) && !contains(base.root, dir))
  return {
    // A raiz fechada para leitura por padrão: só o que as regras liberam (e as pastas de trabalho) se lê dentro dela.
    readDeny: [...new Set([...(base.readAllowlist ? ['/'] : []), ...base.alwaysDeny, base.root, ...read.deny, ...checkoutDeny])],
    readAllow: [
      ...new Set([
        ...(base.readAllowlist ?? []),
        ...base.scratch,
        ...base.alwaysRead,
        ...git,
        ...read.allow,
        // ⛔ A entrada que uma negação pega não se reabre (o `.env` da raiz: no Linux o runtime só casa `**/.env` abaixo da pasta).
        ...(base.checkout?.entries ?? []).filter((entry) => !checkoutDeny.some((pattern) => pathMatches(pattern, entry))),
        ...(base.readOnly ?? []),
        ...own(base, 'read'),
        ...sparedTemplates(layers, base),
      ]),
    ],
    writeAllow: [...new Set([...base.scratch, ...git, ...write.allow, ...own(base, 'write')])],
    writeDeny: [
      ...new Set([
        ...base.alwaysDeny.filter((path) => !contains(path, base.root)),
        ...write.deny,
        ...(base.gitCommonDir ? gitWriteDenies(base.gitCommonDir, base.worktreeGitDir ? { dir: base.root, gitDir: base.worktreeGitDir } : undefined) : []),
        ...inner,
        ...siblings,
        ...(base.readOnly ?? []),
      ]),
    ],
  }
}

/** As negações de leitura que valem (as do sistema que nenhuma liberação abriu, as do agente e as do projeto que o agente não reabriu). */
function readDenyRules(layers: IPermissionLayers, base: ICercoBase): Array<{ pattern: string }> {
  const agentAllow = (layers.agent ?? []).filter((rule) => rule.category === 'read' && rule.decision === 'allow')
  return [
    ...[...SYSTEM_RULES, ...(base.system ?? [])].filter((rule) => rule.category === 'read' && rule.decision === 'deny' && !opened(rule, layers)),
    ...(layers.agent ?? []).filter((rule) => rule.category === 'read' && rule.decision === 'deny'),
    ...(layers.project ?? []).filter((rule) => rule.category === 'read' && rule.decision === 'deny' && !reopened(rule.pattern, agentAllow)),
  ]
}

/** O padrão no repositório principal: relativo a ele, e o escrito a partir da pasta do projeto ancorado nele. */
function checkoutPaths(pattern: string, dir: string, projectRoot: string | undefined): string[] {
  const anchored = projectAnchored(pattern, dir, projectRoot)
  return [toSandboxPath(pattern, dir), ...(anchored ? [anchored] : [])]
}

/**
 * ⚖️ Os modelos poupados, para LER: o arquivo que o padrão de uma regra de sistema com exceção pega e que a decisão
 * inteira (sistema, agente, projeto) deixa ler. Uma negação do agente ou do projeto que o cubra continua valendo. A
 * escrita fica como está: no runtime a negação vence a liberação, e o modelo segue só leitura no terminal.
 */
function sparedTemplates(layers: IPermissionLayers, base: ICercoBase): string[] {
  if (!base.find) return []
  const system: readonly ISystemRule[] = [...SYSTEM_RULES, ...(base.system ?? [])]
  const patterns = system.filter((rule) => rule.category === 'read' && rule.decision === 'deny' && rule.except?.length).map((rule) => rule.pattern)
  const files = [...new Set(patterns.flatMap((pattern) => base.find!(pattern)))]
  return files.filter((file) => decide({ category: 'read', value: file }, layers, base.system).allowed).map((file) => join(base.root, file))
}

/** A pasta do próprio agente, se ele a lê (ou grava) por capacidade. */
function own(base: ICercoBase, access: 'read' | 'write'): string[] {
  return base.agentFolder?.[access] ? [base.agentFolder.dir] : []
}

/** `parent` contém `child` (ou é ele)? */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 🖥️ O CERCO ABERTO do agente de máquina: lê e grava tudo o que o usuário do servidor pode (`/`), menos o que `alwaysDeny`
 * fecha (os dados do gateway, a configuração dele, as pastas privadas dos outros agentes), os segredos do sistema
 * (`.env`, chaves) e o que uma regra de NEGAR do agente ou do projeto fecha. O `.git` do projeto segue sem config e hooks:
 * eles rodam no próximo git do gateway, fora do cerco.
 */
export function machinePlan(layers: IPermissionLayers, base: ICercoBase): ICercoPlan {
  const deny = (category: 'read' | 'write') =>
    [
      ...[...SYSTEM_RULES, ...(base.system ?? [])].filter((rule) => rule.category === category && rule.decision === 'deny' && !opened(rule, layers)),
      ...[...(layers.agent ?? []), ...(layers.project ?? [])].filter((rule) => rule.category === category && rule.decision === 'deny'),
    ].flatMap((rule) => [base.root, ...(base.anywhere ?? [])].map((anchor) => toSandboxPath(rule.pattern, anchor)))
  return {
    readDeny: [...new Set([...base.alwaysDeny, ...deny('read')])],
    readAllow: [...new Set([...base.scratch, ...base.alwaysRead, ...(base.gitCommonDir ? [base.gitCommonDir] : []), ...own(base, 'read'), ...sparedTemplates(layers, base)])],
    writeAllow: ['/'],
    writeDeny: [
      ...new Set([
        ...base.alwaysDeny,
        ...deny('write'),
        ...(base.gitCommonDir ? gitWriteDenies(base.gitCommonDir, base.worktreeGitDir ? { dir: base.root, gitDir: base.worktreeGitDir } : undefined) : []),
        ...(base.readOnly ?? []),
      ]),
    ],
  }
}
