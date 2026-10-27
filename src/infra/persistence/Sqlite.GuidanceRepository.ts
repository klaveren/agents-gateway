import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { IProjectDoc, TDocKind } from '@domain/models/ProjectDoc.Model'
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
