import { ref } from 'vue'
import type { ITurn } from './types'

/**
 * O CONSTRUTOR (agente do core, só de admin): uma conversa guiada que segue o protocolo do tipo, entrega o rascunho
 * com a ferramenta `propose_draft` e — quando a pessoa confirma na conversa — grava pelo MCP do gateway. O rascunho
 * mora nos ARGUMENTOS da chamada gravada no turno; a tela o lê de lá.
 */
export const PROPOSE_DRAFT_TOOL = 'propose_draft'

export type TBuildKind = 'skill' | 'command' | 'rule' | 'spec' | 'adr'

/** O que a tela precisa de cada tipo: título, onde mora, como se fala dele. */
export const BUILD_KINDS: Readonly<Record<TBuildKind, { title: string; base: string; noun: string; article: string; builder: string }>> = {
  skill: { title: 'Skills', base: '/skills', noun: 'skill', article: 'uma skill', builder: 'Construtor de skills' },
  command: { title: 'Commands', base: '/commands', noun: 'command', article: 'um command', builder: 'Construtor de commands' },
  rule: { title: 'Rules', base: '/rules', noun: 'rule', article: 'uma rule', builder: 'Construtor de rules' },
  spec: { title: 'Specs', base: '/specs', noun: 'spec', article: 'uma spec', builder: 'Construtor de specs' },
  adr: { title: 'ADRs', base: '/adrs', noun: 'ADR', article: 'uma ADR', builder: 'Construtor de ADRs' },
}

/** As ferramentas com que o construtor grava (as do MCP do gateway que o Atlas também usa). */
const SAVE_TOOLS = ['save_rule', 'save_doc', 'save_resource']

/** O id do construtor de um tipo (no gateway, `Builder.Agents`). */
export function builderAgentId(kind: TBuildKind): string {
  return `builder-${kind}`
}

/** O nome de um agente do core (fora da lista de agentes), ou nada. */
export function coreAgentName(agentId: string | undefined): string | undefined {
  const kind = (Object.keys(BUILD_KINDS) as TBuildKind[]).find((item) => builderAgentId(item) === agentId)
  return kind ? BUILD_KINDS[kind].builder : undefined
}

/** O rascunho; os campos valem conforme o tipo (rule: título e corpo; spec/ADR: id, título, resumo e corpo). */
export interface IBuilderDraft {
  id: string
  title: string
  summary: string
  description: string
  body: string
  docIds: string[]
  global: boolean
}

/**
 * O rascunho em vigor: o da ÚLTIMA chamada a `propose_draft` que deu certo — e se ele já foi GRAVADO (um `save_*` que
 * deu certo depois dele). ⚠️ A chamada que voltou com problemas não conta: o construtor corrige e chama de novo. Os
 * argumentos chegam como objeto ou como JSON em texto, conforme a lane.
 */
export function latestDraft(turns: readonly ITurn[]): (IBuilderDraft & { saved: boolean }) | undefined {
  let current: (IBuilderDraft & { saved: boolean }) | undefined
  for (const turn of turns) {
    for (const call of turn.toolCalls ?? []) {
      if (call.error) continue
      if (call.tool.endsWith(PROPOSE_DRAFT_TOOL)) {
        if (typeof call.result === 'string' && /^The draft has problems/.test(call.result)) continue
        const draft = draftOf(call.args)
        if (draft) current = { ...draft, saved: false }
      } else if (current && SAVE_TOOLS.some((name) => call.tool.endsWith(name))) current.saved = true
    }
  }
  return current
}

function draftOf(raw: unknown): IBuilderDraft | undefined {
  let args = raw
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return undefined
    }
  }
  if (!args || typeof args !== 'object') return undefined
  const value = args as Record<string, unknown>
  if (typeof value.body !== 'string') return undefined
  const text = (field: unknown) => (typeof field === 'string' ? field.trim() : '')
  return {
    id: text(value.id),
    title: text(value.title),
    summary: text(value.summary),
    description: text(value.description),
    body: value.body,
    docIds: Array.isArray(value.docIds) ? value.docIds.filter((id): id is string => typeof id === 'string') : [],
    global: value.global === true,
  }
}

/**
 * O rascunho a caminho do editor: o "Abrir no editor" o deixa aqui e navega; a página do tipo o aplica ao formulário
 * (sem salvar) e o consome. `projectId` é o da conversa do construtor (ausente = global).
 */
export const pendingDraft = ref<(IBuilderDraft & { kind: TBuildKind; projectId?: string }) | undefined>()
