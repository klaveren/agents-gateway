import { randomBytes } from 'node:crypto'
import { DELIVERED_FILE_MAX_BYTES, DELIVERED_FILES_PER_CONVERSATION, deliveredNote, fileName, IConversationFile } from '@domain/models/ConversationFile.Model'
import type { IProviderConnection } from '@domain/models/Provider.Model'
import { GENERATE_IMAGE_TOOL } from '@domain/models/Image.Model'
import { generateImage, IMAGE_SIZES, type TImageSize } from '@infra/images/Image.Generator'
import type { IFileDeliveries } from './File.Tools'
import type { ILocalTool, IToolResult } from './Tool.Types'

const PROMPT_MAX = 4000

/** O modelo de imagem configurado, lido a cada chamada (trocar nas Configurações vale na hora). */
export interface IImageSetup {
  /** `undefined` = nenhum configurado; `string` = o motivo de não servir (provider desligado, sem chave). */
  current(): Promise<{ connection: IProviderConnection; model: string } | string | undefined>
  /** 🔐 O projeto da conversa pode usar este modelo (ver `ModelAccess.Policy`)? */
  allows?(projectId: string | undefined, provider: string, model: string): boolean
}

const fail = (result: string): IToolResult => ({ status: 'error', result })

/**
 * 🖼️ `generate_image`: o agente descreve a imagem e o gateway a gera com o MODELO DE IMAGEM das Configurações (qualquer que
 * seja o modelo da conversa — o Claude não gera imagem) e a entrega na conversa, como o `deliver_file`.
 */
export function generateImageTool(deliveries: IFileDeliveries, setup: IImageSetup, generate: typeof generateImage = generateImage): ILocalTool {
  return {
    origin: 'local',
    name: GENERATE_IMAGE_TOOL,
    description:
      'Generates an image from a description and hands it to the person in the chat (a download button). Describe the subject, style, colors and composition in detail; text inside images often comes out wrong, so avoid it. Sizes: 1024x1024 (default), 1536x1024 (landscape), 1024x1536 (portrait).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the image shows, in detail' },
        name: { type: 'string', description: 'The file name, without extension' },
        size: { type: 'string', enum: [...IMAGE_SIZES] },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      const sessionId = context?.sessionId
      if (!sessionId) return fail(`${GENERATE_IMAGE_TOOL} only works inside a conversation.`)
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (!prompt) return fail('prompt is required.')
      if (prompt.length > PROMPT_MAX) return fail(`prompt is longer than ${PROMPT_MAX} characters.`)
      const size = (IMAGE_SIZES as readonly string[]).includes(String(args.size)) ? (args.size as TImageSize) : '1024x1024'
      const configured = await setup.current()
      if (!configured) return fail('No image model is configured: ask an administrator to choose one in System → Settings → Image model.')
      if (typeof configured === 'string') return fail(`The image model cannot run now: ${configured}`)
      const project = context?.conversationProjectId ?? context?.projectId
      if (setup.allows && !setup.allows(project, configured.connection.providerId, configured.model))
        return fail(`The image model (${configured.connection.providerId}/${configured.model}) is not released to this project.`)
      try {
        if ((await deliveries.files(sessionId)).length >= DELIVERED_FILES_PER_CONVERSATION)
          return fail(`this conversation already has ${DELIVERED_FILES_PER_CONVERSATION} delivered files`)
        const image = await generate(configured.connection, configured.model, prompt, size)
        if (image.data.length > DELIVERED_FILE_MAX_BYTES) return fail('the image is larger than 20 MB')
        const extension = image.mime === 'image/jpeg' ? 'jpg' : image.mime === 'image/webp' ? 'webp' : 'png'
        const base = typeof args.name === 'string' && args.name.trim() ? args.name.trim().replace(/\.(png|jpe?g|webp)$/i, '') : 'imagem'
        const name = fileName(`${base}.${extension}`)
        const turn = deliveries.turnOf?.(sessionId)
        const file: IConversationFile = {
          id: `f_${randomBytes(9).toString('hex')}`,
          conversationId: sessionId,
          name,
          mime: image.mime,
          size: image.data.length,
          ...(turn !== undefined ? { turn } : {}),
          ...(context?.agentId ? { agentId: context.agentId } : {}),
          createdAt: new Date(),
        }
        await deliveries.saveFile(file, image.data)
        return { status: 'success', result: deliveredNote(file) }
      } catch (error: unknown) {
        return fail(`Could not generate the image: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
