import { isImportBuilder, LIST_IMPORT_ITEMS_TOOL, PROPOSE_IMPORT_DRAFT_TOOL, READ_IMPORT_SOURCE_TOOL } from '@domain/Builder.Agents'
import type { IImportDraft } from '@domain/Import.Draft'
import type { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { ILocalTool, IToolResult } from './Tool.Types'

/** Quem atende as ferramentas do modo importação (o `ImportBuildService`). Erro com `issues` = os problemas, campo a campo. */
export interface IImportDesk {
  listText(conversationId: string): string
  readSource(conversationId: string, key: string, options: { path?: string; offset?: number; limit?: number }): string
  propose(conversationId: string, key: string, meta: unknown, ops: unknown): { draft: IImportDraft }
}

/** ⛔ Só o construtor em modo importação, e só dentro de uma conversa: o resto responde como se a ferramenta não existisse. */
function refusal(name: string, context: IExecutionContext | undefined): IToolResult | undefined {
  if (!isImportBuilder(context?.agentId)) return { status: 'error', result: `${name} is only for the import builder.` }
  if (!context?.sessionId) return { status: 'error', result: `${name} only works inside a conversation.` }
  return undefined
}

function failure(error: unknown): IToolResult {
  const issues = (error as { issues?: Array<{ field: string; message: string }> }).issues
  const message = error instanceof Error ? error.message : String(error)
  if (issues?.length) return { status: 'error', result: `${message} — fix and call again:\n${issues.map((issue) => `- ${issue.field}: ${issue.message}`).join('\n')}` }
  return { status: 'error', result: message }
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
const integer = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined)

/**
 * As ferramentas do CONSTRUTOR EM MODO IMPORTAÇÃO (`docs/integration/plano-importador.md`, PR 7). Os itens são os que a
 * conversa recebeu ao abrir (pelo Importador); nenhuma delas grava no catálogo.
 * - `list_import_items`: os itens, as fontes, o que citam com o mapa de ids e o pedido de ajuste;
 * - `read_import_source`: uma fonte lida PELO SERVIDOR, contida, mascarada, em páginas, conferindo o `sha256`;
 * - `propose_import_draft`: os metadados e as operações; o servidor aplica, confere e grava o rascunho no item (`review`).
 */
export function makeImportTools(desk: IImportDesk): ILocalTool[] {
  return [
    {
      origin: 'local',
      name: LIST_IMPORT_ITEMS_TOOL,
      description:
        'Lists the import items of this conversation: kind, proposed id, sources (path, size, flags), what each one cites with the id map (path → item → gateway id), notes, and an adjustment the person asked for.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async (_args, context) => {
        const refused = refusal(LIST_IMPORT_ITEMS_TOOL, context)
        if (refused) return refused
        try {
          return { status: 'success', result: desk.listText(context!.sessionId!) }
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      origin: 'local',
      name: READ_IMPORT_SOURCE_TOOL,
      description:
        'Reads one source of an import item (or of an item it cites), from the server: contained to the repository, secrets masked, in pages. Refuses when the file changed since the analysis. Copy excerpts for the operations exactly as shown here.',
      inputSchema: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'The item key, as list_import_items shows it.' },
          path: { type: 'string', description: 'Which source (needed when the item has more than one, or to read a cited file).' },
          offset: { type: 'number', description: 'First character (default 0).' },
          limit: { type: 'number', description: 'How many characters (default 30000, at most 60000).' },
        },
        required: ['item'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const refused = refusal(READ_IMPORT_SOURCE_TOOL, context)
        if (refused) return refused
        const key = text(args.item)
        if (!key) return { status: 'error', result: 'item: required (the item key)' }
        const path = text(args.path)
        const offset = integer(args.offset)
        const limit = integer(args.limit)
        try {
          return {
            status: 'success',
            result: desk.readSource(context!.sessionId!, key, {
              ...(path ? { path } : {}),
              ...(offset !== undefined ? { offset } : {}),
              ...(limit !== undefined ? { limit } : {}),
            }),
          }
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      origin: 'local',
      name: PROPOSE_IMPORT_DRAFT_TOOL,
      description:
        'Delivers the import draft of ONE item: metadata plus operations of fixed types over the source (setMeta, linkCitation, heading, split, remove, compose). There is no operation that writes free text into the body. The server applies them, checks the final text is exactly source + operations, saves the draft on the item and sends it to review in the Importer. Nothing goes to the catalog. Returns the problems operation by operation: fix and call again.',
      inputSchema: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'The item key.' },
          meta: {
            type: 'object',
            description:
              'Metadata as text fields — rule: title; spec/adr/knowledge: id, title, summary; skill/command: id, description; agent: id, name, description; trigger: id, when. Optional scope: project (default) or global.',
          },
          ops: {
            type: 'array',
            description:
              'Operations, applied in order. Excerpts are EXACT text from read_import_source; when an excerpt repeats, give occurrence (1..n); with several sources, give source (the path). ' +
              '{op:"linkCitation", text:"<cited path>", target:"<gateway id>", link:"attach"|"reference"|"initialContext"} · ' +
              '{op:"heading", text:"## Exact heading line", level:1..6} · ' +
              '{op:"split", text:"## Exact heading line", meta:{…the new item metadata}} · ' +
              '{op:"remove", text:"<exact excerpt>", reason:"…"} or {op:"remove", whole:true, source:"<path>", reason:"…"} · ' +
              '{op:"compose", into:"body"|"soul"|"systemPrompt", sources:["<path>", …]} · {op:"setMeta", field, value}.',
            items: { type: 'object' },
          },
        },
        required: ['item', 'ops'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const refused = refusal(PROPOSE_IMPORT_DRAFT_TOOL, context)
        if (refused) return refused
        const key = text(args.item)
        if (!key) return { status: 'error', result: 'item: required (the item key)' }
        try {
          const { draft } = desk.propose(context!.sessionId!, key, args.meta, args.ops)
          const outputs = draft.outputs.map((output) => output.meta.id ?? output.meta.title ?? '(no id)').join(', ')
          return {
            status: 'success',
            result: `Draft saved on ${key} (${draft.ops.length} operation(s), ${draft.removals.length} removal(s); item(s): ${outputs}). Nothing went to the catalog: the person reviews it in the Importer, and each removal needs their OK.`,
          }
        } catch (error) {
          return failure(error)
        }
      },
    },
  ]
}
