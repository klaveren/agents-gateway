import { DELIVER_FILE_TOOL } from './models/ConversationFile.Model'
import { PANEL_TOOL } from './models/ConversationPanel.Model'
import { LEDGER_TOOLS } from './models/Ledger.Model'
import { READ_DOC_TOOL, SEARCH_DOCS_TOOL } from './models/ProjectDoc.Model'
import { SEARCH_RESOURCES_TOOL, USE_RESOURCE_TOOL } from './models/Resource.Model'

/**
 * ⚖️ AS FERRAMENTAS QUE O GATEWAY LIGA SOZINHO: a memória (ledger), o painel e a entrega de arquivo em todo agente; os documentos e os recursos
 * quando ele tem o que ler. Ligadas por padrão — e quem administra DESLIGA uma no cadastro com `off:<ferramenta>` em
 * `allowedTools` (uma marca, não uma ferramenta). Na mesma lista de sempre: vale no patch, no histórico, no import e
 * no export sem campo novo.
 */
export const AUTO_TOOLS: readonly string[] = [...LEDGER_TOOLS, PANEL_TOOL, DELIVER_FILE_TOOL, READ_DOC_TOOL, SEARCH_DOCS_TOOL, USE_RESOURCE_TOOL, SEARCH_RESOURCES_TOOL]

export const AUTO_TOOL_OFF = 'off:'

export const isAutoToolOff = (entry: string): boolean => entry.startsWith(AUTO_TOOL_OFF)

/** A ferramenta automática está desligada neste agente? */
export const autoToolOff = (allowed: readonly string[], tool: string): boolean => allowed.includes(`${AUTO_TOOL_OFF}${tool}`)

/** As escolhas sem as marcas de desligado: o que segue para quem resolve ferramentas. */
export const withoutOffMarks = (allowed: readonly string[]): string[] => allowed.filter((entry) => !isAutoToolOff(entry))
