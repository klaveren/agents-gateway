import { ignoreMatcher, normalizeIgnore } from '@domain/Import.Ignore'
import { candidateId, extractCitations, resolveCitation } from '@domain/Import.Refs'
import {
  CATALOG_KINDS,
  IImportScan,
  IInventoryIgnored,
  IInventoryItem,
  IInventoryNote,
  IInventoryRef,
  IInventorySource,
  TCatalogState,
  TInventoryKind,
} from '@domain/models/ImportInventory.Model'
import { IDetectedItem, IFormatDetector, IRepoTree } from '@domain/ports/FormatDetector.Port'

/** O que já existe no catálogo com o mesmo id (rule: com o mesmo título; trigger: no agente `parent`). */
export interface IImportCatalogQuery {
  kind: TInventoryKind
  id: string
  projectId: string
  title?: string
  parent?: string
}

export interface IImportScanDeps {
  /** ⛔ A árvore do repositório DESTE projeto, já contida (lança quando o repositório não é dele ou não existe). */
  readTree: (projectId: string, repository: string) => IRepoTree
  detectors: readonly IFormatDetector[]
  /** O item do catálogo com o mesmo id, e de que projeto é (`projectId` ausente = global). */
  findInCatalog: (query: IImportCatalogQuery) => { projectId?: string } | undefined
  /** Os padrões de ignorar guardados no projeto (o admin define). */
  projectIgnore?: (projectId: string) => readonly string[]
  now?: () => Date
}

export interface IImportScanOptions {
  /** Padrões de ignorar só desta varredura, somados aos do projeto. */
  ignore?: readonly string[]
}

/** Os ids que dividem o mesmo espaço no gateway: um doc e um recurso são únicos entre os do seu grupo. */
const NAMESPACE: Partial<Record<TInventoryKind, string>> = { spec: 'doc', adr: 'doc', knowledge: 'doc', skill: 'resource', command: 'resource', agent: 'agent', mcp: 'mcp' }

interface IGroup {
  parts: Array<{ detector: string; item: IDetectedItem }>
}

/**
 * ⛔ A VARREDURA de um repositório do projeto: SÓ LÊ. Não grava no catálogo, não chama modelo, não persiste.
 *
 * Roda os detectores sobre a árvore contida, junta o que dois detectores acharam do mesmo item (pela chave
 * `(tipo, id)` e pelo arquivo em comum — o `{file:…}` do opencode liga o bloco à pasta do agente), mede as fontes,
 * resolve as citações e diz se o id já existe no catálogo.
 */
export class ImportScanUseCase {
  constructor(private readonly deps: IImportScanDeps) {}

  execute(projectId: string, repository: string, options: IImportScanOptions = {}): IImportScan {
    const full = this.deps.readTree(projectId, repository)
    const project = normalizeIgnore(this.deps.projectIgnore?.(projectId) ?? [])
    const request = normalizeIgnore(options.ignore ?? []).filter((pattern) => !project.includes(pattern))
    const { tree, patterns } = withIgnore(full, [
      ...project.map((pattern) => ({ pattern, origin: 'project' as const })),
      ...request.map((pattern) => ({ pattern, origin: 'request' as const })),
    ])
    const active = this.deps.detectors.filter((detector) => detector.detects(tree))
    const detected = active.flatMap((detector) => detector.scan(tree).map((item) => ({ detector: detector.id, item })))
    const groups = dropClaimedUnknowns(this.join(tree, detected))

    const binaries = new Set<string>()
    const agentKeyByName = new Map<string, string>()
    const built: Array<{ item: IInventoryItem; group: IGroup }> = []
    for (const group of groups) {
      const head = group.parts[0].item
      const item = this.build(tree, group, projectId, binaries)
      built.push({ item, group })
      if (head.kind === 'agent') for (const part of group.parts) agentKeyByName.set(part.item.name, item.key)
    }

    // O pai do trigger: o agente já juntado (o nome da pasta pode ter virado outro id na junção).
    for (const { item, group } of built) {
      const parentName = group.parts[0].item.parent
      if (item.kind !== 'trigger' || !parentName) continue
      const parentKey = agentKeyByName.get(parentName) ?? `agent:${candidateId('agent', parentName).id}`
      item.parent = parentKey
      item.key = `trigger:${parentKey.slice('agent:'.length)}/${item.candidateId}`
      item.catalog = this.catalogState({ kind: 'trigger', id: item.candidateId, projectId, parent: parentKey.slice('agent:'.length) })
    }

    const items = built.map(({ item }) => item)
    // A citação resolve na árvore inteira: arquivo ignorado e citado não é referência quebrada (só não tem item).
    this.refs(full, built)
    this.duplicates(items)
    items.sort((a, b) => a.key.localeCompare(b.key))

    const counted = new Map<string, number>()
    for (const item of items) for (const source of item.sources) counted.set(source.path, source.tokens)
    const byKind: Partial<Record<TInventoryKind, number>> = {}
    for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1

    return {
      projectId,
      repository,
      ...(tree.head ? { head: tree.head } : {}),
      ...(tree.dirty !== undefined ? { dirty: tree.dirty } : {}),
      scannedAt: (this.deps.now ?? (() => new Date()))(),
      formats: active.map((detector) => detector.id),
      totals: { files: tree.entries().length, items: items.length, tokens: [...counted.values()].reduce((sum, value) => sum + value, 0), byKind },
      ignored: { dirs: tree.ignoredDirs(), binaries: [...binaries].sort(), links: [...tree.refusedLinks()], patterns },
      items,
    }
  }

  /**
   * A JUNÇÃO: o mesmo tipo com o mesmo id, ou com um arquivo em comum (fora os divididos, como o `opencode.json`), é
   * um item só. O arquivo gerado liga também pelas fontes que declara.
   */
  private join(tree: IRepoTree, detected: Array<{ detector: string; item: IDetectedItem }>): IGroup[] {
    const parent = detected.map((_, index) => index)
    const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])))
    const union = (a: number, b: number) => {
      const [ra, rb] = [find(a), find(b)]
      // O primeiro detector (e o primeiro achado) dá o nome.
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
    }
    const byKey = new Map<string, number>()
    const byAnchor = new Map<string, number>()
    detected.forEach(({ item }, index) => {
      if (item.kind === 'unknown' || item.kind === 'skip') return
      const key = `${item.kind}:${item.parent ? `${item.parent}/` : ''}${candidateId(item.kind, item.name).id}`
      if (byKey.has(key)) union(byKey.get(key)!, index)
      else byKey.set(key, index)
      for (const anchor of this.anchors(tree, item)) {
        const at = `${item.kind}:${anchor}`
        if (byAnchor.has(at)) union(byAnchor.get(at)!, index)
        else byAnchor.set(at, index)
      }
    })
    const groups = new Map<number, IGroup>()
    detected.forEach((part, index) => {
      const root = find(index)
      const group = groups.get(root) ?? { parts: [] }
      group.parts.push(part)
      groups.set(root, group)
    })
    return [...groups.entries()].sort(([a], [b]) => a - b).map(([, group]) => group)
  }

  private anchors(tree: IRepoTree, item: IDetectedItem): string[] {
    const anchors: string[] = []
    for (const source of item.sources) {
      if (source.shared) continue
      anchors.push(source.path)
      for (const cited of tree.read(source.path)?.generated ?? []) {
        const found = resolveCitation(cited, source.path, (path) => tree.resolve(path))
        if (found) anchors.push(found)
      }
    }
    return anchors
  }

  private build(tree: IRepoTree, group: IGroup, projectId: string, binaries: Set<string>): IInventoryItem {
    const head = group.parts[0].item
    const { id, cut } = candidateId(head.kind, head.name)
    const notes: IInventoryNote[] = []
    const sources: IInventorySource[] = []
    const seen = new Set<string>()
    for (const { item } of group.parts) {
      for (const note of item.notes ?? []) if (!notes.some((known) => known.code === note.code && known.text === note.text)) notes.push(note)
      for (const source of item.sources) {
        if (seen.has(source.path)) continue
        seen.add(source.path)
        const file = tree.read(source.path)
        if (!file) continue
        if (file.binary) {
          binaries.add(file.path)
          continue
        }
        sources.push({
          path: file.path,
          aliases: file.aliases,
          bytes: file.bytes,
          tokens: file.tokens,
          sha256: file.sha256,
          ...(source.role ? { role: source.role } : {}),
          ...(file.generated ? { generated: file.generated } : {}),
          ...(file.secret ? { secret: true } : {}),
        })
      }
    }

    const names = [...new Set(group.parts.map(({ item }) => candidateId(item.kind, item.name).id))]
    if (names.length > 1) notes.push({ level: 'info', code: 'merged', text: `achado também como ${names.slice(1).join(', ')}` })
    for (const field of ['model', 'description']) {
      const values = [...new Set(group.parts.map(({ item }) => item.fields?.[field]).filter((value): value is string => !!value))]
      if (values.length > 1) notes.push({ level: 'attention', code: 'field-conflict', text: `${field} diverge entre as fontes: ${values.join(' | ')}` })
    }
    if (cut) notes.push({ level: 'attention', code: 'id-cut', text: `id cortado no limite do tipo (${head.name})` })
    for (const source of sources) {
      if (source.generated)
        notes.push({
          level: 'attention',
          code: 'generated',
          text: source.generated.length ? `${source.path} é gerado; fontes declaradas: ${source.generated.join(', ')}` : `${source.path} é gerado (o cabeçalho não diz as fontes)`,
        })
      if (source.secret) notes.push({ level: 'attention', code: 'secret', text: `${source.path} tem o que parece segredo: só a versão mascarada é lida` })
    }
    if (head.kind === 'unknown') notes.push({ level: 'attention', code: 'unclassified', text: 'nenhuma regra do formato classifica: reclassifique na tela' })

    const key = head.kind === 'unknown' || head.kind === 'skip' ? `${head.kind}:${head.name}` : `${head.kind}:${id}`
    // O trigger é conferido depois, quando o agente pai já tem o id.
    const catalog =
      CATALOG_KINDS.includes(head.kind) && head.kind !== 'trigger' ? this.catalogState({ kind: head.kind, id, projectId, ...(head.title ? { title: head.title } : {}) }) : undefined
    if (catalog === 'other-project') notes.push({ level: 'attention', code: 'id-conflict', text: `o id ${id} já existe em outro projeto: precisa mudar antes de importar` })

    return {
      key,
      kind: head.kind,
      candidateId: id,
      ...(head.kind === 'rule' && head.title ? { title: head.title } : {}),
      detectors: [...new Set(group.parts.map(({ detector }) => detector))],
      sources,
      refs: [],
      unresolved: [],
      ...(catalog ? { catalog } : {}),
      notes,
    }
  }

  private catalogState(query: IImportCatalogQuery): TCatalogState {
    const found = this.deps.findInCatalog(query)
    if (!found) return 'new'
    if (!found.projectId) return 'global'
    return found.projectId === query.projectId ? 'same-project' : 'other-project'
  }

  /** As citações: caminho citado no texto (e pela estrutura) → o arquivo achado e o item dele, ou referência quebrada. */
  private refs(tree: IRepoTree, built: Array<{ item: IInventoryItem; group: IGroup }>): void {
    const owner = new Map<string, string>()
    for (const { item, group } of built) {
      const shared = new Set(group.parts.flatMap(({ item: part }) => part.sources.filter((source) => source.shared).map((source) => source.path)))
      for (const source of item.sources) if (!shared.has(source.path) || item.kind === 'config') owner.set(source.path, item.key)
    }
    for (const { item, group } of built) {
      if (item.kind === 'skip') continue
      const own = new Set(item.sources.map((source) => source.path))
      const shared = new Set(group.parts.flatMap(({ item: part }) => part.sources.filter((source) => source.shared).map((source) => source.path)))
      const structured = new Set(group.parts.flatMap(({ item: part }) => part.sources.filter((source) => source.structured).map((source) => source.path)))
      const refs = new Map<string, IInventoryRef>()
      const unresolved = new Set<string>()
      const cite = (cited: string, from: string) => {
        const found = resolveCitation(cited, from, (path) => tree.resolve(path))
        if (!found) return unresolved.add(cited)
        if (own.has(found)) return
        const target = owner.get(found)
        refs.set(found, { path: found, ...(target && target !== item.key ? { item: target } : {}) })
      }
      for (const source of item.sources) {
        // O arquivo dividido (o `opencode.json`) é citado pela estrutura, não pelo texto inteiro.
        if ((shared.has(source.path) && item.kind !== 'config') || structured.has(source.path)) continue
        const text = tree.read(source.path)?.text ?? ''
        for (const cited of extractCitations(text)) cite(cited, source.path)
      }
      for (const { item: part } of group.parts) for (const cited of part.cites ?? []) cite(cited, part.sources[0]?.path ?? '')
      item.refs = [...refs.values()].sort((a, b) => a.path.localeCompare(b.path))
      item.unresolved = [...unresolved].sort()
      if (item.unresolved.length) item.notes.push({ level: 'attention', code: 'broken-ref', text: `referência quebrada: ${item.unresolved.join(', ')}` })
    }
  }

  /** Dois itens do mesmo espaço de ids com o mesmo id candidato: um vai sobrescrever o outro. */
  private duplicates(items: IInventoryItem[]): void {
    const byId = new Map<string, IInventoryItem[]>()
    for (const item of items) {
      const space = NAMESPACE[item.kind]
      if (!space) continue
      const key = `${space}:${item.candidateId}`
      byId.set(key, [...(byId.get(key) ?? []), item])
    }
    for (const same of byId.values())
      if (same.length > 1)
        for (const item of same)
          item.notes.push({
            level: 'attention',
            code: 'duplicate-id',
            text: `o id ${item.candidateId} é proposto também para ${same
              .filter((other) => other !== item)
              .map((other) => other.key)
              .join(', ')}`,
          })
  }
}

/**
 * A árvore SEM o que os padrões ignoram, para os detectores: o arquivo cujo caminho real (ou uma pasta acima dele) casa
 * some; o link que casa sai dos `aliases` (e não resolve), mas o arquivo segue pelo caminho real. Conta, por padrão, os
 * arquivos tirados (o primeiro padrão que casa leva a conta).
 */
function withIgnore(tree: IRepoTree, rules: ReadonlyArray<{ pattern: string; origin: IInventoryIgnored['origin'] }>): { tree: IRepoTree; patterns: IInventoryIgnored[] } {
  const patterns = rules.map((rule) => ({ ...rule, files: 0 }))
  if (!rules.length) return { tree, patterns }
  const matchers = rules.map((rule) => ignoreMatcher(rule.pattern))
  const firstMatch = (path: string) => matchers.findIndex((matcher) => matcher.matches(path))
  const hidden = new Set<string>()
  const entries = tree.entries().flatMap((entry) => {
    const at = firstMatch(entry.path)
    if (at >= 0) {
      patterns[at].files++
      hidden.add(entry.path)
      return []
    }
    return [{ ...entry, aliases: entry.aliases.filter((alias) => firstMatch(alias) < 0) }]
  })
  const resolve = (path: string) => {
    const real = tree.resolve(path)
    if (!real || hidden.has(real)) return undefined
    return real === path.replace(/^\.\//, '') || firstMatch(path) < 0 ? real : undefined
  }
  return {
    patterns,
    tree: {
      ...(tree.head ? { head: tree.head } : {}),
      ...(tree.dirty !== undefined ? { dirty: tree.dirty } : {}),
      entries: () => entries,
      resolve,
      read: (path) => {
        const file = resolve(path) ? tree.read(path) : undefined
        return file && { ...file, aliases: file.aliases.filter((alias) => firstMatch(alias) < 0) }
      },
      ignoredDirs: () => tree.ignoredDirs(),
      refusedLinks: () => tree.refusedLinks(),
    },
  }
}

/**
 * Um detector deixa `unknown` o que é da pasta dele e nenhuma regra dele classifica (o `.agents/AGENTS.md`); outro
 * detector pode classificar o mesmo arquivo (o `agents-md`). Aí o desconhecido sai: o arquivo já tem item.
 */
function dropClaimedUnknowns(groups: IGroup[]): IGroup[] {
  const claimed = new Set<string>()
  for (const group of groups)
    if (group.parts[0].item.kind !== 'unknown') for (const { item } of group.parts) for (const source of item.sources) if (!source.shared) claimed.add(source.path)
  return groups.filter((group) => {
    const head = group.parts[0].item
    return head.kind !== 'unknown' || !head.sources.length || !head.sources.every((source) => claimed.has(source.path))
  })
}

/** O que o `catalogFinder` consulta: só leitura. */
export interface ICatalogSources {
  doc: (id: string) => { projectId?: string } | undefined
  resource: (id: string) => { projectId?: string } | undefined
  rules: (scope: string | null) => ReadonlyArray<{ title: string }>
  agent: (id: string) => { projectId?: string; triggers?: ReadonlyArray<{ id: string }> } | undefined
  mcpServer: (id: string) => boolean
}

/**
 * A colisão de id, tipo a tipo: doc e recurso têm id único no gateway; a rule, que não tem id legível, colide pelo
 * título no mesmo escopo; o trigger, dentro do agente; o MCP é global.
 */
export function catalogFinder(sources: ICatalogSources): IImportScanDeps['findInCatalog'] {
  const scope = (found: { projectId?: string } | undefined) => (found ? (found.projectId ? { projectId: found.projectId } : {}) : undefined)
  return (query) => {
    switch (query.kind) {
      case 'spec':
      case 'adr':
      case 'knowledge':
        return scope(sources.doc(query.id))
      case 'skill':
      case 'command':
        return scope(sources.resource(query.id))
      case 'agent':
        return scope(sources.agent(query.id))
      case 'trigger': {
        const agent = query.parent ? sources.agent(query.parent) : undefined
        return agent?.triggers?.some((trigger) => trigger.id === query.id) ? scope(agent) : undefined
      }
      case 'rule': {
        const title = (query.title ?? query.id).trim().toLowerCase()
        if (sources.rules(query.projectId).some((rule) => rule.title.trim().toLowerCase() === title)) return { projectId: query.projectId }
        return sources.rules(null).some((rule) => rule.title.trim().toLowerCase() === title) ? {} : undefined
      }
      case 'mcp':
        return sources.mcpServer(query.id) ? {} : undefined
      default:
        return undefined
    }
  }
}
