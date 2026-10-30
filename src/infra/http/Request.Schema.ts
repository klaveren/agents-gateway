import { z } from 'zod'
import { FALLBACK_BOUNDS, FALLBACK_MODES, TFallbackMode } from '@domain/Fallback.Policy'
import { LIMIT_BOUNDS, LIMIT_NAMES, TLimitName } from '@domain/models/Limits.Model'
import { EMode } from '@domain/enums/EMode.Enum'
import { AUDIENCES } from '@domain/models/Settings.Model'
import { PERMISSION_CATEGORIES, TPermissionCategory } from '@domain/Permission.Policy'
import { AGENT_DIAGNOSTICS_BOUNDS, AGENT_TERMINAL_BOUNDS } from '@domain/models/Agent.Model'

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
  /** Um dos providers do agente. Ausente: o primeiro que oferece o `model`, ou o padrão. */
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoning: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** O projeto em que a conversa nasce (o seletor da tela). Num agente de projeto vale o dele; num global, este, se quem abre for membro. */
  projectId: z.string().trim().max(32).optional(),
  /** O repositório do projeto (`<projeto>/repositories/<nome>`) em que o agente trabalha. Fixo na conversa. */
  repository: z.string().trim().max(100).optional(),
  /** A worktree desse repositório (o nome da pasta ou o branch). Exige `repository`. */
  worktree: z.string().trim().max(200).optional(),
  /** Para onde vai o aviso de fim de cada turno (POST assinado). Só para os hosts de `TURN_CALLBACK_HOSTS`. */
  callbackUrl: z.string().trim().url().max(500).optional(),
})

/**
 * A troca no meio da conversa: `reasoning: null` volta ao padrão; campo ausente não muda. `provider`
 * leva a conversa a outro provider do agente, com a transcrição (sem `model`, o primeiro dele).
 */
export const reconfigureSessionSchema = z
  .object({
    provider: z.string().trim().min(1).max(32).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    reasoning: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .refine((body) => body.provider !== undefined || body.model !== undefined || body.reasoning !== undefined, 'send provider, model and/or reasoning')

const fileSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().min(1),
  data: z.string().min(1).max(MAX_FILE_CHARS, 'attachment is too large'),
})

export const sendMessageSchema = z
  .object({
    message: z.string().default(''),
    files: z.array(fileSchema).max(MAX_FILES).optional(),
    /** Com o turno rodando: `queue` põe a mensagem na fila dele (202) em vez do 409. Só texto (ver `Interjection.Policy`). */
    whileBusy: z.enum(['reject', 'queue']).optional(),
  })
  .refine((body) => body.message.trim().length > 0 || (body.files?.length ?? 0) > 0, {
    message: 'send text, an attachment, or both',
    path: ['message'],
  })

/**
 * Campo opcional que aceita `null` (ou texto vazio) como pedido de voltar ao padrão.
 *
 * ⚖️ AUSENTE, VALOR e NULO são três casos, e o último é o que faz uma escolha ser desfazível — sem
 * ele a tela só consegue trocar um modelo por outro, nunca voltar ao padrão, e o `null` que ela
 * manda virava 422. Ver `mergeSettings`.
 */
const clearable = z.string().trim().nullable().optional()

/** Um passo da troca de provedor: provedor + modelo. */
const fallbackStep = z.object({ provider: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(200) })

/**
 * Alteração PARCIAL das configurações: só o que mudou vem no corpo. Exigir o objeto inteiro faria
 * qualquer alteração de um campo depender de reenviar corretamente todos os outros — e um deles
 * chegar errado apagaria uma configuração sem aviso.
 *
 * ⛔ `audience` é obrigatório no armazenamento e por isso NÃO aceita `null`: não existe padrão para
 * o qual voltar sem deixar o serviço sem regra de quem o alcança.
 */
export const updateSettingsSchema = z.object({
  audience: z.enum(AUDIENCES).optional(),
  agentId: clearable,
  provider: clearable,
  model: clearable,
  // ⚠️ Só gravados por enquanto: o classificador de turno chega numa fase posterior.
  classifierModel: clearable,
  classifierProvider: clearable,
  builderProvider: clearable,
  builderModel: clearable,
  classifyTurns: z.boolean().nullable().optional(),
  // Cada limite na faixa dele; `null` num limite volta ao `.env`, e `null` no objeto volta todos.
  limits: z
    .object(
      Object.fromEntries(LIMIT_NAMES.map((name) => [name, z.number().int().min(LIMIT_BOUNDS[name].min).max(LIMIT_BOUNDS[name].max).nullable().optional()])) as Record<
        TLimitName,
        z.ZodOptional<z.ZodNullable<z.ZodNumber>>
      >,
    )
    .strict()
    .nullable()
    .optional(),
  /** A cadeia global da troca de provedor; `null` desliga. */
  fallback: z
    .object({
      chain: z.array(fallbackStep).max(FALLBACK_BOUNDS.chain),
      cooldownMinutes: z.number().int().min(FALLBACK_BOUNDS.cooldownMinutes.min).max(FALLBACK_BOUNDS.cooldownMinutes.max).optional(),
    })
    .nullable()
    .optional(),
})

/**
 * Um agente criado pela tela — a FORMA. O que faz sentido (modelo do provider, tool disponível, id
 * livre) é regra do domínio (`agentIssues`), que devolve todos os problemas de uma vez.
 *
 * ⚖️ `id` vem do corpo na criação e do caminho na atualização: renomear o id seria outro agente, e
 * as conversas gravadas apontam para o antigo.
 */
export const agentBodySchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200),
  /**
   * Onde o agente roda — o primeiro é o padrão. O id de cada um é de um provider configurado; se ele
   * existe, quem diz é a regra (`protocolOf`), com o resto.
   */
  providers: z
    .array(
      z.object({
        provider: z.string().trim().min(1).max(32),
        models: z.array(z.string().trim().min(1)).min(1).max(20),
        /** Só nos protocolos que têm sandbox (`SANDBOX_LEVELS`); quem confere é a regra do agente. */
        sandbox: z.enum(['read-only', 'workspace-write', 'full']).optional(),
        network: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(10),
  systemPrompt: z.string().min(1),
  soul: z.string().max(20_000).optional(),
  reasoningEfforts: z.array(z.string().trim().min(1)).max(10).optional(),
  modes: z.array(z.enum(EMode)).min(1),
  allowedTools: z.array(z.string().trim().min(1)).max(100).default([]),
  /** `subagent`: só chamado por outro agente; `null` volta a agente normal. */
  role: z.enum(['subagent']).nullable().optional(),
  /** Só administrador conversa com o agente. Decisão de quem o cria; ausente ou `false` = aberto a todos. */
  adminOnly: z.boolean().optional(),
  /** O projeto do agente. Ausente (ou `null`) = global, em todos os projetos. */
  projectId: z.string().trim().max(32).nullable().optional(),
  /** As regras de permissão do agente (ver `Permission.Policy`). Ausente na edição = mantém as que ele tem. */
  permissions: z
    .array(
      z.object({
        category: z.enum(PERMISSION_CATEGORIES as [TPermissionCategory, ...TPermissionCategory[]]),
        pattern: z.string().trim().min(1).max(300),
        decision: z.enum(['allow', 'deny']),
        note: z.string().max(200).optional(),
      }),
    )
    .max(300)
    .optional(),
  /** A troca de provedor deste agente (ver `Fallback.Policy`). Ausente na edição = mantém; `null` volta à global. */
  fallback: z
    .object({ mode: z.enum(FALLBACK_MODES as [TFallbackMode, ...TFallbackMode[]]), chain: z.array(fallbackStep).max(FALLBACK_BOUNDS.chain).optional() })
    .nullable()
    .optional(),
  /** O terminal deste agente (tempo por comando e saída). Ausente na edição = mantém o que ele tem; `null` volta ao global. */
  terminal: z
    .object({
      timeoutSeconds: z.number().int().min(AGENT_TERMINAL_BOUNDS.timeoutSeconds.min).max(AGENT_TERMINAL_BOUNDS.timeoutSeconds.max).optional(),
      maxOutputChars: z.number().int().min(AGENT_TERMINAL_BOUNDS.maxOutputChars.min).max(AGENT_TERMINAL_BOUNDS.maxOutputChars.max).optional(),
    })
    .nullable()
    .optional(),
  /** O diagnóstico depois de editar. Ausente na edição = mantém; `null` desliga. */
  diagnostics: z
    .object({
      typecheck: z.boolean().optional(),
      lint: z.boolean().optional(),
      format: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(AGENT_DIAGNOSTICS_BOUNDS.timeoutSeconds.min).max(AGENT_DIAGNOSTICS_BOUNDS.timeoutSeconds.max).optional(),
    })
    .nullable()
    .optional(),
})

/**
 * Contas. ⚠️ A senha só tem teto aqui (o hash custa CPU por caractere); o mínimo é regra do domínio
 * (`passwordIssue`), que devolve o problema campo a campo junto dos outros.
 */
const password = z.string().max(500)
export const setupSchema = z.object({ email: z.string().max(200), name: z.string().max(200), password, code: z.string().max(100).optional() })
export const loginSchema = z.object({ email: z.string().max(200), password })
export const createUserSchema = z.object({ email: z.string().max(200), name: z.string().max(200), password, role: z.enum(['admin', 'member']).default('member') })
export const updateUserSchema = z.object({ name: z.string().max(200).optional(), role: z.enum(['admin', 'member']).optional(), disabled: z.boolean().optional() })
export const resetPasswordSchema = z.object({ password })
export const changePasswordSchema = z.object({ current: password, password })

/** Abrir ou fechar a conversa por link. Booleano estrito: `"false"` (texto) não pode abrir. */
export const createAccessTokenSchema = z.object({ name: z.string().max(200), expiresInDays: z.number().int().optional() })
export const shareConversationSchema = z.object({ shared: z.boolean() })

/** Qual conversa o stream da caixa de entrada acompanha ao vivo; `null` para. */
export const followTurnSchema = z.object({ sessionId: z.string().min(1).max(200).nullable() })

export type TCreateSessionBody = z.infer<typeof createSessionSchema>
export type TSendMessageBody = z.infer<typeof sendMessageSchema>
export type TUpdateSettingsBody = z.infer<typeof updateSettingsSchema>
export type TAgentBody = z.infer<typeof agentBodySchema>
export type TShareConversationBody = z.infer<typeof shareConversationSchema>
