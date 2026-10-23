/**
 * O que o adapter precisa saber sobre a chamada — e nada além disso.
 *
 * ⚖️ QUEM RESOLVE É O PROVIDER, não o adapter. Enquanto cada adapter buscava a credencial do seu
 * jeito, o resultado foi previsível: uns buscavam, outros não, e os que não buscavam falavam com o
 * MCP sem identidade nenhuma — toda tool respondendo "chamada sem credencial" enquanto o vizinho
 * funcionava. Três caminhos para a mesma verdade produzem três verdades.
 *
 * Com o contexto vindo de fora, o adapter deixa de ter opinião: recebe o que vale e usa. Um
 * adapter novo não tem como esquecer de buscar algo que ele nunca busca.
 */
export interface IExecutionContext {
  /**
   * A credencial de quem chamou, repassada às ferramentas.
   *
   * Ausente em chamada sem identidade — um `curl` de diagnóstico local, por exemplo. Nesse caso a
   * requisição vai sem header e o MCP cai no que estiver configurado no ambiente dele; é o MCP que
   * decide se aceita isso.
   */
  token?: string
  /** A sessão do turno em curso — é por ela que a delegação sabe de onde veio (ver `Delegation.Service`). */
  sessionId?: string
  /** O agente que está respondendo. */
  agentId?: string
}
