import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { IProjectDoc, TDocKind } from '@domain/models/ProjectDoc.Model'
import { IProtocolAddendum, TProtocolKind } from '@domain/models/Protocol.Model'
import { IAgentResources, IResource, TResourceKind } from '@domain/models/Resource.Model'
import { IRule } from '@domain/models/Rule.Model'
import { IGuidanceRepository, TDocPatch, TGuidanceScope, TRulePatch } from '@domain/ports/GuidanceRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rules (
    id          TEXT    NOT NULL PRIMARY KEY,
    project_id  TEXT,
    position    INTEGER NOT NULL,
    title       TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    updated_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS rules_scope ON rules (project_id, position);
  CREATE TABLE IF NOT EXISTS project_docs (
    id          TEXT NOT NULL PRIMARY KEY,
    kind        TEXT NOT NULL,
    project_id  TEXT,
    title       TEXT NOT NULL,
    summary     TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS project_docs_scope ON project_docs (project_id, kind);
  CREATE TABLE IF NOT EXISTS project_context_docs (
    project_id  TEXT    NOT NULL,
    doc_id      TEXT    NOT NULL,
    position    INTEGER NOT NULL,
    added_at    TEXT    NOT NULL,
    added_by    TEXT,
    PRIMARY KEY (project_id, doc_id)
  );
  CREATE INDEX IF NOT EXISTS project_context_docs_doc ON project_context_docs (doc_id);
  CREATE TABLE IF NOT EXISTS agent_context_docs (
    agent_id  TEXT    NOT NULL,
    doc_id    TEXT    NOT NULL,
    position  INTEGER NOT NULL,
    added_at  TEXT    NOT NULL,
    added_by  TEXT,
    PRIMARY KEY (agent_id, doc_id)
  );
  CREATE INDEX IF NOT EXISTS agent_context_docs_doc ON agent_context_docs (doc_id);
  CREATE TABLE IF NOT EXISTS resources (
    id          TEXT NOT NULL PRIMARY KEY,
    kind        TEXT NOT NULL,
    project_id  TEXT,
    description TEXT NOT NULL,
    body        TEXT NOT NULL,
    doc_ids     TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS resources_scope ON resources (project_id, kind);
  CREATE TABLE IF NOT EXISTS agent_resources (
    agent_id     TEXT NOT NULL,
    kind         TEXT NOT NULL,
    resource_id  TEXT NOT NULL,
    added_at     TEXT NOT NULL,
    added_by     TEXT,
    PRIMARY KEY (agent_id, kind, resource_id)
  );
  CREATE TABLE IF NOT EXISTS protocol_addenda (
    kind        TEXT NOT NULL,
    project_id  TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT,
    PRIMARY KEY (kind, project_id)
  );
`

type TRow = Record<string, unknown>

const RULE_COLUMNS: Record<keyof TRulePatch, string> = {
  projectId: 'project_id',
  title: 'title',
  body: 'body',
  enabled: 'enabled',
  position: 'position',
  updatedAt: 'updated_at',
  updatedBy: 'updated_by',
}
const DOC_COLUMNS: Record<keyof TDocPatch, string> = {
  projectId: 'project_id',
  kind: 'kind',
  title: 'title',
  summary: 'summary',
  body: 'body',
  updatedAt: 'updated_at',
  updatedBy: 'updated_by',
}

/** As rules e os documentos, no mesmo arquivo das conversas. Sem arquivo, em memória (`:memory:`). */
export class SqliteGuidanceRepository implements IGuidanceRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  rules(scope: TGuidanceScope): IRule[] {
    const rows =
      scope === null
        ? this.db.prepare('SELECT * FROM rules WHERE project_id IS NULL ORDER BY position, created_at').all()
        : this.db.prepare('SELECT * FROM rules WHERE project_id = ? ORDER BY position, created_at').all(scope)
    return (rows as TRow[]).map(toRule)
  }

  rule(id: string): IRule | undefined {
    const row = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as TRow | undefined
    return row ? toRule(row) : undefined
  }

  insertRule(rule: IRule): void {
    this.db
      .prepare('INSERT INTO rules (id, project_id, position, title, body, enabled, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        rule.id,
        rule.projectId ?? null,
        rule.position,
        rule.title,
        rule.body,
        rule.enabled ? 1 : 0,
        rule.createdAt.toISOString(),
        rule.updatedAt.toISOString(),
        rule.updatedBy ?? null,
      )
  }

  updateRule(id: string, patch: TRulePatch): IRule | undefined {
    this.patch('rules', RULE_COLUMNS, id, patch)
    return this.rule(id)
  }

  deleteRule(id: string): boolean {
    return this.db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0
  }

  docs(scope: TGuidanceScope, kind?: TDocKind): IProjectDoc[] {
    const where = [scope === null ? 'project_id IS NULL' : 'project_id = ?', ...(kind ? ['kind = ?'] : [])].join(' AND ')
    const params = [...(scope === null ? [] : [scope]), ...(kind ? [kind] : [])]
    return (this.db.prepare(`SELECT * FROM project_docs WHERE ${where} ORDER BY kind, title COLLATE NOCASE`).all(...params) as TRow[]).map(toDoc)
  }

  doc(id: string): IProjectDoc | undefined {
    const row = this.db.prepare('SELECT * FROM project_docs WHERE id = ?').get(id) as TRow | undefined
    return row ? toDoc(row) : undefined
  }

  insertDoc(doc: IProjectDoc): void {
    this.db
      .prepare('INSERT INTO project_docs (id, kind, project_id, title, summary, body, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(doc.id, doc.kind, doc.projectId ?? null, doc.title, doc.summary, doc.body, doc.createdAt.toISOString(), doc.updatedAt.toISOString(), doc.updatedBy ?? null)
  }

  updateDoc(id: string, patch: TDocPatch): IProjectDoc | undefined {
    this.patch('project_docs', DOC_COLUMNS, id, patch)
    return this.doc(id)
  }

  deleteDoc(id: string): boolean {
    this.db.prepare('DELETE FROM project_context_docs WHERE doc_id = ?').run(id)
    this.db.prepare('DELETE FROM agent_context_docs WHERE doc_id = ?').run(id)
    // O documento sai dos recursos que o anexavam.
    for (const resource of this.allResources().filter((item) => item.docIds.includes(id)))
      this.saveResource({ ...resource, docIds: resource.docIds.filter((docId) => docId !== id) })
    return this.db.prepare('DELETE FROM project_docs WHERE id = ?').run(id).changes > 0
  }

  contextDocs(projectId: string): string[] {
    return (this.db.prepare('SELECT doc_id FROM project_context_docs WHERE project_id = ? ORDER BY position').all(projectId) as TRow[]).map((row) => row.doc_id as string)
  }

  contextProjectsOf(docId: string): string[] {
    return (this.db.prepare('SELECT project_id FROM project_context_docs WHERE doc_id = ? ORDER BY project_id').all(docId) as TRow[]).map((row) => row.project_id as string)
  }

  setContextDocs(projectId: string, docIds: readonly string[], by: string): void {
    this.replaceList('project_context_docs', 'project_id', projectId, docIds, by)
  }

  agentContextDocs(agentId: string): string[] {
    return (this.db.prepare('SELECT doc_id FROM agent_context_docs WHERE agent_id = ? ORDER BY position').all(agentId) as TRow[]).map((row) => row.doc_id as string)
  }

  agentContextOf(docId: string): string[] {
    return (this.db.prepare('SELECT agent_id FROM agent_context_docs WHERE doc_id = ? ORDER BY agent_id').all(docId) as TRow[]).map((row) => row.agent_id as string)
  }

  setAgentContextDocs(agentId: string, docIds: readonly string[], by: string): void {
    this.replaceList('agent_context_docs', 'agent_id', agentId, docIds, by)
  }

  deleteAgentContext(agentId: string): void {
    this.db.prepare('DELETE FROM agent_context_docs WHERE agent_id = ?').run(agentId)
  }

  resources(scope: TGuidanceScope, kind?: TResourceKind): IResource[] {
    const where = [scope === null ? 'project_id IS NULL' : 'project_id = ?', ...(kind ? ['kind = ?'] : [])].join(' AND ')
    const params = [...(scope === null ? [] : [scope]), ...(kind ? [kind] : [])]
    return (this.db.prepare(`SELECT * FROM resources WHERE ${where} ORDER BY id`).all(...params) as TRow[]).map(toResource)
  }

  resource(id: string): IResource | undefined {
    const row = this.db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as TRow | undefined
    return row ? toResource(row) : undefined
  }

  saveResource(resource: IResource): void {
    this.db
      .prepare(
        `INSERT INTO resources (id, kind, project_id, description, body, doc_ids, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, project_id = excluded.project_id, description = excluded.description, body = excluded.body,
           doc_ids = excluded.doc_ids, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(
        resource.id,
        resource.kind,
        resource.projectId ?? null,
        resource.description,
        resource.body,
        JSON.stringify(resource.docIds),
        resource.createdAt.toISOString(),
        resource.updatedAt.toISOString(),
        resource.updatedBy ?? null,
      )
  }

  deleteResource(id: string): boolean {
    this.db.prepare('DELETE FROM agent_resources WHERE resource_id = ?').run(id)
    return this.db.prepare('DELETE FROM resources WHERE id = ?').run(id).changes > 0
  }

  agentResources(agentId: string): IAgentResources {
    const rows = this.db.prepare('SELECT kind, resource_id FROM agent_resources WHERE agent_id = ? ORDER BY resource_id').all(agentId) as TRow[]
    return {
      skills: rows.filter((row) => row.kind === 'skill').map((row) => row.resource_id as string),
      commands: rows.filter((row) => row.kind === 'command').map((row) => row.resource_id as string),
    }
  }

  setAgentResources(agentId: string, resources: IAgentResources, by: string): void {
    const now = new Date().toISOString()
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM agent_resources WHERE agent_id = ?').run(agentId)
      const insert = this.db.prepare('INSERT INTO agent_resources (agent_id, kind, resource_id, added_at, added_by) VALUES (?, ?, ?, ?, ?)')
      for (const id of resources.skills) insert.run(agentId, 'skill', id, now, by)
      for (const id of resources.commands) insert.run(agentId, 'command', id, now, by)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  deleteAgentResources(agentId: string): void {
    this.db.prepare('DELETE FROM agent_resources WHERE agent_id = ?').run(agentId)
  }

  /** ⚠️ O global é `project_id = ''`, não NULL: NULL não colide na chave primária, e o global viraria vários. */
  protocolAddendum(kind: TProtocolKind, scope: TGuidanceScope): IProtocolAddendum | undefined {
    const row = this.db.prepare('SELECT * FROM protocol_addenda WHERE kind = ? AND project_id = ?').get(kind, scope ?? '') as TRow | undefined
    if (!row) return undefined
    return {
      kind: row.kind as TProtocolKind,
      ...(row.project_id ? { projectId: row.project_id as string } : {}),
      body: row.body as string,
      updatedAt: new Date(row.updated_at as string),
      ...(row.updated_by ? { updatedBy: row.updated_by as string } : {}),
    }
  }

  setProtocolAddendum(kind: TProtocolKind, scope: TGuidanceScope, addendum: IProtocolAddendum | undefined): void {
    if (!addendum) {
      this.db.prepare('DELETE FROM protocol_addenda WHERE kind = ? AND project_id = ?').run(kind, scope ?? '')
      return
    }
    this.db
      .prepare(
        `INSERT INTO protocol_addenda (kind, project_id, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, project_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(kind, scope ?? '', addendum.body, addendum.updatedAt.toISOString(), addendum.updatedBy ?? null)
  }

  private allResources(): IResource[] {
    return (this.db.prepare('SELECT * FROM resources').all() as TRow[]).map(toResource)
  }

  /** Troca a lista inteira de um dono (projeto ou agente), numa transação. */
  private replaceList(table: 'project_context_docs' | 'agent_context_docs', owner: 'project_id' | 'agent_id', id: string, docIds: readonly string[], by: string): void {
    const now = new Date().toISOString()
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`DELETE FROM ${table} WHERE ${owner} = ?`).run(id)
      const insert = this.db.prepare(`INSERT INTO ${table} (${owner}, doc_id, position, added_at, added_by) VALUES (?, ?, ?, ?, ?)`)
      docIds.forEach((docId, index) => insert.run(id, docId, index + 1, now, by))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  deleteProject(projectId: string): void {
    this.db.prepare('DELETE FROM rules WHERE project_id = ?').run(projectId)
    this.db.prepare('DELETE FROM project_docs WHERE project_id = ?').run(projectId)
    this.db.prepare('DELETE FROM project_context_docs WHERE project_id = ?').run(projectId)
    this.db.prepare('DELETE FROM protocol_addenda WHERE project_id = ?').run(projectId)
    const ids = (this.db.prepare('SELECT id FROM resources WHERE project_id = ?').all(projectId) as TRow[]).map((row) => row.id as string)
    for (const id of ids) this.deleteResource(id)
  }

  private patch<T extends object>(table: string, columns: Record<keyof T, string>, id: string, patch: T): void {
    const keys = (Object.keys(patch) as Array<keyof T>).filter((key) => key in columns && patch[key] !== undefined)
    if (!keys.length) return
    const values = keys.map((key): SQLInputValue => {
      const value = patch[key] as unknown
      if (value instanceof Date) return value.toISOString()
      if (typeof value === 'boolean') return value ? 1 : 0
      return value as SQLInputValue
    })
    this.db.prepare(`UPDATE ${table} SET ${keys.map((key) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`).run(...values, id)
  }
}

function toRule(row: TRow): IRule {
  return {
    id: row.id as string,
    ...(row.project_id ? { projectId: row.project_id as string } : {}),
    position: Number(row.position),
    title: row.title as string,
    body: row.body as string,
    enabled: !!row.enabled,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    ...(row.updated_by ? { updatedBy: row.updated_by as string } : {}),
  }
}

function toDoc(row: TRow): IProjectDoc {
  return {
    id: row.id as string,
    kind: row.kind as TDocKind,
    ...(row.project_id ? { projectId: row.project_id as string } : {}),
    title: row.title as string,
    summary: row.summary as string,
    body: row.body as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    ...(row.updated_by ? { updatedBy: row.updated_by as string } : {}),
  }
}

function toResource(row: TRow): IResource {
  let docIds: string[]
  try {
    docIds = JSON.parse(String(row.doc_ids ?? '[]')) as string[]
  } catch {
    docIds = []
  }
  return {
    id: row.id as string,
    kind: row.kind as TResourceKind,
    ...(row.project_id ? { projectId: row.project_id as string } : {}),
    description: row.description as string,
    body: row.body as string,
    docIds,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    ...(row.updated_by ? { updatedBy: row.updated_by as string } : {}),
  }
}
