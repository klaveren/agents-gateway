import { PermissionsService } from '@application/Permissions.Service'
import { IPermissionRule } from '@domain/Permission.Policy'
import { dataDir } from '@infra/adapters/support/Subscription.Workspace'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqlitePermissionRepository } from '@infra/persistence/Sqlite.PermissionRepository'
import { makeAgents } from './Agents.Factory'
import { makeCatalogHistory } from './CatalogHistory.Factory'

let service: PermissionsService | undefined
let repository: SqlitePermissionRepository | undefined

/**
 * ⛔ O que mora na pasta de dados do gateway e nenhum agente lê nem escreve: o banco, a chave-mestra, os backups e os
 * logins das assinaturas. As pastas de projeto e de ferramentas, que também ficam lá, não entram.
 */
export function installationRules(): IPermissionRule[] {
  const data = dataDir().replace(/\/+$/, '')
  return [`${data}/*.db`, `${data}/*.db-*`, `${data}/secrets*`, `${data}/backup*/**`, `${data}/*-home/**`].flatMap((pattern) => [
    { category: 'read' as const, pattern, decision: 'deny' as const, note: 'dados do gateway' },
    { category: 'write' as const, pattern, decision: 'deny' as const, note: 'dados do gateway' },
  ])
}

/** As permissões: UM serviço, no mesmo arquivo das conversas (as ferramentas, o catálogo e a tela o dividem). */
export function makePermissions(): PermissionsService {
  if (service) return service
  const configured = process.env.CONVERSATIONS_DB?.trim()
  const system = installationRules()
  repository = new SqlitePermissionRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH)
  service = new PermissionsService(
    repository,
    (agentId) => makeAgents().get(agentId)?.permissions,
    () => system,
  )
  service.history.use(() => makeCatalogHistory())
  return service
}

/** O repositório das permissões, para o leitor do catálogo (o histórico). */
export function permissionRepository(): SqlitePermissionRepository {
  makePermissions()
  return repository!
}
