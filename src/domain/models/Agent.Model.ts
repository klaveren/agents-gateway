import type { IAgentFallback } from '@domain/Fallback.Policy'
import type { IPermissionRule } from '@domain/Permission.Policy'
import { EMode } from '../enums/EMode.Enum'
import type { TSandboxLevel } from '../Sandbox.Policy'

export interface IAgent {
  id: string
  name: string
  /**
   * Onde o agente roda: um ou mais providers, cada um com os seus modelos. O PRIMEIRO é o padrão.
   *
   * ⚖️ Vários, e não um: com API e assinatura configuradas, trocar de provider é trocar de modelo — a
   * conversa troca no meio (ver `AgentProvider.reconfigure`), sem editar o agente e voltar.
   */
  providers: IAgentTarget[]
  /**
   * QUEM o agente é: identidade, tom, valores, jeito de falar. ⚖️ Separado do `systemPrompt`, que diz O QUE
   * ele faz (função, regras): dá para ajustar a personalidade sem mexer nas regras, e vice-versa.
   */
  soul?: string
  systemPrompt: string
  /** Os níveis de raciocínio que o agente oferece. Cada provider usa os que o protocolo dele aceita. */
  reasoningEfforts?: string[]
  /** Lanes de execução suportadas por este agente. */
  modes: EMode[]
  allowedTools: string[]
  /**
   * `subagent`: só é chamado por OUTRO agente (`delegate_to_agent`, via `agent:<id>`) e nunca abre
   * conversa direta — nem pela tela, nem pela API, nem pelo MCP. Ausente = agente normal.
   */
  role?: TAgentRole
  /**
   * Só administrador provado conversa com o agente (e a delegação de uma conversa que não é de admin
   * não chega nele). ⚖️ Decisão de quem cria o agente, nunca inferida: assinatura e ferramenta que
   * alcança o servidor não fecham o agente sozinhas. Ausente = aberto a todos.
   */
  adminOnly?: boolean
  /**
   * O projeto do agente: ele só trabalha na pasta do projeto, e só os membros do projeto o veem. Ausente =
   * agente GLOBAL (o Atlas): aparece em todos os projetos.
   */
  projectId?: string
  /**
   * As regras de permissão DESTE agente (a camada do agente, ver `Permission.Policy`): o que ele pode além (ou aquém)
   * das regras do projeto. Ausente = nenhuma: valem as do projeto.
   */
  permissions?: IPermissionRule[]
  /**
   * O terminal DESTE agente: quanto tempo um comando pode levar e quanto da saída volta ao modelo. Ausente = o global
   * (Sistema → Limites). Para quem builda e roda teste (minutos, logs grandes).
   */
  terminal?: IAgentTerminal
  /**
   * O diagnóstico depois de editar (ver `Edit.Diagnostics`): o tsc, o eslint e o prettier do pacote rodam depois de cada
   * edição, e o resultado volta junto da ferramenta. Ausente = desligado.
   */
  diagnostics?: IAgentDiagnostics
  /**
   * Os triggers do agente: AÇÕES ATIVADAS SOB DEMANDA, dele e de mais ninguém. O prompt lista o id e o "quando" de cada
   * um (o índice "## Triggers"), e o corpo só entra quando o agente o carrega (`use_resource`, tipo trigger).
   */
  triggers?: IAgentTrigger[]
  /** A troca de provedor quando a cota acaba (ver `Fallback.Policy`). Ausente = a cadeia global. */
  fallback?: IAgentFallback
  /**
   * As variáveis de ambiente FIXAS do agente, em todo terminal dele (o `run_bash`, o Bash do Claude, o shell do Codex e
   * do Antigravity): a autoria do git (`GIT_AUTHOR_NAME`…), um idioma, uma região. ⛔ Nunca segredo — a regra recusa
   * nome com cara de chave (ver `envIssues`); segredo mora em Segredos e nas contas do projeto. ⚖️ O agente só
   * ACRESCENTA: o que o gateway monta (HOME, PATH, a conexão do CLI, a identidade) vence (ver `terminalEnv`).
   * Ausente = nenhuma.
   */
  env?: Record<string, string>
}

export interface IAgentTerminal {
  timeoutSeconds?: number
  maxOutputChars?: number
}

/** Um trigger: o id, quando usar (uma linha, vai no índice do prompt) e o procedimento (o corpo, carregado sob demanda). */
export interface IAgentTrigger {
  id: string
  when: string
  body: string
}

/** O id de um trigger: minúsculas, dígitos e hífen. */
export const TRIGGER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/

export interface IAgentDiagnostics {
  typecheck?: boolean
  lint?: boolean
  format?: boolean
  /** O tempo de cada ferramenta. Ausente = `DEFAULT_DIAGNOSTICS_SECONDS`. */
  timeoutSeconds?: number
}

export const AGENT_DIAGNOSTICS_BOUNDS = { timeoutSeconds: { min: 5, max: 600 } } as const
export const DEFAULT_DIAGNOSTICS_SECONDS = 60

/** Algum diagnóstico ligado. */
export function diagnosticsOn(settings: IAgentDiagnostics | undefined): settings is IAgentDiagnostics {
  return !!(settings?.typecheck || settings?.lint || settings?.format)
}

export const AGENT_TERMINAL_BOUNDS = { timeoutSeconds: { min: 1, max: 7200 }, maxOutputChars: { min: 500, max: 200_000 } } as const

/** Um provider do agente e os modelos que ele usa ali. */
export interface IAgentTarget {
  /** O id do provider configurado. Os oficiais têm id igual ao protocolo (`claude`, `openai`, `google`). */
  provider: string
  models: string[]
  /** O sandbox do cliente agêntico, nos protocolos que o têm (`SANDBOX_LEVELS`). Ausente = o padrão. */
  sandbox?: TSandboxLevel
  /** Rede liberada dentro do sandbox (`SANDBOX_NETWORK`). Ausente = sem rede. */
  network?: boolean
}

export type TAgentRole = 'subagent'
export const AGENT_ROLES: readonly TAgentRole[] = ['subagent']
