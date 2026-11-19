import { randomBytes } from 'node:crypto'
import { DELIVERED_FILE_MAX_BYTES, DELIVERED_FILES_PER_CONVERSATION, deliveredNote, fileName, IConversationFile, mimeOf } from '@domain/models/ConversationFile.Model'
import { DOCUMENT_FORMATS, documentIssues, IDocumentInput, RENDER_DOCUMENT_TOOL, TDocumentFormat } from '@domain/models/Document.Model'
import { IDocumentTemplate, renderDocument } from '@infra/documents/Document.Renderer'
import type { IFileDeliveries } from './File.Tools'
import type { ILocalTool, IToolResult } from './Tool.Types'

const fail = (result: string): IToolResult => ({ status: 'error', result })

/**
 * 📄 `render_document`: o agente descreve o documento e o gateway monta o arquivo (PDF, DOCX, XLSX, PPTX) e o entrega na
 * conversa, como o `deliver_file` — sem terminal, sem pacote instalado, com o modelo do projeto (cabeçalho, rodapé, cor).
 * ⛔ PDF e DOCX só a partir de Markdown (ver `Document.Model`): o agente nunca manda código ao compilador.
 */
export function renderDocumentTool(deliveries: IFileDeliveries, templateOf: (projectId: string | undefined) => IDocumentTemplate | undefined = () => undefined): ILocalTool {
  return {
    origin: 'local',
    name: RENDER_DOCUMENT_TOOL,
    description:
      'Creates a document file and hands it to the person in the chat (a download button), with the project template (header, footer, color). ' +
      'pdf and docx: write the content in Markdown (headings, lists, tables, bold, links, code). xlsx: sheets with rows (first row is the header; numbers stay numbers; a string starting with "=" is a formula). ' +
      'pptx: slides with title, text, bullets, table and speaker notes (title + subtitle make a cover slide). Use it instead of writing the file yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: [...DOCUMENT_FORMATS], description: 'The file type' },
        name: { type: 'string', description: 'The file name, without extension' },
        title: { type: 'string', description: 'The document title (pdf/docx heading; pptx cover)' },
        subtitle: { type: 'string', description: 'Below the title' },
        markdown: { type: 'string', description: 'pdf and docx: the content, in Markdown' },
        sheets: {
          type: 'array',
          description: 'xlsx: the sheets',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
              header: { type: 'boolean', description: 'First row is a header (default true)' },
            },
            required: ['name', 'rows'],
          },
        },
        slides: {
          type: 'array',
          description: 'pptx: the slides, in order',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              text: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
              table: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
              notes: { type: 'string', description: 'Speaker notes' },
            },
          },
        },
      },
      required: ['format', 'name'],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      const sessionId = context?.sessionId
      if (!sessionId) return fail(`${RENDER_DOCUMENT_TOOL} only works inside a conversation.`)
      const input = toInput(args)
      const issues = documentIssues(input)
      if (issues.length) return fail(`Could not create the document: ${issues.join('; ')}.`)
      try {
        if ((await deliveries.files(sessionId)).length >= DELIVERED_FILES_PER_CONVERSATION)
          return fail(`this conversation already has ${DELIVERED_FILES_PER_CONVERSATION} delivered files`)
        const rendered = await renderDocument(input, templateOf(context?.conversationProjectId ?? context?.projectId))
        if (rendered.data.length > DELIVERED_FILE_MAX_BYTES) return fail(`the document is larger than 20 MB (${rendered.data.length} bytes): split it`)
        const name = fileName(`${input.name.replace(/\.(pdf|docx|xlsx|pptx)$/i, '')}.${rendered.extension}`)
        const turn = deliveries.turnOf?.(sessionId)
        const file: IConversationFile = {
          id: `f_${randomBytes(9).toString('hex')}`,
          conversationId: sessionId,
          name,
          mime: mimeOf(name),
          size: rendered.data.length,
          ...(turn !== undefined ? { turn } : {}),
          ...(context?.agentId ? { agentId: context.agentId } : {}),
          createdAt: new Date(),
        }
        await deliveries.saveFile(file, rendered.data)
        return { status: 'success', result: deliveredNote(file) }
      } catch (error: unknown) {
        return fail(`Could not create the document: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    },
  }
}

function toInput(args: Record<string, unknown>): IDocumentInput {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined)
  return {
    format: String(args.format ?? '') as TDocumentFormat,
    name: typeof args.name === 'string' ? args.name : '',
    ...(text(args.title) ? { title: text(args.title) } : {}),
    ...(text(args.subtitle) ? { subtitle: text(args.subtitle) } : {}),
    ...(typeof args.markdown === 'string' ? { markdown: args.markdown } : {}),
    ...(Array.isArray(args.sheets) ? { sheets: args.sheets as IDocumentInput['sheets'] } : {}),
    ...(Array.isArray(args.slides) ? { slides: args.slides as IDocumentInput['slides'] } : {}),
  }
}
