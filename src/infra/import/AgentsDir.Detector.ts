import { posix } from 'node:path'
import { firstHeading, frontmatter } from '@domain/Import.Refs'
import { IDetectedItem, IFormatDetector, IRepoEntry, IRepoTree } from '@domain/ports/FormatDetector.Port'

/** O caminho (real ou por link) de um arquivo que começa com `prefix`, e o resto dele. */
export function under(entry: IRepoEntry, prefix: string): string | undefined {
  for (const path of [entry.path, ...entry.aliases]) if (path.startsWith(prefix)) return path.slice(prefix.length)
  return undefined
}

const ROOT = '.agents/'
const DOC = /\.(md|mdx|markdown|txt)$/i
const INDEX = /^(readme|index)\.(md|mdx|markdown|txt)$/i
/**
 * O que mora na pasta de um agente e fica fora do catálogo (memória, histórico, scripts): a pasta ou o arquivo com o
 * nome, sozinho ou como sufixo (`memory/`, `maya-ledger/`, `maya-memory.md`, `maya-evolution.md`).
 */
const OUT_OF_CATALOG = /(^|[-_.])(memory|memories|ledger|evolution|improvements|scripts|logs?|sessions|state)$/i
const ADR_DIR = /^(adrs?|adr[-_].*|decisions?)$/i
const KNOWLEDGE_DIR = /^(knowledge|research)$/i

const stripExt = (path: string) => path.replace(/\.[^./]+$/, '')

function agentRole(file: string): string {
  const name = posix.basename(file).toLowerCase()
  if (name.includes('soul')) return 'soul'
  if (name.includes('identity')) return 'identity'
  if (/\.ya?ml$/.test(name)) return 'metadata'
  if (/^(agent|prompt|system)\.(md|txt)$/.test(name)) return 'prompt'
  return 'doc'
}

/** `model:` e `description:` do nível de cima de um YAML simples. */
function yamlFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const key of ['model', 'description']) {
    const value = new RegExp(`^${key}:\\s*(.+)$`, 'm')
      .exec(text)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '')
    if (value) fields[key] = value
  }
  return fields
}

/**
 * O formato `.agents/`: `agents/<id>/` = agente (`triggers/*.md` = trigger; `*.yaml` = metadados; `soul`/`identity`;
 * memória, ledger e scripts = não importa), `skills/<id>/SKILL.md` = skill, `commands/<id>.md` = command, `specs/**` =
 * spec, pasta `adr*`/`decisions` = ADR, `knowledge`/`research` = knowledge, `rules.md` ou `rules/*.md` = rule,
 * `README.md` e índices = pula. O resto fica desconhecido. As regras são do FORMATO, não de um projeto.
 */
export class AgentsDirDetector implements IFormatDetector {
  readonly id = 'agents-dir'

  detects(tree: IRepoTree): boolean {
    return tree.entries().some((entry) => under(entry, ROOT) !== undefined)
  }

  scan(tree: IRepoTree): IDetectedItem[] {
    const agents = new Map<string, IDetectedItem>()
    const skills = new Map<string, IDetectedItem>()
    const skipped = new Map<string, IDetectedItem>()
    const items: IDetectedItem[] = []

    const skip = (dir: string, path: string, why: string) => {
      const item = skipped.get(dir) ?? { kind: 'skip' as const, name: dir, sources: [], notes: [{ level: 'info' as const, code: 'out-of-catalog', text: why }] }
      item.sources.push({ path })
      skipped.set(dir, item)
    }

    for (const entry of tree.entries()) {
      const rel = under(entry, ROOT)
      if (rel === undefined) continue
      const parts = rel.split('/')
      const base = parts[parts.length - 1]
      const dirs = parts.slice(0, -1)

      if (parts[0] === 'agents' && parts.length >= 3) {
        const agentName = parts[1]
        const agent = agents.get(agentName) ?? { kind: 'agent' as const, name: agentName, sources: [], fields: {}, notes: [] }
        agents.set(agentName, agent)
        if (parts[2] === 'triggers' && parts.length === 4 && DOC.test(base) && !INDEX.test(base)) {
          items.push({ kind: 'trigger', name: stripExt(base), parent: agentName, sources: [{ path: entry.path, role: 'trigger' }] })
          continue
        }
        if (parts.length > 3 && OUT_OF_CATALOG.test(parts[2])) {
          skip(`${ROOT}agents/${agentName}/${parts[2]}`, entry.path, 'memória, histórico e scripts do agente ficam fora do catálogo')
          continue
        }
        if (parts.length === 3 && OUT_OF_CATALOG.test(stripExt(base))) {
          skip(`${ROOT}agents/${agentName}/${base}`, entry.path, 'memória e histórico do agente ficam fora do catálogo')
          continue
        }
        if (parts[2] === 'triggers' && parts.length === 4 && INDEX.test(base)) {
          skip(`${ROOT}agents/${agentName}/triggers/${base}`, entry.path, 'índice dos triggers: pulado')
          continue
        }
        const role = agentRole(base)
        agent.sources.push({ path: entry.path, role })
        if (role === 'metadata') Object.assign(agent.fields!, yamlFields(tree.read(entry.path)?.text ?? ''))
        continue
      }
      if (parts[0] === 'agents' && parts.length === 2 && DOC.test(base) && !INDEX.test(base)) {
        items.push({ kind: 'agent', name: stripExt(base), sources: [{ path: entry.path, role: 'prompt' }] })
        continue
      }

      if (INDEX.test(base)) {
        items.push({ kind: 'skip', name: rel, sources: [{ path: entry.path }], notes: [{ level: 'info', code: 'index', text: 'índice: pulado' }] })
        continue
      }

      if (parts[0] === 'skills' && parts.length >= 3) {
        const skillName = parts[1]
        const skill = skills.get(skillName) ?? { kind: 'skill' as const, name: skillName, sources: [], notes: [] }
        skills.set(skillName, skill)
        const role = parts.length === 3 && /^skill\.md$/i.test(base) ? 'skill' : parts[2] === 'triggers' ? 'trigger' : 'attachment'
        skill.sources.push({ path: entry.path, role })
        continue
      }
      if (parts[0] === 'skills' && parts.length === 2 && DOC.test(base)) {
        items.push({ kind: 'skill', name: stripExt(base), sources: [{ path: entry.path, role: 'skill' }] })
        continue
      }

      if (parts[0] === 'commands' && parts.length >= 2 && DOC.test(base)) {
        const text = tree.read(entry.path)?.text ?? ''
        const meta = frontmatter(text)
        items.push({
          kind: 'command',
          name: stripExt(parts.slice(1).join('/')),
          sources: [{ path: entry.path, role: 'command' }],
          ...(meta.description ? { fields: { description: meta.description } } : {}),
          notes: meta.agent ? [{ level: 'untranslatable', code: 'command-agent', text: `o command escolhe o agente (agent: ${meta.agent}); o gateway não tem esse campo` }] : [],
        })
        continue
      }

      if (DOC.test(base)) {
        const adrAt = dirs.findIndex((dir) => ADR_DIR.test(dir))
        const knowledgeAt = dirs.findIndex((dir) => KNOWLEDGE_DIR.test(dir))
        if (adrAt >= 0) {
          items.push({ kind: 'adr', name: stripExt(parts.slice(adrAt + 1).join('/')), sources: [{ path: entry.path }], title: firstHeading(tree.read(entry.path)?.text ?? '') })
          continue
        }
        if (knowledgeAt >= 0) {
          items.push({ kind: 'knowledge', name: stripExt(parts.slice(knowledgeAt + 1).join('/')), sources: [{ path: entry.path }] })
          continue
        }
        if (parts[0] === 'specs' && parts.length >= 2) {
          items.push({ kind: 'spec', name: stripExt(parts.slice(1).join('/')), sources: [{ path: entry.path }] })
          continue
        }
        if ((parts.length === 1 && /^rules\.(md|mdx|markdown|txt)$/i.test(base)) || (parts[0] === 'rules' && parts.length === 2)) {
          const title = firstHeading(tree.read(entry.path)?.text ?? '') ?? stripExt(base)
          items.push({ kind: 'rule', name: title, title, sources: [{ path: entry.path }] })
          continue
        }
      }

      items.push({ kind: 'unknown', name: rel, sources: [{ path: entry.path }] })
    }

    for (const skill of skills.values()) {
      if (!skill.sources.some((source) => source.role === 'skill')) {
        for (const source of skill.sources) items.push({ kind: 'unknown', name: source.path, sources: [source] })
        continue
      }
      const triggers = skill.sources.filter((source) => source.role === 'trigger')
      if (triggers.length)
        skill.notes!.push({
          level: 'untranslatable',
          code: 'skill-triggers',
          text: `a skill tem ${triggers.length} trigger(s); o gateway não tem trigger de skill`,
        })
      items.push(skill)
    }
    return [...agents.values(), ...items, ...skipped.values()]
  }
}
