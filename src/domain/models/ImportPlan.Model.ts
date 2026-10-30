import { IReachLine, IReachTranslation, IReachWidening } from '../Import.Permissions'
import { IInventoryNote, TCatalogState, TInventoryKind } from './ImportInventory.Model'

/**
 * O LOTE de importação de um agente: o fecho (o que ele precisa), a ordem por fase, o mapa de ids, o alcance traduzido
 * e a estimativa de custo. ⛔ Só leitura: montar o lote não grava, não chama modelo e não dispara construtor (ver
 * `docs/integration/plano-importador.md`, §3 e §4). O dono opera a importação item a item; o lote só mostra.
 */

/** As fases da ordem (§3): as de 1 a 4 têm conversa de construtor; de 5 a 7 são vínculos e permissões, confirmados. */
export type TPlanPhase = 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface IPlanPhaseInfo {
  phase: TPlanPhase
  label: string
  /** Quantos passos com conversa de construtor a fase tem (5 a 7: nenhum). */
  steps: number
}

/** Por que o item entrou no lote. */
export type TPlanWhy = 'agent' | 'trigger' | 'cited' | 'instructions'

/** O estado do id proposto: `conflict` e `duplicate` BLOQUEIAM (o id precisa mudar antes de transformar). */
export type TPlanIdState = 'new' | 'update' | 'conflict' | 'duplicate'

export interface IPlanIdEntry {
  key: string
  kind: TInventoryKind
  /** O id da origem (o candidato da varredura, sem prefixo). */
  sourceId: string
  /** O id proposto no gateway (com o prefixo, quando o tipo leva). */
  id: string
  /** Rule: o título (a rule não tem id legível). */
  title?: string
  /** Trigger: o id proposto do agente dono. */
  parent?: string
  prefixed: boolean
  /** O prefixo estourou o limite do tipo e o id foi cortado. */
  cut: boolean
  catalog?: TCatalogState
  state: TPlanIdState
  reason?: string
}

/** Um passo com conversa de construtor (fases 1 a 4), na ordem em que o lote o faria. */
export interface IPlanStep {
  phase: TPlanPhase
  key: string
  kind: TInventoryKind
  /** O id proposto (o do mapa). */
  id: string
  title?: string
  why: TPlanWhy
  /** Os itens do lote que o trouxeram (quem o cita). */
  citedBy: string[]
  /** Os itens do lote que ele cita e vêm ANTES (a ordem garante). */
  dependsOn: string[]
  /** Os itens do lote que ele cita e só vêm DEPOIS (fase posterior ou ciclo): citados pelo id do mapa. */
  forward: string[]
  /** ≈ tokens de entrada da conversa: as fontes lidas e o protocolo do construtor. */
  tokens: { sources: number; protocol: number }
  state: TPlanIdState
  /** As notas do inventário que pedem atenção (alerta e "não traduz"). */
  notes: IInventoryNote[]
}

/**
 * Um ciclo de citações DENTRO de uma fase. Nunca trava: o primeiro pela ordem (tipo e chave) entra antes e cita os
 * outros pelo id do mapa. A citação para uma fase posterior não é ciclo: a fase resolve (fica em `forward`).
 */
export interface IPlanCycle {
  keys: string[]
  brokenBy: 'order'
  text: string
}

/** O que fica de fora do lote, e por quê. */
export interface IPlanExclusion {
  /** O item que cita (ou que tem a nota). */
  from: string
  reason: 'broken' | 'no-item' | 'other-agent' | 'unclassified' | 'out-of-catalog' | 'config' | 'untranslatable'
  /** O caminho citado, quando é citação. */
  path?: string
  /** O item citado, quando há. */
  item?: string
  code?: string
  text: string
}

/** Uma skill que a permissão do agente libera e que ele não cita: fica FORA do lote (liberar não é usar). */
export interface IPlanReleased {
  key: string
  id: string
  tokens: number
  catalog?: TCatalogState
}

/** Um servidor MCP que o agente usa. MCP não entra no v1: cadastre no gateway com o id esperado. */
export interface IPlanMcp {
  name: string
  key?: string
  id: string
  exists: boolean
}

/** Fase 5: um vínculo de delegação. Só depois de o alvo existir; ciclo A↔B não trava. */
export interface IPlanLink {
  /** O nome do alvo na origem. */
  name: string
  key?: string
  /** O id proposto do alvo (com o prefixo). */
  id: string
  state: 'exists' | 'pending' | 'unknown'
  /** O alvo também delega a este agente. */
  cycle: boolean
  text: string
}

/** A lista de skills proposta para o agente (`resources.skills`): o que ele libera, nunca `*` sem confirmação. */
export interface IPlanSkills {
  proposed: string[]
  /** `agent-rules`: as skills que as regras do próprio agente liberam; `cited`: sem regra de skill, as que ele cita. */
  from: 'agent-rules' | 'cited'
  /** Citadas no lote mas que a permissão do agente não libera: ficam fora da lista. */
  notReleased: string[]
  /** Na lista, mas fora do lote e do catálogo: pendentes até existirem. */
  pending: string[]
  note: string
}

/** Fase 6: o alcance do agente, traduzido pelo tradutor determinístico. O agente nasce fechado; isto vem depois. */
export interface IPlanReach {
  format: 'opencode'
  /** O nome do bloco na origem. */
  sourceName: string
  translation: IReachTranslation
  skills: IPlanSkills
  notes: IInventoryNote[]
}

/** Fase 7: o `permission` global da origem como permissão do projeto. A camada mais larga: por último, confirmada. */
export interface IPlanProject {
  lines: IReachLine[]
  widenings: IReachWidening[]
  notes: IInventoryNote[]
}

export interface IPlanEstimateEntry {
  conversations: number
  inputTokens: number
}

/** O custo antes de qualquer clique: uma conversa de construtor por item, e os tokens de entrada da primeira volta. */
export interface IPlanEstimate extends IPlanEstimateEntry {
  sourceTokens: number
  protocolTokens: number
  byKind: Partial<Record<TInventoryKind, IPlanEstimateEntry>>
  /** Quanto somariam as skills liberadas e fora do lote, se a pessoa as incluísse. */
  released: IPlanEstimateEntry
  note: string
}

export interface IImportPlan {
  projectId: string
  repository: string
  head?: string
  dirty?: boolean
  plannedAt: Date
  /** A chave do agente do lote. */
  agent: string
  prefix: string
  phases: IPlanPhaseInfo[]
  /** Fases 1 a 4, na ordem. */
  steps: IPlanStep[]
  links: IPlanLink[]
  reach?: IPlanReach
  project?: IPlanProject
  idMap: IPlanIdEntry[]
  excluded: IPlanExclusion[]
  released: IPlanReleased[]
  mcps: IPlanMcp[]
  cycles: IPlanCycle[]
  estimate: IPlanEstimate
  /** Por que o lote não pode seguir (id em conflito): vazio = livre. */
  blocked: string[]
  notes: IInventoryNote[]
}
