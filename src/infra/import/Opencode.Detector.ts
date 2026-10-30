import { extractCitations, fileTokens, frontmatter, resolveCitation } from '@domain/Import.Refs'
import { IDetectedItem, IDetectedReach, IFormatDetector, IRepoTree } from '@domain/ports/FormatDetector.Port'
import { globToRegex } from '@domain/Permission.Policy'
import { under } from './AgentsDir.Detector'

const CONFIGS = ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
const AGENT_MD = /^\.opencode\/agents?\/(.+)\.md$/i
const COMMAND_MD = /^\.opencode\/commands?\/(.+)\.md$/i

/** JSONC: tira comentário (`//`, `/* *\/`) fora de string e a vírgula antes de `}`/`]`. */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    const next = text[index + 1]
    if (inString) {
      out += char
      if (char === '\\') out += text[++index] ?? ''
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++
      out += '\n'
    } else if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++
      index++
    } else out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** Quantos arquivos um glob de `instructions` expande, no máximo (o resto vira alerta). */
export const INSTRUCTIONS_GLOB_MAX = 200

/**
 * ⛔ A EXPANSÃO de um glob de `instructions` (`docs/*.md`, `.cursor/rules/**\/*.md`), relativa à pasta da configuração e
 * contida como o leitor: casa só os caminhos da árvore (reais e por link, já dentro da raiz e sem o ignorado). Padrão
 * absoluto, com `~` ou com `..` não expande.
 */
export function expandInstructions(tree: IRepoTree, configPath: string, pattern: string): { paths: string[]; refused?: string } {
  const clean = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!clean || clean.startsWith('/') || clean.startsWith('~') || /^[A-Za-z]:\//.test(clean) || clean.split('/').includes('..'))
    return { paths: [], refused: 'fora da raiz do repositório' }
  const dir = configPath.includes('/') ? configPath.slice(0, configPath.lastIndexOf('/') + 1) : ''
  const regex = globToRegex(`${dir}${clean}`)
  const paths: string[] = []
  for (const entry of tree.entries())
    for (const path of [entry.path, ...entry.aliases])
      if (regex.test(path)) {
        if (!paths.includes(entry.path)) paths.push(entry.path)
        break
      }
  return { paths: paths.sort() }
}

/** O alcance cru de um bloco: só os objetos (o resto não é alcance). */
function reachOf(raw: Record<string, unknown>): IDetectedReach | undefined {
  const reach: IDetectedReach = {
    ...(isObject(raw.permission) ? { permission: raw.permission } : {}),
    ...(isObject(raw.tools) ? { tools: raw.tools } : {}),
  }
  return reach.permission || reach.tools ? reach : undefined
}

/**
 * O formato opencode: `opencode.json` (aceita JSONC) — `agent.<id>` (descrição, modelo, `prompt` com `{file:…}`,
 * `tools`, `permission`), `command`, `mcp`, `instructions` e o `permission` global — e os markdown de
 * `.opencode/agent/` e `.opencode/command/`. O alcance (`tools`/`permission`) só é apontado: a tradução é de outro PR.
 */
export class OpencodeDetector implements IFormatDetector {
  readonly id = 'opencode'

  detects(tree: IRepoTree): boolean {
    return CONFIGS.some((path) => !!tree.resolve(path)) || tree.entries().some((entry) => under(entry, '.opencode/') !== undefined)
  }

  scan(tree: IRepoTree): IDetectedItem[] {
    const items: IDetectedItem[] = []
    for (const configPath of CONFIGS) {
      const real = tree.resolve(configPath)
      const file = real ? tree.read(real) : undefined
      if (!real || !file || file.binary) continue
      items.push(...this.config(tree, real, file.text))
    }
    for (const entry of tree.entries()) {
      for (const path of [entry.path, ...entry.aliases]) {
        const agent = AGENT_MD.exec(path)
        const command = COMMAND_MD.exec(path)
        if (!agent && !command) continue
        const meta = frontmatter(tree.read(entry.path)?.text ?? '')
        const fields = Object.fromEntries(['model', 'description'].filter((key) => meta[key]).map((key) => [key, meta[key]]))
        if (agent)
          items.push({
            kind: 'agent',
            name: agent[1],
            sources: [{ path: entry.path, role: 'prompt' }],
            fields,
            notes: meta.tools !== undefined || meta.permission !== undefined ? [reachFrontmatter] : [],
          })
        else
          items.push({
            kind: 'command',
            name: command![1],
            sources: [{ path: entry.path, role: 'command' }],
            fields,
            notes: meta.agent ? [commandAgent(meta.agent)] : [],
          })
        break
      }
    }
    return items
  }

  private config(tree: IRepoTree, path: string, body: string): IDetectedItem[] {
    let config: unknown
    try {
      config = parseJsonc(body)
    } catch (error) {
      return [{ kind: 'unknown', name: path, sources: [{ path }], notes: [{ level: 'attention', code: 'invalid-json', text: `JSON inválido: ${(error as Error).message}` }] }]
    }
    if (!isObject(config)) return []
    const shared = (role: string) => ({ path, role, shared: true })
    const items: IDetectedItem[] = []

    const configItem: IDetectedItem = { kind: 'config', name: 'opencode', sources: [{ path, role: 'opencode' }], cites: [], instructions: [], notes: [] }
    const instructions = Array.isArray(config.instructions) ? config.instructions.filter((entry): entry is string => typeof entry === 'string') : []
    for (const entry of instructions) {
      if (!/[*?[]/.test(entry)) {
        configItem.cites!.push(entry)
        configItem.instructions!.push(entry)
        continue
      }
      const { paths, refused } = expandInstructions(tree, path, entry)
      if (refused) configItem.notes!.push({ level: 'attention', code: 'instructions-outside', text: `instructions ${entry}: ${refused}, não expandido` })
      else if (!paths.length) configItem.notes!.push({ level: 'attention', code: 'instructions-glob-empty', text: `instructions ${entry}: o glob não casa arquivo nenhum` })
      else {
        // O caminho expandido é relativo à raiz: a citação resolve pela raiz (o `/` no começo).
        const found = paths.slice(0, INSTRUCTIONS_GLOB_MAX).map((one) => `/${one}`)
        configItem.cites!.push(...found)
        configItem.instructions!.push(...found)
        configItem.notes!.push({
          level: paths.length > INSTRUCTIONS_GLOB_MAX ? 'attention' : 'info',
          code: 'instructions-glob',
          text: `instructions ${entry}: ${paths.length} arquivo(s)${paths.length > INSTRUCTIONS_GLOB_MAX ? `, só os ${INSTRUCTIONS_GLOB_MAX} primeiros entram` : ''}`,
        })
      }
    }
    if (isObject(config.permission)) {
      configItem.reach = { permission: config.permission }
      configItem.notes!.push({ level: 'attention', code: 'project-permissions', text: 'permission global: vira permissão do projeto no lote, por último e confirmada' })
    }
    items.push(configItem)

    if (isObject(config.agent))
      for (const [id, raw] of Object.entries(config.agent)) {
        if (!isObject(raw)) continue
        const prompt = text(raw.prompt)
        const sources: IDetectedItem['sources'] = [shared('opencode')]
        const cites: string[] = []
        // O `{file:…}` é o prompt do agente: vira fonte (e é o que liga o bloco à pasta do agente).
        const files = prompt ? fileTokens(prompt) : []
        for (const cited of files) {
          const found = resolveCitation(cited, path, (candidate) => tree.resolve(candidate))
          if (found) sources.push({ path: found, role: 'prompt' })
          else cites.push(cited)
        }
        if (prompt) cites.push(...extractCitations(prompt).filter((cited) => !files.includes(cited)))
        const fields = Object.fromEntries(
          (['model', 'description'] as const).flatMap((key) => {
            const value = text(raw[key])
            return value ? [[key, value]] : []
          }),
        )
        const reach = reachOf(raw)
        items.push({
          kind: 'agent',
          name: id,
          sources,
          cites,
          fields,
          notes: reach ? [reachInBatch] : [],
          // Sem alcance próprio também: o lote precisa do nome do bloco (o agente cai no global).
          reach: reach ?? {},
        })
      }

    if (isObject(config.command))
      for (const [id, raw] of Object.entries(config.command)) {
        if (!isObject(raw)) continue
        const template = text(raw.template) ?? ''
        const description = text(raw.description)
        items.push({
          kind: 'command',
          name: id,
          sources: [shared('opencode')],
          cites: extractCitations(template),
          ...(description ? { fields: { description } } : {}),
          notes: text(raw.agent) ? [commandAgent(text(raw.agent)!)] : [],
        })
      }

    if (isObject(config.mcp))
      for (const id of Object.keys(config.mcp))
        items.push({
          kind: 'mcp',
          name: id,
          sources: [shared('opencode')],
          notes: [{ level: 'info', code: 'mcp-not-imported', text: 'MCP não entra na importação: cadastre o servidor no gateway com este id' }],
        })
    return items
  }
}

const reachInBatch = { level: 'info' as const, code: 'reach', text: 'tools/permission do agente: traduzidos no lote (Montar lote), por último e confirmados' }
const reachFrontmatter = { level: 'attention' as const, code: 'reach-pending', text: 'tools/permission no frontmatter: ainda não traduzidos (traduza na tela)' }
const commandAgent = (agent: string) => ({
  level: 'untranslatable' as const,
  code: 'command-agent',
  text: `o command escolhe o agente (agent: ${agent}); o gateway não tem esse campo`,
})
