import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteImportRepository } from '@infra/persistence/Sqlite.ImportRepository'

let instance: SqliteImportRepository | undefined

/**
 * Os trabalhos de importação (`import_scans`, `import_items`): UM repositório, no mesmo arquivo das conversas.
 * ⚖️ Sem depender das outras fábricas: o apagar do projeto (`Projects.Factory`) o chama.
 */
export function importJobRepository(): SqliteImportRepository {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  instance = new SqliteImportRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH)
  return instance
}

/** Apagar o projeto apaga os trabalhos de importação dele. */
export function removeProjectImports(projectId: string): void {
  importJobRepository().deleteProject(projectId)
}
