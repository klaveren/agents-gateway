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
  /** O projeto do agente: é na pasta dele que as ferramentas locais (`run_bash`) trabalham. Ausente = global. */
  projectId?: string
  /**
   * O projeto da CONVERSA, que pode ser outro que o do agente (o Atlas, global, numa conversa do projeto XPTO).
   * É por ele que o `read_doc` sabe que documentos a conversa pode ler.
   */
  conversationProjectId?: string
  /**
   * ⛔ A PASTA DE TRABALHO da conversa, já resolvida no servidor (ver `Work.Folder`): o repositório ou a worktree em que
   * ela foi aberta. Presente, vale em todo lugar que antes era a pasta do projeto: o `cwd`, as ferramentas de arquivo e
   * a raiz do cerco.
   */
  workFolder?: IContextWorkFolder
}

/** A pasta resolvida e o git dela (o `.git` comum de uma worktree fica fora da pasta). */
export interface IContextWorkFolder {
  dir: string
  /** A pasta do projeto: o HOME, o rascunho e as contas ficam nela, nunca dentro da worktree. */
  projectDir: string
  repository?: string
  worktree?: string
  gitCommonDir?: string
  worktreeGitDir?: string
}
