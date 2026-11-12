import type { TWatchChecker, TWatchDeliverer } from '@application/Watch.Service'
import type { IContextWorkFolder, IExecutionContext } from '@domain/models/ExecutionContext.Model'
import type { IWatchCheck } from '@domain/models/Watch.Model'
import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'

/** O que a conferência e a entrega precisam saber da conversa: a que está na memória, ou a gravada. */
export interface IWatchedConversation {
  agentId: string
  metadata?: Record<string, unknown>
  archived: boolean
}

export interface IWatchExecutorDeps {
  conversation(sessionId: string): Promise<IWatchedConversation | undefined>
  /** O projeto do agente: `null` = global; `undefined` = o agente não existe mais. */
  agentProject(agentId: string): string | null | undefined
  /** A pasta de trabalho da conversa (ver `workFolderOf`, no provider). Lança se a worktree sumiu. */
  workFolder(metadata: Record<string, unknown> | undefined, projectId: string | undefined): IContextWorkFolder | undefined
  secretEnv(agentId: string, sessionId: string, projectId: string | undefined): Readonly<Record<string, string>> | undefined
  /** O terminal do agente, lido como conferência (ver `WatchDesk.check`). */
  bash(command: string, context: IExecutionContext): Promise<IWatchCheck>
  /** Uma sessão da conta dona, sem senha (ver `AccountsService.sessionForHook`). `undefined` = conta fora. */
  sessionFor(userId: string): { token: string } | undefined
  /** Entrega o aviso na conversa, em nome de quem tem este token (ver `AgentController.serverNotice`). */
  notice(token: string, sessionId: string, text: string): Promise<'queued' | 'turn' | 'archived'>
}

const refused = (output: string): IWatchCheck => ({ verdict: 'refused', output })

/**
 * A CONFERÊNCIA e a ENTREGA de uma vigia, fora de qualquer turno.
 *
 * ⛔ A conferência refaz o contexto do turno (agente, projeto, pasta de trabalho, segredos) pela MESMA regra do provider,
 * e roda no terminal do agente: a vigia não alcança nada que o `run_bash` dele não alcance. Sem token: o comando confere
 * pelo terminal, não fala com MCP em nome de ninguém.
 * ⚖️ A entrega é em nome da conta DONA da conversa, como o agendamento roda em nome de quem o criou: é ela que a
 * conversa reconhece, e a conta desativada leva a vigia junto.
 */
export function makeWatchExecutor(deps: IWatchExecutorDeps): { check: TWatchChecker; deliver: TWatchDeliverer } {
  return {
    async check(watch) {
      if (!watch.command) return refused('Esta vigia não tem comando.')
      const conversation = await deps.conversation(watch.sessionId)
      if (!conversation) return refused('A conversa desta vigia não existe mais.')
      const agentProject = deps.agentProject(conversation.agentId)
      if (agentProject === undefined) return refused(`O agente ${conversation.agentId} não existe mais.`)
      const stamped = conversation.metadata?.[PROJECT_METADATA_KEY]
      const conversationProject = typeof stamped === 'string' && stamped ? stamped : undefined
      let workFolder: IContextWorkFolder | undefined
      try {
        workFolder = deps.workFolder(conversation.metadata, conversationProject)
      } catch (error) {
        return refused(`A pasta de trabalho da conversa não abre: ${error instanceof Error ? error.message : String(error)}`)
      }
      const context: IExecutionContext = {
        sessionId: watch.sessionId,
        agentId: conversation.agentId,
        ...(agentProject ? { projectId: agentProject } : {}),
        ...(conversationProject ? { conversationProjectId: conversationProject } : {}),
        ...(workFolder ? { workFolder } : {}),
      }
      const secretEnv = deps.secretEnv(conversation.agentId, watch.sessionId, conversationProject)
      if (secretEnv && Object.keys(secretEnv).length) context.secretEnv = { ...secretEnv }
      return deps.bash(watch.command, context)
    },

    async deliver(watch, text) {
      const conversation = await deps.conversation(watch.sessionId)
      if (!conversation) return 'gone'
      if (conversation.archived) return 'archived'
      const session = deps.sessionFor(watch.runAs)
      if (!session) return 'no-owner'
      return deps.notice(session.token, watch.sessionId, text)
    },
  }
}
