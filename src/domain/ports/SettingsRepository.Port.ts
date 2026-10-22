import { IAgentSettings } from '@domain/models/Settings.Model'

/**
 * Onde as configurações vivem. O domínio não sabe qual é o banco — nem se existe um.
 *
 * ⛔ LER NUNCA PODE DERRUBAR O SERVIÇO. Banco fora do ar devolve o default e o gateway segue
 * atendendo. Um sistema que para de responder porque não conseguiu ler a própria configuração
 * troca um problema pequeno por um grande.
 */
export interface ISettingsRepository {
  read(): Promise<IAgentSettings>
  save(settings: IAgentSettings): Promise<void>

  /**
   * Avisa quem depende das configurações quando elas mudam.
   *
   * ⚖️ É o que permite ao provider manter uma cópia em memória sem consultar o banco a cada sessão:
   * ele carrega no boot e escuta a mudança. O caminho quente deixa de ter um `await` para responder
   * a mesma pergunta o tempo todo, e a alteração passa a valer no instante em que é salva — não
   * depois de um cache expirar.
   *
   * ⚠️ O AVISO É DESTE PROCESSO. Com mais de uma instância, quem não recebeu a escrita continua com
   * a cópia antiga até reler. No dia em que forem duas, isto vira publicação de verdade (um canal
   * no banco, um pub/sub) — e o lugar de mudar é este, não quem escuta.
   */
  subscribe(listener: (settings: IAgentSettings) => void): void
}
