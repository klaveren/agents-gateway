import { posix } from 'node:path'
import { frontmatter, resolveCitation } from '@domain/Import.Refs'
import { IInventoryNote } from '@domain/models/ImportInventory.Model'
import { IDetectedItem, IFormatDetector, IRepoTree } from '@domain/ports/FormatDetector.Port'
import { under } from './AgentsDir.Detector'
import { parseJsonc } from './Opencode.Detector'

const ROOT = '.claude/'
const DOC = /\.(md|mdx|markdown)$/i
const SETTINGS = ['.claude/settings.json', '.claude/settings.local.json']
const MCP_JSON = '.mcp.json'
/** O nome da memória do Claude Code: `CLAUDE.md` em qualquer pasta, e `CLAUDE.local.md` (pessoal). */
const MEMORY = /^claude(\.local)?\.md$/i
/** O que mora em `.claude/` e fica fora do catálogo: scripts, hooks, memória, ledger, logs. */
const OUT_OF_CATALOG = /^(scripts|hooks|todos|plans|(.+[-_])?(memory|memories|ledger|logs?|sessions|state))$/i
/** As cópias de trabalho (git worktree) que o Claude Code cria: outro checkout do mesmo repositório, nunca recurso. */
const WORKTREES = '.claude/worktrees/'
/** Rule aceita até 4 KB (`Guidance`): passou disso, vira várias rules ou uma spec. */
const RULE_MAX_BYTES = 4 * 1024
/** O Claude Code segue `@arquivo` até 5 níveis. */
const IMPORT_DEPTH = 5

const stripExt = (path: string) => path.replace(/\.[^./]+$/, '')
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Fora de cópia de trabalho do Claude Code (o `CLAUDE.md` e o `AGENTS.md` de lá são de outro checkout). */
export const inWorktreeCopy = (path: string) => path.startsWith(WORKTREES)

/** O primeiro título do markdown, sem frontmatter nem comentário HTML (o carimbo em comentário não é título). */
export function memoryTitle(text: string): string | undefined {
  const body = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/<!--[\s\S]*?-->/g, '')
  return /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]
}

/** As notas de um arquivo de instruções do projeto (`CLAUDE.md`, `AGENTS.md`): onde vale e se cabe numa rule. */
export function memoryNotes(path: string, bytes: number, file: string): IInventoryNote[] {
  const notes: IInventoryNote[] = [
    {
      level: 'info',
      code: 'protocol-complement',
      text: `${file}: candidato a rule ou a complemento de protocolo do projeto (língua, padrões); o complemento quem escreve é a pessoa, na tela de protocolos`,
    },
  ]
  const dir = posix.dirname(path)
  if (dir !== '.' && dir !== '.claude') notes.push({ level: 'info', code: 'scoped', text: `vale para a pasta ${dir}/` })
  if (bytes > RULE_MAX_BYTES)
    notes.push({ level: 'attention', code: 'over-rule-limit', text: `${Math.ceil(bytes / 1024)} KB: uma rule aceita 4 KB; vira várias rules, ou uma spec` })
  return notes
}

/** Os `@caminho` do Claude Code (importação de arquivo na memória), fora de bloco e de trecho de código. */
export function claudeImports(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const found = new Set<string>()
  for (const match of prose.matchAll(/(?:^|\s)@([^\s`'"()<>[\]]+)/g)) {
    const path = match[1].replace(/[.,;:]+$/, '')
    // Só o que tem cara de arquivo: `@AGENTS.md`, `@docs/x.md`; `@fulano` e `@types/node` não.
    if (/\.[A-Za-z0-9]{1,8}$/.test(path)) found.add(path)
  }
  return [...found]
}

/** Os nomes das ferramentas de uma regra de permissão do Claude Code: `Bash(npm run *)` → `Bash`. Nunca o argumento. */
const toolOf = (rule: string) => /^\s*([A-Za-z_][\w-]*)/.exec(rule)?.[1]

/**
 * O formato do Claude Code: `.claude/agents/*.md` = agente, `.claude/commands/**.md` = command (a pasta vira
 * prefixo), `.claude/skills/<id>/SKILL.md` = skill, `CLAUDE.md` (raiz e subpastas, e o `.claude/CLAUDE.md`) = rule
 * candidata, com o que ele importa por `@arquivo`; `.claude/settings*.json` e `.mcp.json` = a configuração (permissões,
 * hooks, `env`, servidores MCP), que só vira nota: a tradução do alcance é de outro PR.
 *
 * ⛔ Da configuração saem só NOMES (ferramenta, evento de hook, variável, servidor) e contagens, nunca valor nem o
 * argumento da regra (`Bash(curl -H "Authorization: …")`): o segredo fica no arquivo, que já chega mascarado.
 */
export class ClaudeDetector implements IFormatDetector {
  readonly id = 'claude'

  detects(tree: IRepoTree): boolean {
    return tree.entries().some((entry) => [entry.path, ...entry.aliases].some((path) => (path.startsWith(ROOT) && !inWorktreeCopy(path)) || this.isMemory(path)))
  }

  scan(tree: IRepoTree): IDetectedItem[] {
    const items: IDetectedItem[] = []
    const skills = new Map<string, IDetectedItem>()
    const skipped = new Map<string, IDetectedItem>()
    const imported = new Set<string>()
    const unknown: Array<{ path: string; name: string }> = []
    let worktreeFiles = 0

    const skip = (dir: string, path: string) => {
      const item = skipped.get(dir) ?? {
        kind: 'skip' as const,
        name: dir,
        sources: [],
        notes: [{ level: 'info' as const, code: 'out-of-catalog', text: 'scripts, hooks, memória e histórico do Claude Code ficam fora do catálogo' }],
      }
      item.sources.push({ path })
      skipped.set(dir, item)
    }

    // A memória primeiro: o que ela importa de dentro de `.claude/` é dela, e não fica desconhecido.
    for (const entry of tree.entries()) {
      const path = [entry.path, ...entry.aliases].find((candidate) => this.isMemory(candidate))
      if (!path) continue
      const item = this.memory(tree, entry.path, path)
      for (const source of item.sources) imported.add(source.path)
      items.push(item)
    }

    for (const entry of tree.entries()) {
      if (inWorktreeCopy(entry.path) && !entry.aliases.some((alias) => !inWorktreeCopy(alias))) {
        worktreeFiles++
        continue
      }
      const rel = under({ ...entry, aliases: entry.aliases.filter((alias) => !inWorktreeCopy(alias)) }, ROOT)
      if (rel === undefined || imported.has(entry.path)) continue
      const parts = rel.split('/')
      const base = parts[parts.length - 1]

      if (parts[0] === 'agents' && parts.length >= 2 && DOC.test(base)) {
        const meta = frontmatter(tree.read(entry.path)?.text ?? '')
        items.push({
          kind: 'agent',
          name: meta.name || stripExt(base),
          sources: [{ path: entry.path, role: 'prompt' }],
          fields: pick(meta, ['model', 'description']),
          notes: meta.tools !== undefined ? [reachPending] : [],
        })
        continue
      }
      if (parts[0] === 'commands' && parts.length >= 2 && DOC.test(base)) {
        const meta = frontmatter(tree.read(entry.path)?.text ?? '')
        const notes: IInventoryNote[] = []
        if (meta['allowed-tools'] !== undefined)
          notes.push({ level: 'untranslatable', code: 'command-allowed-tools', text: 'o command limita as ferramentas (allowed-tools); o gateway não tem esse campo' })
        if (meta.model) notes.push({ level: 'untranslatable', code: 'command-model', text: `o command escolhe o modelo (model: ${meta.model}); o gateway não tem esse campo` })
        items.push({
          kind: 'command',
          name: stripExt(parts.slice(1).join('/')),
          sources: [{ path: entry.path, role: 'command' }],
          fields: pick(meta, ['description']),
          notes,
        })
        continue
      }
      if (parts[0] === 'skills' && parts.length >= 3) {
        const skillName = parts[1]
        const skill = skills.get(skillName) ?? { kind: 'skill' as const, name: skillName, sources: [], notes: [] }
        skills.set(skillName, skill)
        skill.sources.push({ path: entry.path, role: parts.length === 3 && /^skill\.md$/i.test(base) ? 'skill' : 'attachment' })
        continue
      }
      if (SETTINGS.includes(`${ROOT}${rel}`)) continue
      if (parts.length > 1 && OUT_OF_CATALOG.test(parts[0])) {
        skip(`${ROOT}${parts[0]}`, entry.path)
        continue
      }
      unknown.push({ path: entry.path, name: `${ROOT}${rel}` })
    }

    for (const skill of skills.values()) {
      if (!skill.sources.some((source) => source.role === 'skill')) {
        for (const source of skill.sources) unknown.push({ path: source.path, name: source.path })
        continue
      }
      items.push(skill)
    }
    for (const { path, name } of unknown) if (!imported.has(path)) items.push({ kind: 'unknown', name, sources: [{ path }] })
    items.push(...skipped.values())
    if (worktreeFiles)
      items.push({
        kind: 'skip',
        name: WORKTREES.slice(0, -1),
        sources: [],
        notes: [
          { level: 'info', code: 'worktree-copies', text: `cópias de trabalho do Claude Code (${worktreeFiles} arquivo(s)): outro checkout do repositório, fora da varredura` },
        ],
      })
    items.push(...this.config(tree))
    return items
  }

  private isMemory(path: string): boolean {
    return MEMORY.test(posix.basename(path)) && !inWorktreeCopy(path)
  }

  /** `CLAUDE.md`: rule candidata. O que ele importa (`@arquivo`) de dentro de `.claude/` é fonte dele; o resto, citação. */
  private memory(tree: IRepoTree, real: string, seenAs: string): IDetectedItem {
    const file = tree.read(real)
    const text = file?.text ?? ''
    const local = /\.local\.md$/i.test(seenAs)
    const sources: IDetectedItem['sources'] = [{ path: real, role: 'memory' }]
    const cites: string[] = []
    const notes: IInventoryNote[] = []
    if (local) notes.push({ level: 'attention', code: 'local-memory', text: `${posix.basename(seenAs)} é pessoal (normalmente fora do git)` })

    const visit = (path: string, body: string, depth: number) => {
      for (const cited of claudeImports(body)) {
        if (cited.startsWith('~')) {
          if (!notes.some((note) => note.code === 'home-import'))
            notes.push({ level: 'attention', code: 'home-import', text: 'importa arquivo da máquina de quem usa (~/…): fica fora do repositório e da importação' })
          continue
        }
        const found = resolveCitation(cited, path, (candidate) => tree.resolve(candidate))
        if (!found) {
          cites.push(cited)
          continue
        }
        if (sources.some((source) => source.path === found)) continue
        const insideClaude = found.startsWith(ROOT) || (tree.entries().find((entry) => entry.path === found)?.aliases ?? []).some((alias) => alias.startsWith(ROOT))
        const structured = /^\.claude\/(agents|commands|skills)\//.test(found) || SETTINGS.includes(found)
        if (!insideClaude || structured || depth >= IMPORT_DEPTH) {
          cites.push(posix.relative(posix.dirname(real), found) || found)
          continue
        }
        sources.push({ path: found, role: 'import' })
        visit(found, tree.read(found)?.text ?? '', depth + 1)
      }
    }
    visit(real, text, 1)
    // O tamanho é o do conteúdo inteiro: o `CLAUDE.md` de uma linha que importa 10 KB não cabe numa rule.
    const bytes = sources.reduce((sum, source) => sum + (tree.read(source.path)?.bytes ?? 0), 0)
    notes.unshift(...memoryNotes(seenAs, bytes, posix.basename(seenAs)))

    const own = text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(?:^|\s)@[^\s`'"()<>[\]]+/g, ' ')
      .trim()
    if (!own && (sources.length > 1 || cites.length)) notes.push({ level: 'info', code: 'imports-only', text: 'só importa outros arquivos (@arquivo): o conteúdo está neles' })
    const title = memoryTitle(text) ?? (sources[1] ? memoryTitle(tree.read(sources[1].path)?.text ?? '') : undefined) ?? seenAs
    return { kind: 'rule', name: seenAs, title, sources, cites, notes }
  }

  /** `.claude/settings*.json` e `.mcp.json`: a configuração do projeto no Claude Code. Só nomes e contagens. */
  private config(tree: IRepoTree): IDetectedItem[] {
    const items: IDetectedItem[] = []
    const configItem: IDetectedItem = { kind: 'config', name: 'claude', sources: [], notes: [] }
    const notes = configItem.notes!
    const servers = new Map<string, string>()
    const permissions = { allow: 0, ask: 0, deny: 0, tools: new Set<string>() }
    const hooks = new Set<string>()
    const env = new Set<string>()

    for (const path of [...SETTINGS, MCP_JSON]) {
      const real = tree.resolve(path)
      const file = real ? tree.read(real) : undefined
      if (!real || !file || file.binary) continue
      let parsed: unknown
      try {
        parsed = parseJsonc(file.text)
      } catch {
        // ⛔ Sem a mensagem do `JSON.parse`: ela traz um trecho do arquivo.
        items.push({ kind: 'unknown', name: real, sources: [{ path: real }], notes: [{ level: 'attention', code: 'invalid-json', text: `${path}: JSON inválido` }] })
        continue
      }
      if (!isObject(parsed)) continue
      configItem.sources.push({ path: real, role: path === MCP_JSON ? 'mcp' : 'settings', shared: true, structured: true })
      if (path.endsWith('.local.json')) notes.push({ level: 'info', code: 'local-settings', text: `${path} é pessoal (normalmente fora do git)` })

      if (isObject(parsed.permissions)) {
        for (const list of ['allow', 'ask', 'deny'] as const) {
          const rules = parsed.permissions[list]
          if (!Array.isArray(rules)) continue
          for (const rule of rules) {
            if (typeof rule !== 'string') continue
            permissions[list]++
            const tool = toolOf(rule)
            if (tool) permissions.tools.add(tool)
          }
        }
        if (parsed.permissions.additionalDirectories !== undefined)
          notes.push({
            level: 'untranslatable',
            code: 'additional-directories',
            text: 'additionalDirectories: pastas da máquina de quem usa; o gateway trabalha na pasta do projeto',
          })
      }
      if (isObject(parsed.hooks)) for (const event of Object.keys(parsed.hooks)) hooks.add(event)
      if (isObject(parsed.env)) for (const name of Object.keys(parsed.env)) env.add(name)
      const mcp = isObject(parsed.mcpServers) ? Object.keys(parsed.mcpServers) : []
      const enabled = Array.isArray(parsed.enabledMcpjsonServers) ? parsed.enabledMcpjsonServers.filter((id): id is string => typeof id === 'string') : []
      for (const id of [...mcp, ...enabled]) if (!servers.has(id)) servers.set(id, real)
    }

    const total = permissions.allow + permissions.ask + permissions.deny
    if (total)
      notes.push({
        level: 'attention',
        code: 'project-permissions-pending',
        text: `permissões do Claude Code (allow ${permissions.allow}, ask ${permissions.ask}, deny ${permissions.deny}; ferramentas: ${[...permissions.tools].sort().join(', ')}): viram permissão do projeto na tradução do alcance (ainda não)`,
      })
    if (hooks.size)
      notes.push({
        level: 'untranslatable',
        code: 'claude-hooks',
        text: `hooks do Claude Code (${[...hooks].sort().join(', ')}): rodam comando na máquina de quem usa; o gateway não traduz`,
      })
    if (env.size)
      notes.push({
        level: 'attention',
        code: 'settings-env',
        text: `env define ${env.size} variável(is) (${[...env].sort().join(', ')}): não entra; segredo vai para as contas do gateway`,
      })
    if (configItem.sources.length) items.push(configItem)
    for (const [id, path] of servers)
      items.push({
        kind: 'mcp',
        name: id,
        sources: [{ path, role: 'mcp', shared: true, structured: true }],
        notes: [{ level: 'info', code: 'mcp-not-imported', text: 'MCP não entra na importação: cadastre o servidor no gateway com este id' }],
      })
    return items
  }
}

function pick(meta: Record<string, string>, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((key) => meta[key]).map((key) => [key, meta[key]]))
}

const reachPending = { level: 'attention' as const, code: 'reach-pending', text: 'tools do agente: traduzidos na etapa do alcance (ainda não)' }
