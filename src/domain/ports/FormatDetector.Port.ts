import { IInventoryLink, IInventoryNote, TInventoryKind } from '@domain/models/ImportInventory.Model'

/** Um arquivo da árvore, sem conteúdo: o caminho real e os caminhos (por link) que levam a ele. */
export interface IRepoEntry {
  /** O caminho real, relativo à raiz, com `/`. */
  path: string
  /** Os outros caminhos que chegam ao mesmo arquivo por link (dentro do repositório). */
  aliases: string[]
  bytes: number
}

/** Um arquivo lido. ⛔ `text` já vem MASCARADO: o conteúdo cru não sai do leitor. */
export interface IRepoFile extends IRepoEntry {
  sha256: string
  tokens: number
  /** Byte nulo nos primeiros 8 KB: não tem texto. */
  binary: boolean
  /** O texto mascarado (vazio no binário). */
  text: string
  /** Cabeçalho de gerado: as fontes que ele declara. */
  generated?: string[]
  /** O texto bateu na máscara. */
  secret: boolean
}

/**
 * A ÁRVORE de um repositório, já contida: só arquivos dentro da raiz, link para fora recusado, pastas de dependência e
 * build ignoradas. O conteúdo é lido sob demanda (e guardado), para o detector não pagar pelo repositório inteiro.
 */
export interface IRepoTree {
  head?: string
  dirty?: boolean
  entries(): readonly IRepoEntry[]
  /** O caminho real de um caminho (real ou por link), ou `undefined` se não está na árvore. */
  resolve(path: string): string | undefined
  /** O arquivo lido (pelo caminho real ou por link). */
  read(path: string): IRepoFile | undefined
  ignoredDirs(): Record<string, number>
  refusedLinks(): readonly IInventoryLink[]
}

/** O que um detector acha: o item ainda cru. A junção, as citações, o id e o estado no catálogo vêm depois. */
export interface IDetectedItem {
  kind: TInventoryKind
  /** O nome de origem (vira o id candidato). Trigger: o nome do trigger; o agente vai em `parent`. */
  name: string
  /** Trigger: o nome do agente. */
  parent?: string
  title?: string
  /** `shared`: a fonte é de vários itens (o `opencode.json`), e não liga um item ao outro na junção. */
  sources: Array<{ path: string; role?: string; shared?: boolean }>
  /** Caminhos citados pela ESTRUTURA (o `{file:…}` do opencode, o `instructions`), além dos do texto. Relativos à primeira fonte. */
  cites?: string[]
  /** Campos que dois detectores podem dizer de jeitos diferentes (`model`, `description`): divergência vira alerta. */
  fields?: Record<string, string>
  notes?: IInventoryNote[]
}

/** Um FORMATO de repositório agêntico (`.agents/`, opencode, `.claude/`, `AGENTS.md`). Puro sobre a árvore. */
export interface IFormatDetector {
  id: string
  detects(tree: IRepoTree): boolean
  scan(tree: IRepoTree): IDetectedItem[]
}
