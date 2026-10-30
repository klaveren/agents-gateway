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
}

export interface IAgentTerminal {
  timeoutSeconds?: number
  maxOutputChars?: number
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
