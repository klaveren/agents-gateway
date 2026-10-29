import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IProjectAccount, IProjectAccountPublic, TProjectAccountKind } from '@domain/models/ProjectAccount.Model'
import { IProjectAccountRepository, IProjectAccountSave } from '@domain/ports/ProjectAccountRepository.Port'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_accounts (
    project_id  TEXT NOT NULL,
    id          TEXT NOT NULL,
    kind        TEXT NOT NULL,
    label       TEXT NOT NULL,
    public      TEXT NOT NULL,
    sealed      TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT,
    PRIMARY KEY (project_id, id)
  );
`

type TRow = Record<string, unknown>

/**
 * ⛔ O DONO DO SEGREDO no AAD do selo: o segredo de uma conta não abre como o de outra, nem como o de outro projeto
 * (uma linha copiada de um projeto para o outro falha ao abrir).
 */
export function accountOwner(projectId: string, id: string): string {
  return `conta:${projectId}:${id}`
}

/** As contas dos projetos, no mesmo arquivo das conversas, com o segredo selado pela chave-mestra. */
export class SqliteProjectAccountRepository implements IProjectAccountRepository {
  private readonly db: DatabaseSync

  constructor(
    private readonly box: SecretBox,
    path = ':memory:',
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  list(projectId: string): IProjectAccount[] {
    return (this.db.prepare('SELECT * FROM project_accounts WHERE project_id = ? ORDER BY id').all(projectId) as TRow[]).map(toAccount)
  }

  get(projectId: string, id: string): IProjectAccount | undefined {
    const row = this.db.prepare('SELECT * FROM project_accounts WHERE project_id = ? AND id = ?').get(projectId, id) as TRow | undefined
    return row ? toAccount(row) : undefined
  }

  secret(projectId: string, id: string): string | undefined {
    const row = this.db.prepare('SELECT sealed FROM project_accounts WHERE project_id = ? AND id = ?').get(projectId, id) as TRow | undefined
    return row ? this.box.open(String(row.sealed), accountOwner(projectId, id)) : undefined
  }

  save(projectId: string, id: string, input: IProjectAccountSave, by: string): IProjectAccount {
    const current = this.db.prepare('SELECT sealed FROM project_accounts WHERE project_id = ? AND id = ?').get(projectId, id) as TRow | undefined
    const secret = input.secret?.trim()
    const sealed = secret ? this.box.seal(secret, accountOwner(projectId, id)) : current ? String(current.sealed) : undefined
    if (!sealed) throw new Error('secret: obrigatório')
    const previous = current ? this.get(projectId, id) : undefined
    const last4 = secret ? secret.slice(-4) : previous?.public.last4
    const visible: IProjectAccountPublic = { ...input.public, ...(last4 && input.kind !== 'github-app' ? { last4 } : {}) }
    this.db
      .prepare(
        `INSERT INTO project_accounts (project_id, id, kind, label, public, sealed, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, id) DO UPDATE SET kind = excluded.kind, label = excluded.label, public = excluded.public,
           sealed = excluded.sealed, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(projectId, id, input.kind, input.label, JSON.stringify(visible), sealed, new Date().toISOString(), by)
    return this.get(projectId, id)!
  }

  remove(projectId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM project_accounts WHERE project_id = ? AND id = ?').run(projectId, id).changes) > 0
  }

  deleteProject(projectId: string): void {
    this.db.prepare('DELETE FROM project_accounts WHERE project_id = ?').run(projectId)
  }
}

function toAccount(row: TRow): IProjectAccount {
  return {
    projectId: String(row.project_id),
    id: String(row.id),
    kind: String(row.kind) as TProjectAccountKind,
    label: String(row.label),
    public: JSON.parse(String(row.public)) as IProjectAccountPublic,
    updatedAt: new Date(String(row.updated_at)),
    ...(typeof row.updated_by === 'string' ? { updatedBy: row.updated_by } : {}),
  }
}
