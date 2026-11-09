import { computed, ref } from 'vue'

/**
 * ⚖️ A EDIÇÃO vem do servidor (`GATEWAY_EDITION`, no `/auth/status`) e não muda: a instalação nasce lite ou PRO. Uma
 * variável só, para a tela e o MCP do gateway. Só apresentação: a API não barra nada.
 */
export type TEdition = 'pro' | 'lite'

const edition = ref<TEdition>()
let settle!: () => void
const known = new Promise<void>((resolve) => (settle = resolve))

export const lite = computed(() => edition.value === 'lite')

/** Gravada uma vez, pelo `auth.scan` (sem resposta, PRO). */
export function setEdition(value: TEdition | undefined): void {
  if (edition.value) return
  edition.value = value === 'lite' ? 'lite' : 'pro'
  settle()
}

/** Resolve quando a edição chegou: o router espera antes de decidir a primeira rota. */
export function editionKnown(): Promise<void> {
  return known
}

/** As rotas da lite: o resto volta para `/`. As telas são as da PRO, sem mudança; o que a lite mostra mora aqui e no `LiteNav`. */
export const LITE_ROUTES: ReadonlySet<string> = new Set([
  'inbox',
  'conversation',
  'conversation-panel',
  'new',
  'agents',
  'agent-new',
  'agent',
  'providers',
  'provider-new',
  'provider',
  'profile',
  'usage',
  'mcp',
  'mcp-new',
  'mcp-server',
  'settings',
  'audit',
  'shared',
  'login',
  'setup',
])

/** As guias do agente que a lite esconde (ver `AgentForm`): o resto do formulário é o mesmo. */
export const LITE_HIDDEN_AGENT_TABS: ReadonlySet<string> = new Set(['triggers', 'recursos', 'arquivos', 'contexto', 'hooks', 'agendamentos'])

/** As ferramentas do gateway que a lite esconde (ver `AgentForm`): triggers, documentos e recursos, que ela não tem. */
export const LITE_HIDDEN_TOOLS: ReadonlySet<string> = new Set(['agent_trigger', 'read_doc', 'search_docs', 'use_resource', 'search_resources'])
