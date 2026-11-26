import { hasUpdate, IProjectConnection } from '@domain/models/ProjectConnection.Model'

/** O que a manutenção precisa de fora: as conexões, os projetos e a sincronização. */
export interface IConnectedModelsMigrationDeps {
  connections: {
    list(): IProjectConnection[]
    markModelsLocal(projectId: string): void
    /** A sincronização em espelho (traz de novo o NOME do grupo de cada agente, que a de antes tirava). */
    sync(projectId: string, by: string): Promise<unknown>
  }
  projects: { exists(id: string): boolean; forgetModelGroups(id: string, by: string): string[] }
  log?: (line: string) => void
}

/** O que a manutenção fez num projeto. */
export interface IConnectedModelsCleanup {
  projectId: string
  removed: string[]
}

const BY = 'manutenção: modelos do projeto conectado'

/**
 * 🔌 A MANUTENÇÃO DA SUBIDA: antes, o projeto conectado herdava da origem os modelos e os grupos (os passos com os
 * provedores DE LÁ, como `alibaba`) e perdia o nome do grupo de cada agente. Agora da origem vem só o nome; os grupos e o
 * modelo padrão são desta máquina. Ao subir, cada conexão de antes (sem `modelsLocalAt`):
 *  1. perde os grupos e o grupo padrão do projeto (eram de antes: a tela não deixava configurá-los aqui);
 *  2. fica marcada (`modelsLocalAt`): o que alguém configurar depois nunca mais é tocado;
 *  3. sincroniza de novo, em segundo plano, para os agentes voltarem com o nome do grupo (com versão nova esperando e a
 *     atualização automática desligada, espera a pessoa atualizar).
 * ⚖️ IDEMPOTENTE: a marca garante uma vez por conexão; e, sem marca, rodar de novo sobre o projeto já limpo não tira nada.
 * A falha da sincronização (a origem fora do ar) não desfaz a limpeza: o vigia traz o nome na próxima atualização.
 */
export class ConnectedModelsMigration {
  constructor(private readonly deps: IConnectedModelsMigrationDeps) {}

  run(): { cleaned: IConnectedModelsCleanup[]; synced: Promise<void> } {
    const log = this.deps.log ?? ((line: string) => console.log(line))
    const cleaned: IConnectedModelsCleanup[] = []
    const pending: string[] = []
    for (const connection of this.deps.connections.list()) {
      if (connection.modelsLocalAt) continue
      const { projectId } = connection
      const removed = this.deps.projects.exists(projectId) ? this.deps.projects.forgetModelGroups(projectId, BY) : []
      this.deps.connections.markModelsLocal(projectId)
      cleaned.push({ projectId, removed })
      log(
        removed.length
          ? `[manutenção] projeto conectado ${projectId}: removido o que veio da origem (${removed.join(', ')}); os grupos e o modelo padrão agora são desta máquina`
          : `[manutenção] projeto conectado ${projectId}: nada de modelos da origem para remover; os grupos e o modelo padrão agora são desta máquina`,
      )
      // ⚖️ Com a atualização automática desligada e versão nova esperando, sincronizar traria a versão sem a pessoa pedir.
      if (connection.autoUpdate || !hasUpdate(connection)) pending.push(projectId)
      else log(`[manutenção] projeto conectado ${projectId}: o nome do grupo de cada agente chega na próxima atualização (a automática está desligada)`)
    }
    const synced = (async () => {
      for (const projectId of pending) {
        try {
          await this.deps.connections.sync(projectId, BY)
          log(`[manutenção] projeto conectado ${projectId}: sincronizado de novo (os agentes trazem o nome do grupo)`)
        } catch (error) {
          log(`[manutenção] projeto conectado ${projectId}: a sincronização falhou (${error instanceof Error ? error.message : String(error)}); vale na próxima atualização`)
        }
      }
    })()
    return { cleaned, synced }
  }
}
