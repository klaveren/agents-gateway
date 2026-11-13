import { IConversationFile } from '@domain/models/ConversationFile.Model'
import { emptyPanel, IConversationPanel } from '@domain/models/ConversationPanel.Model'
import type { IErrorLog, IErrorLogQuery, ITurnRefusal } from '@domain/models/ErrorLog.Model'
import { ITodoItem } from '@domain/models/ConversationTodo.Model'
import { TClassification } from '@domain/models/Classification.Model'
import {
  IConversationPage,
  IConversationPageQuery,
  IConversationScope,
  IConversationSession,
  IConversationStats,
  IConversationTurn,
  IOwnerFilter,
  INativeSnapshot,
} from '@domain/models/Conversation.Model'
import { IUsageQuery, IUsageRow } from '@domain/models/Usage.Model'
import type { IToolUsage } from '@domain/models/ToolUsage.Model'
import { IConversationEvents } from '@domain/ports/ConversationEvents.Port'
import { IConversationRepository, ITurnWindow, turnWindow } from '@domain/ports/ConversationRepository.Port'

/**
 * O repositório que AVISA: grava no de verdade e, depois, publica o que mudou.
 *
 * ⚖️ DECORADOR, e não o use case publicando: toda escrita passa por aqui — o turno, o rótulo que
 * chega depois, o compartilhar e o apagar da tela —, e quem esquecesse de publicar num desses
 * deixaria a caixa de entrada desatualizada sem nenhum erro à vista.
 *
 * ⚠️ `saveSession` NÃO publica: o cabeçalho é regravado logo antes de cada `appendTurn`, e avisar
 * os dois mandaria a mesma linha duas vezes por turno — a primeira ainda sem a prévia nova.
 *
 * ⛔ PUBLICAR NUNCA DERRUBA A ESCRITA. A releitura que monta o evento é a mesma do repositório, que
 * já engole o próprio erro; o barramento isola os ouvintes.
 */
export class NotifyingConversationRepository implements IConversationRepository {
  constructor(
    private readonly inner: IConversationRepository,
    private readonly events: IConversationEvents,
  ) {}

  saveSession(session: IConversationSession): Promise<void> {
    return this.inner.saveSession(session)
  }

  async appendTurn(turn: IConversationTurn): Promise<number | undefined> {
    const stored = await this.inner.appendTurn(turn)
    if (stored !== undefined) await this.announce(turn.sessionId)

    return stored
  }

  async suggestTurn(sessionId: string, index: number, suggestion: string): Promise<void> {
    await this.inner.suggestTurn?.(sessionId, index, suggestion)
  }

  async classifyTurn(sessionId: string, index: number, classification: TClassification): Promise<void> {
    await this.inner.classifyTurn(sessionId, index, classification)
    await this.announce(sessionId)
  }

  async setShared(sessionId: string, shared: boolean, shareId?: string): Promise<void> {
    await this.inner.setShared(sessionId, shared, shareId)
    await this.announce(sessionId)
  }

  async deleteSession(sessionId: string, by?: string): Promise<void> {
    // Lido ANTES: depois de apagar não há mais de quem era.
    const before = await this.inner.findSession(sessionId)
    await this.inner.deleteSession(sessionId, by)

    if (before) this.events.publish({ type: 'conversation.deleted', sessionId, metadata: before.metadata })
  }

  stats(scope?: IConversationScope): Promise<IConversationStats> {
    return this.inner.stats(scope)
  }

  errors(query: IErrorLogQuery): Promise<IErrorLog> {
    return this.inner.errors?.(query) ?? Promise.resolve({ items: [], byKind: { tool: 0, turn: 0, aborted: 0, refused: 0 }, byTool: [] })
  }

  async recordRefusal(refusal: ITurnRefusal): Promise<void> {
    await this.inner.recordRefusal?.(refusal)
  }

  usage(query: IUsageQuery): Promise<IUsageRow[]> {
    return this.inner.usage(query)
  }

  async toolUsage(query: IUsageQuery): Promise<IToolUsage[]> {
    return (await this.inner.toolUsage?.(query)) ?? []
  }

  listSessions(options?: {
    limit?: number
    filter?: Record<string, unknown>
    owner?: IOwnerFilter | null
    archived?: boolean
    scope?: IConversationScope
  }): Promise<IConversationSession[]> {
    return this.inner.listSessions(options)
  }

  /** Arquivar avisa a caixa de entrada (a conversa sai da lista, ou volta a ela). */
  async setArchived(sessionId: string, archived: boolean, by?: string): Promise<void> {
    await this.inner.setArchived?.(sessionId, archived, by)
    const session = await this.inner.findSession(sessionId)
    if (session) this.events.publish({ type: 'conversation.updated', session })
  }

  countArchived(owner?: IOwnerFilter | null): Promise<number> {
    return this.inner.countArchived?.(owner) ?? Promise.resolve(0)
  }

  assignProject(agentIds: readonly string[], projectId: string): Promise<number> {
    return this.inner.assignProject(agentIds, projectId)
  }

  pageSessions(query: IConversationPageQuery): Promise<IConversationPage> {
    return this.inner.pageSessions(query)
  }

  listTurns(sessionId: string): Promise<IConversationTurn[]> {
    return this.inner.listTurns(sessionId)
  }

  async listTurnsPage(sessionId: string, window: ITurnWindow): Promise<{ turns: IConversationTurn[]; hasMore: boolean }> {
    return this.inner.listTurnsPage ? this.inner.listTurnsPage(sessionId, window) : turnWindow(await this.inner.listTurns(sessionId), window)
  }

  findSession(sessionId: string): Promise<IConversationSession | undefined> {
    return this.inner.findSession(sessionId)
  }

  async saveNative(sessionId: string, snapshot: INativeSnapshot | null): Promise<void> {
    await this.inner.saveNative?.(sessionId, snapshot)
  }

  async findNative(sessionId: string): Promise<INativeSnapshot | undefined> {
    return this.inner.findNative?.(sessionId)
  }

  async todos(sessionId: string): Promise<{ items: ITodoItem[]; updatedAt?: Date }> {
    return (await this.inner.todos?.(sessionId)) ?? { items: [] }
  }

  async saveTodos(sessionId: string, items: ITodoItem[]): Promise<void> {
    if (!this.inner.saveTodos) throw new Error('This conversation store has no task list')
    await this.inner.saveTodos(sessionId, items)
  }

  async panel(sessionId: string): Promise<IConversationPanel> {
    return (await this.inner.panel?.(sessionId)) ?? emptyPanel()
  }

  async savePanel(sessionId: string, panel: IConversationPanel): Promise<void> {
    if (!this.inner.savePanel) throw new Error('This conversation store has no panel')
    await this.inner.savePanel(sessionId, panel)
  }

  async files(sessionId: string): Promise<IConversationFile[]> {
    return (await this.inner.files?.(sessionId)) ?? []
  }

  async file(sessionId: string, id: string): Promise<{ file: IConversationFile; data: Buffer } | undefined> {
    return this.inner.file?.(sessionId, id)
  }

  async saveFile(file: IConversationFile, data: Buffer): Promise<void> {
    if (!this.inner.saveFile) throw new Error('This conversation store keeps no files')
    await this.inner.saveFile(file, data)
  }

  findByShareId(shareId: string): Promise<IConversationSession | undefined> {
    return this.inner.findByShareId(shareId)
  }

  /** Relê do banco e publica: quem escuta recebe o estado gravado, não o que se pretendia gravar. */
  private async announce(sessionId: string): Promise<void> {
    const session = await this.inner.findSession(sessionId)
    if (session) this.events.publish({ type: 'conversation.updated', session })
  }
}
