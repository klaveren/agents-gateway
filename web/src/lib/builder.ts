import { ref } from 'vue'
import type { ITurn, TResourceKind } from './types'

/**
 * O CONSTRUTOR (agente do core, só de admin): uma conversa guiada que segue o protocolo e entrega o rascunho com a
 * ferramenta `propose_draft`. O rascunho mora nos ARGUMENTOS da chamada gravada no turno — a tela o lê de lá e a
 * pessoa salva pelo editor de sempre. Nada é gravado pelo construtor.
 */
export const PROPOSE_DRAFT_TOOL = 'propose_draft'

/** O id do construtor de um tipo (no gateway, `Builder.Agents`). */
export function builderAgentId(kind: TResourceKind): string {
  return `builder-${kind}`
}

const CORE_AGENT_NAMES: Record<string, string> = { 'builder-skill': 'Construtor de skills', 'builder-command': 'Construtor de commands' }

/** O nome de um agente do core (fora da lista de agentes), ou nada. */
export function coreAgentName(agentId: string | undefined): string | undefined {
  return agentId ? CORE_AGENT_NAMES[agentId] : undefined
}

export interface IBuilderDraft {
  id: string
  description: string
  body: string
  docIds: string[]
  global: boolean
}

/**
 * O rascunho em vigor: o da ÚLTIMA chamada a `propose_draft` que deu certo. ⚠️ A que voltou com problemas não conta —
 * o construtor corrige e chama de novo. Os argumentos chegam como objeto ou como JSON em texto, conforme a lane.
 */
export function latestDraft(turns: readonly ITurn[]): IBuilderDraft | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const calls = turns[index].toolCalls ?? []
    for (let position = calls.length - 1; position >= 0; position -= 1) {
      const call = calls[position]
      if (!call.tool.endsWith(PROPOSE_DRAFT_TOOL) || call.error) continue
      if (typeof call.result === 'string' && /^The draft has problems/.test(call.result)) continue
      const draft = draftOf(call.args)
      if (draft) return draft
    }
  }
  return undefined
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
  if (typeof value.id !== 'string' || typeof value.body !== 'string') return undefined
  return {
    id: value.id.trim(),
    description: typeof value.description === 'string' ? value.description.trim() : '',
    body: value.body,
    docIds: Array.isArray(value.docIds) ? value.docIds.filter((id): id is string => typeof id === 'string') : [],
    global: value.global === true,
  }
}

/**
 * O rascunho a caminho do editor: o "Abrir no editor" o deixa aqui e navega; a página de Skills/Commands o aplica ao
 * formulário (sem salvar) e o consome. `projectId` é o da conversa do construtor (ausente = global).
 */
export const pendingDraft = ref<(IBuilderDraft & { kind: TResourceKind; projectId?: string }) | undefined>()
