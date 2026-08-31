import { z } from 'zod'
import { EMode } from '@domain/enums/EMode.Enum'

/** Base64 infla ~33%, então o teto em caracteres é maior que o tamanho real do arquivo. */
const MAX_FILE_CHARS = 8 * 1024 * 1024
const MAX_FILES = 8

export const createSessionSchema = z.object({
  /**
   * ⚠️ OPCIONAL, e isto NÃO é frouxidão de validação — é o que faz a configuração existir.
   *
   * Enquanto era obrigatório, todo cliente mandava um `agentId` fixo e o `agentId` das configurações
   * nunca era alcançado: trocava-se o agente na configuração e a conversa continuava no mesmo, sem
   * nada avisar. Campo obrigatório no transporte apagando uma decisão de operação — e o tipo não
   * denuncia, porque `input.agentId ?? settings.agentId` compila perfeitamente quando o primeiro
   * nunca é `undefined`.
   */
  agentId: z.string().min(1).optional(),
  mode: z.enum(EMode).optional(),
  tools: z.boolean().optional(),
  model: z.string().min(1).optional(),
  reasoning: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const fileSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().min(1),
  data: z.string().min(1).max(MAX_FILE_CHARS, 'attachment is too large'),
})

export const sendMessageSchema = z
  .object({
    message: z.string().default(''),
    files: z.array(fileSchema).max(MAX_FILES).optional(),
  })
  .refine((body) => body.message.trim().length > 0 || (body.files?.length ?? 0) > 0, {
    message: 'send text, an attachment, or both',
    path: ['message'],
  })

export type TCreateSessionBody = z.infer<typeof createSessionSchema>
export type TSendMessageBody = z.infer<typeof sendMessageSchema>
