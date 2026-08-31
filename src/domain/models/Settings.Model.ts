/**
 * As decisões que mudam sem deploy.
 *
 * ⚖️ POR QUE ISTO EXISTE, se já há `.env` e código. Qual agente atende e com que modelo eram
 * escolhas do `Agent.Registry.ts` e de variáveis de ambiente — decisões de DEPLOY. Recolher o
 * agente porque está respondendo mal, ou trocar de modelo para comparar custo, são decisões de
 * OPERAÇÃO: se dependem de publicar, não são tomadas na hora em que importam.
 *
 * ⚠️ GLOBAIS. Valem para todas as sessões de uma vez. Configuração por chamador exigiria decidir
 * quem escolhe o modelo de quem, e essa pergunta não tem resposta útil enquanto não houver mais de
 * uma pessoa configurando.
 */
export interface IAgentSettings {
  /**
   * ⛔ Desligar impede SESSÃO NOVA; quem já estava conversando termina o turno em curso. Matar
   * turno no meio deixaria a pessoa com meia resposta e o registro de um erro que não foi erro.
   */
  enabled: boolean

  /** Qual agente do registry atende. Vazio = o que o chamador pedir, ou o padrão do registry. */
  agentId?: string

  /** Modelo do agente. Vazio = o primeiro que o agente declara. */
  model?: string

  updatedAt?: Date
  updatedBy?: string
}

/**
 * O que vale quando nada foi configurado.
 *
 * ⚖️ NASCE LIGADO. Configuração ausente não pode mudar o comportamento de quem já usava o gateway
 * antes de existir configuração; e um serviço que sobe desligado aparenta estar quebrado no
 * primeiro uso, com um sintoma — nenhuma resposta — que não aponta para configuração.
 */
export const DEFAULT_SETTINGS: IAgentSettings = { enabled: true }
