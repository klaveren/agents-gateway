/**
 * ⚖️ AS FERRAMENTAS OBSOLETAS DO GATEWAY, num lugar só: o nome que saiu, o que entra no lugar, desde quando e em que
 * versão sai de vez. É daqui que vêm o aviso ao agente (a linha do "## Ambiente" quando o prompt dele ainda cita o nome
 * antigo), o aviso na resposta do alias e a lista da API (`GET /tools/deprecated`). Antes de remover um nome, conferir
 * aqui o `removeIn` e apagar a entrada junto com o alias.
 *
 * `alias`: o nome antigo ainda funciona (com aviso). `removed`: já não existe; fica listado até `removeIn` para quem
 * procura o que aconteceu com ele.
 */
export interface IDeprecatedTool {
  name: string
  replacement: string
  /** Onde a ferramenta vive: a do agente (local) ou a do MCP do gateway (pessoa e integração). */
  scope: 'agent' | 'mcp'
  kind: 'alias' | 'removed'
  since: string
  removeIn: string
  note?: string
}

export const DEPRECATED_TOOLS: readonly IDeprecatedTool[] = [
  { name: 'conversation_panel', replacement: 'board', scope: 'agent', kind: 'alias', since: '1.0.0-alpha.12', removeIn: '1.0.0', note: 'Os mesmos argumentos.' },
  {
    name: 'delegate_to_agent',
    replacement: 'talk',
    scope: 'agent',
    kind: 'removed',
    since: '1.0.0-alpha.11',
    removeIn: '1.0.0',
    note: '`to` + `message` abre a conversa; `conversation` continua.',
  },
  { name: 'start_conversation', replacement: 'talk', scope: 'mcp', kind: 'removed', since: '1.0.0-alpha.11', removeIn: '1.0.0', note: '`to` + `message`.' },
  { name: 'send_message', replacement: 'talk', scope: 'mcp', kind: 'removed', since: '1.0.0-alpha.11', removeIn: '1.0.0', note: '`conversation` + `message`.' },
  { name: 'get_turn', replacement: 'talk', scope: 'mcp', kind: 'removed', since: '1.0.0-alpha.11', removeIn: '1.0.0', note: '`conversation` + `turn`.' },
]

/** As obsoletas de agente que um texto (o prompt do agente) ainda cita. */
export function deprecatedCitedIn(text: string | undefined): IDeprecatedTool[] {
  if (!text) return []
  return DEPRECATED_TOOLS.filter((tool) => tool.scope === 'agent' && new RegExp(`\\b${tool.name}\\b`).test(text))
}

/** A linha do "## Ambiente" para cada obsoleta citada: use o nome novo. */
export function deprecationLine(tool: IDeprecatedTool): string {
  return `- Onde o seu prompt diz \`${tool.name}\`, use \`${tool.replacement}\` — \`${tool.name}\` está obsoleta e sai na versão ${tool.removeIn}.`
}

/** O aviso que vai na resposta de um alias obsoleto. */
export function aliasWarning(tool: IDeprecatedTool): string {
  return `[deprecated] \`${tool.name}\` is an alias of \`${tool.replacement}\` and will be removed in ${tool.removeIn}: call \`${tool.replacement}\` (same arguments).`
}

export const deprecatedTool = (name: string): IDeprecatedTool | undefined => DEPRECATED_TOOLS.find((tool) => tool.name === name)
