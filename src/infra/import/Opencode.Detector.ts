import { extractCitations, fileTokens, frontmatter, resolveCitation } from '@domain/Import.Refs'
import { IDetectedItem, IFormatDetector, IRepoTree } from '@domain/ports/FormatDetector.Port'
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
            notes: meta.tools !== undefined || meta.permission !== undefined ? [reachPending] : [],
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

    const configItem: IDetectedItem = { kind: 'config', name: 'opencode', sources: [{ path, role: 'opencode' }], cites: [], notes: [] }
    const instructions = Array.isArray(config.instructions) ? config.instructions.filter((entry): entry is string => typeof entry === 'string') : []
    for (const entry of instructions) {
      if (/[*?[]/.test(entry)) configItem.notes!.push({ level: 'attention', code: 'instructions-glob', text: `instructions com glob não expandido: ${entry}` })
      else configItem.cites!.push(entry)
    }
    if (config.permission !== undefined)
      configItem.notes!.push({ level: 'attention', code: 'project-permissions-pending', text: 'permission global: vira permissão do projeto na tradução do alcance (ainda não)' })
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
        items.push({
          kind: 'agent',
          name: id,
          sources,
          cites,
          fields,
          notes: raw.tools !== undefined || raw.permission !== undefined ? [reachPending] : [],
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

const reachPending = { level: 'attention' as const, code: 'reach-pending', text: 'tools/permission do agente: traduzidos na etapa do alcance (ainda não)' }
const commandAgent = (agent: string) => ({
  level: 'untranslatable' as const,
  code: 'command-agent',
  text: `o command escolhe o agente (agent: ${agent}); o gateway não tem esse campo`,
})
