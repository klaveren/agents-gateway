import { TProtocolKind } from './Protocol.Model'

/**
 * O INVENTÁRIO de um repositório do projeto: o que a varredura achou de recurso agêntico (`.agents/`, opencode…),
 * com tamanho, citações e o estado no catálogo. Só leitura: nada daqui grava (ver `docs/integration/plano-importador.md`).
 *
 * ⚖️ O tipo é PROVÁVEL: vem das regras de nome do formato, não de um projeto. O que nenhuma regra classifica fica
 * `unknown`, e a pessoa reclassifica na tela.
 */
export type TInventoryKind = TProtocolKind | 'trigger' | 'mcp' | 'config' | 'unknown' | 'skip'

/** Existe no catálogo um item com o mesmo id? E onde. `other-project` é conflito: o id precisa mudar antes de importar. */
export type TCatalogState = 'new' | 'same-project' | 'global' | 'other-project'

export type TNoteLevel = 'info' | 'attention' | 'untranslatable'

export interface IInventoryNote {
  level: TNoteLevel
  code: string
  text: string
}

/** Um arquivo que alimenta o item. ⛔ Nunca leva o conteúdo: só o metadado. */
export interface IInventorySource {
  /** O caminho real, relativo à raiz do repositório. */
  path: string
  /** Os outros caminhos (por link) que levam ao mesmo arquivo. */
  aliases: string[]
  bytes: number
  /** ≈ tokens (`Token.Estimate`). */
  tokens: number
  sha256: string
  /** O papel do arquivo no item: `soul`, `identity`, `metadata`, `prompt`, `opencode`… */
  role?: string
  /** Arquivo GERADO: as fontes que o cabeçalho dele declara (pode ser vazio). */
  generated?: string[]
  /** O texto bateu na máscara de segredos. O conteúdo nunca sai daqui. */
  secret?: boolean
}

export interface IInventoryRef {
  /** O caminho citado, resolvido para o caminho real no repositório. */
  path: string
  /** A chave do item a que o arquivo pertence, quando pertence a um. */
  item?: string
}

export interface IInventoryItem {
  /** `<tipo>:<id>`, ou `trigger:<agente>/<id>`. */
  key: string
  kind: TInventoryKind
  /** O item pai: trigger → agente. */
  parent?: string
  /** O id proposto no gateway (slug pelo padrão do tipo, cortado no limite). */
  candidateId: string
  /** Rule: o título (a rule não tem id legível; a colisão é pelo título). */
  title?: string
  /** Os detectores que acharam o item. */
  detectors: string[]
  sources: IInventorySource[]
  /** O que as fontes citam e foi achado. */
  refs: IInventoryRef[]
  /** Citações que não acham arquivo nenhum: referência quebrada. */
  unresolved: string[]
  /** Só para os tipos que vão ao catálogo. */
  catalog?: TCatalogState
  notes: IInventoryNote[]
}

export interface IInventoryLink {
  /** O caminho do link, relativo à raiz. ⛔ O destino de um link para fora nunca aparece. */
  path: string
  reason: 'outside' | 'cycle' | 'broken'
}

export interface IImportScan {
  projectId: string
  repository: string
  head?: string
  dirty?: boolean
  scannedAt: Date
  /** Os detectores que reconheceram o repositório. */
  formats: string[]
  totals: { files: number; items: number; tokens: number; byKind: Partial<Record<TInventoryKind, number>> }
  ignored: {
    /** Pastas puladas (`node_modules`, `.git`…), por nome. */
    dirs: Record<string, number>
    /** Arquivos binários alcançados por um detector e pulados. */
    binaries: string[]
    /** Links recusados: para fora do repositório, em ciclo ou quebrados. */
    links: IInventoryLink[]
  }
  items: IInventoryItem[]
}

/** O limite do id por tipo, igual ao padrão do cadastro (`AGENT_ID_PATTERN`, `RESOURCE_ID_PATTERN`, `DOC_ID_PATTERN`…). */
export const CANDIDATE_ID_MAX: Partial<Record<TInventoryKind, number>> = {
  agent: 48,
  skill: 48,
  command: 48,
  spec: 64,
  adr: 64,
  knowledge: 64,
  trigger: 64,
  mcp: 32,
}

/** Os tipos que vão ao catálogo (e têm estado nele). */
export const CATALOG_KINDS: readonly TInventoryKind[] = ['agent', 'skill', 'command', 'spec', 'adr', 'knowledge', 'rule', 'trigger', 'mcp']
