import type { IPermissionAsker, IPermissionChecker } from '@application/Permissions.Service'
import { cercoPlan } from '@domain/Cerco.Plan'
import type { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { exec } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { networkGate } from '@infra/permissions/Network.Gate'
import { analyzeShell } from '@infra/permissions/Shell.Parse'
import { bashPolicy, denyReason, truncate, type IBashPolicy } from './Bash.Guard'
import { subscriptionEnv, workspaceFor } from '@infra/adapters/support/Subscription.Workspace'
import { IProjectSandbox, projectSandbox, SANDBOX_SHELL } from '@infra/sandbox/Project.Sandbox'
import { DOC_KINDS, IProjectDoc, READ_DOC_TOOL, SEARCH_DOCS_TOOL, TDocKind } from '@domain/models/ProjectDoc.Model'
import { IDocHit } from '@domain/ports/GuidanceRepository.Port'
import { USE_SKILL_TOOL } from '@domain/models/Resource.Model'
import { IBuilderDraft } from '@domain/models/Protocol.Model'
import { builderKindOf, PROPOSE_DRAFT_TOOL } from '@domain/Builder.Agents'
import { ITodoItem, todoIssues, todoText, UPDATE_TODOS_TOOL } from '@domain/models/ConversationTodo.Model'
import { makeFileTools, realOf } from './File.Tools'
import { ILocalTool, IToolResult } from './Tool.Types'

export interface IExecOptions {
  cwd: string
  timeout: number
  maxBuffer: number
  env: Record<string, string>
  /** O shell da linha; o comando cercado (`Project.Sandbox`) é montado para o bash. */
  shell?: string
}

export type TExec = (command: string, options: IExecOptions) => Promise<{ stdout: string; stderr: string }>
export type TFetchHtml = (query: string) => Promise<string>

/** Quem lê um documento para a conversa (o `GuidanceService`). */
export interface IDocReader {
  readDoc(id: string, projectId?: string): IProjectDoc | undefined
  /** A busca de texto (ver `GuidanceService.searchDocs`). Ausente = sem `search_docs`. */
  searchDocs?(query: string, projectId?: string, kind?: TDocKind): IDocHit[]
}

/** Quem confere o rascunho do construtor sem gravar (o `GuidanceService`). */
export interface IDraftChecker {
  draftIssues(draft: IBuilderDraft, projectId?: string): { issues: Array<{ field: string; message: string }>; updates: boolean; id?: string; projectId?: string }
  /** O rascunho de agente (assíncrono: confere o registro com as regras do cadastro). Ausente = sem rascunho de agente. */
  agentDraftIssues?(draft: IBuilderDraft): Promise<{ issues: Array<{ field: string; message: string }>; updates: boolean; id?: string; projectId?: string }>
}

/** Quem carrega uma skill para o agente (o `GuidanceService`). */
export interface ISkillLoader {
  loadSkill(id: string, agentId?: string): string | undefined
}

export interface ILocalToolDeps {
  exec?: TExec
  fetchHtml?: TFetchHtml
  policy?: IBashPolicy
  /** O cerco do agente de projeto (ver `Project.Sandbox`). Ausente = o do processo. */
  sandbox?: IProjectSandbox
  /** As skills liberadas ao agente. Ausente = sem `use_skill`. */
  skills?: ISkillLoader
  /** Os documentos (specs e ADRs). Ausente = sem `read_doc`. */
  docs?: IDocReader
  /** O conferente dos rascunhos do construtor. Ausente = sem `propose_draft`. */
  drafts?: IDraftChecker
  /** Onde fica a lista de tarefas da conversa (o repositório de conversas). Ausente = sem `update_todos`. */
  todos?: ITodoStore
  /** As permissões dos agentes (ver `Permission.Policy`). Ausente = sem regras (só as travas fixas valem). */
  permissions?: IPermissionChecker
}

/** Quem pede, a partir do contexto do turno: o agente e o projeto da CONVERSA. */
export function askerOf(context: IExecutionContext | undefined) {
  const projectId = context?.conversationProjectId ?? context?.projectId
  return { ...(context?.agentId ? { agentId: context.agentId } : {}), ...(projectId ? { projectId } : {}), ...(context?.sessionId ? { sessionId: context.sessionId } : {}) }
}

export interface ITodoStore {
  saveTodos?(sessionId: string, items: ITodoItem[]): Promise<void>
}

const EXEC_BUFFER_BYTES = 1024 * 1024

const defaultExec: TExec = promisify(exec) as unknown as TExec

const defaultFetchHtml: TFetchHtml = async (query) => {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  })
  if (!response.ok) throw new Error(`DuckDuckGo answered ${response.status}`)
  return response.text()
}

/**
 * O toolset embutido do gateway.
 *
 * Existe para que o gateway continue útil sem nenhum MCP server no ar — foi a falta
 * disso que motivou o revert da primeira tentativa de MCP real. Cada Agents SDK
 * registra estas mesmas implementações no seu próprio formato.
 */
export function makeLocalTools(deps: ILocalToolDeps = {}): ILocalTool[] {
  const run = deps.exec ?? defaultExec
  const fetchHtml = deps.fetchHtml ?? defaultFetchHtml
  const policy = deps.policy ?? bashPolicy()
  const sandbox = deps.sandbox ?? projectSandbox()

  /**
   * ⛔ O TERMINAL COM PERMISSÕES, em duas travas:
   * 1. a ANÁLISE: cada comando da linha (`git status; rm -rf x` são dois) passa pela regra de terminal, e cada
   *    redirecionamento pela de leitura ou escrita; o que não dá para analisar (`eval`, nome vindo de variável) é negado;
   * 2. o CERCO montado das mesmas regras (`Cerco.Plan`): o que rodou só lê e grava o que elas liberam — um `node -e`
   *    lendo o `.env` falha no sistema operacional —, e a rede só sai pela porta do gateway, destino a destino.
   * Vale para TODO agente; sem cerco no servidor, o terminal fica bloqueado.
   */
  async function guardedBash(command: string, context: IExecutionContext | undefined, permissions: IPermissionChecker): Promise<IToolResult> {
    const asker = askerOf(context)
    const root = realOf(context?.projectId ? workspaceFor(context.projectId, '') : policy.cwd || workspaceFor(undefined, context?.sessionId ?? 'run_bash'))
    const refusal = await terminalRefusal(command, root, permissions, asker)
    if (refusal) return { status: 'error', result: `Not permitted: ${refusal}` }
    if (!sandbox.wrapWith) return { status: 'error', result: 'O terminal fica bloqueado: este servidor não monta o cerco das permissões.' }
    const { system, ...layers } = permissions.layers?.(asker) ?? { system: [] }
    const gate = networkGate()
    const token = gate.register((host, port) => permissions.check(asker, { category: 'network', value: `${host}:${port}` }, { log: true }))
    try {
      let line: string
      try {
        line = await sandbox.wrapWith(command, root, (base) => cercoPlan(layers, { ...base, system }), token)
      } catch (error: unknown) {
        return { status: 'error', result: `${toMessage(error)}. O terminal fica bloqueado até o cerco funcionar.` }
      }
      const { stdout, stderr } = await run(line, {
        cwd: root,
        timeout: policy.timeoutMs,
        maxBuffer: EXEC_BUFFER_BYTES,
        env: subscriptionEnv({ HOME: root }),
        shell: SANDBOX_SHELL,
      })
      return { status: 'success', result: truncate(stdout || stderr || 'Command executed successfully with no output.', policy.maxOutputChars) }
    } catch (error: unknown) {
      // A linha embrulhada (a política do cerco) não interessa a quem lê; a saída de erro, sim.
      const failure = error as { stderr?: string; stdout?: string; code?: number }
      const output = [failure.stdout?.trim(), failure.stderr?.trim()].filter(Boolean).join('\n')
      if (output) return { status: 'error', result: truncate(`Exit code ${failure.code ?? 1}: ${output}`, policy.maxOutputChars) }
      return { status: 'error', result: `Execution failed: ${toMessage(error)}` }
    } finally {
      gate.release(token)
    }
  }

  return [
    {
      origin: 'local',
      name: 'search_web',
      description: 'Searches the internet for up-to-date information.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query' } },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args): Promise<IToolResult> {
        const query = String(args.query ?? '').trim()
        if (!query) return { status: 'error', result: 'search_web requires a non-empty query.' }

        try {
          return { status: 'success', result: parseResults(await fetchHtml(query)) }
        } catch (error: unknown) {
          return { status: 'error', result: `Search failed: ${toMessage(error)}` }
        }
      },
    },
    {
      origin: 'local',
      name: 'run_bash',
      description: 'Executes a bash command on the host system.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The bash command to run' } },
        required: ['command'],
        additionalProperties: false,
      },
      async execute(args, context): Promise<IToolResult> {
        const command = String(args.command ?? '')

        const denied = denyReason(command)
        if (denied) {
          return { status: 'error', result: `Refused by the gateway tool policy: ${denied}.` }
        }
        if (deps.permissions) return guardedBash(command, context, deps.permissions)

        // ⛔ Agente de projeto: o comando roda PRESO à pasta do projeto, ou não roda (sem cerco, recusa).
        let line = command
        if (context?.projectId) {
          try {
            line = await sandbox.wrap(command, context.projectId)
          } catch (error: unknown) {
            return { status: 'error', result: `${toMessage(error)}. O run_bash de agente de projeto fica bloqueado até o cerco funcionar.` }
          }
        }

        try {
          // ⛔ Ambiente MÍNIMO: o shell herdava o `process.env` inteiro — chaves de API, `AUTH_SECRET`,
          // `SECRETS_KEY` —, e um `env` bastava para levar tudo. E o `cwd` é o diretório vazio da conversa —
          // ou, no agente de projeto, a pasta do projeto (que vence o `BASH_CWD`: é nela que o cerco deixa gravar).
          const cwd = context?.projectId ? workspaceFor(context.projectId, '') : policy.cwd || workspaceFor(undefined, context?.sessionId ?? 'run_bash')
          const { stdout, stderr } = await run(line, {
            cwd,
            timeout: policy.timeoutMs,
            maxBuffer: EXEC_BUFFER_BYTES,
            env: subscriptionEnv({ HOME: cwd }),
            ...(context?.projectId ? { shell: SANDBOX_SHELL } : {}),
          })
          const output = stdout || stderr || 'Command executed successfully with no output.'
          return { status: 'success', result: truncate(output, policy.maxOutputChars) }
        } catch (error: unknown) {
          // Comando cercado: a linha embrulhada (a política do cerco) não interessa a quem lê; a saída de erro, sim.
          const failure = error as { stderr?: string; code?: number }
          if (context?.projectId && failure.stderr) return { status: 'error', result: truncate(`Exit code ${failure.code ?? 1}: ${failure.stderr.trim()}`, policy.maxOutputChars) }
          return { status: 'error', result: `Execution failed: ${toMessage(error)}` }
        }
      },
    },
    // Os arquivos na MESMA pasta do `run_bash`: a do projeto, ou a da conversa (ou o `BASH_CWD`).
    ...makeFileTools({
      rootFor: (context) => (context?.projectId ? workspaceFor(context.projectId, '') : policy.cwd || workspaceFor(undefined, context?.sessionId ?? 'files')),
      ...(deps.permissions
        ? {
            access: (context, kind, path, log) => {
              const verdict = deps.permissions!.check(askerOf(context), { category: kind, value: path }, { log })
              return verdict.allowed ? undefined : verdict.reason
            },
          }
        : {}),
    }),
    ...(deps.docs ? [readDocTool(deps.docs)] : []),
    ...(deps.docs?.searchDocs ? [searchDocsTool(deps.docs)] : []),
    ...(deps.skills ? [useSkillTool(deps.skills, deps.permissions)] : []),
    ...(deps.drafts ? [proposeDraftTool(deps.drafts)] : []),
    ...(deps.todos?.saveTodos ? [updateTodosTool(deps.todos)] : []),
  ]
}

/**
 * A primeira trava do terminal: o motivo da negação, ou nada se cada parte da linha é permitida. Registra cada decisão.
 * Redirecionamento: o caminho canônico, relativo à pasta de trabalho (ou absoluto, se fora dela).
 */
export async function terminalRefusal(command: string, root: string, permissions: IPermissionChecker, asker: IPermissionAsker): Promise<string | undefined> {
  const analysis = await analyzeShell(command)
  if (analysis.opaque.length) return `não dá para analisar com segurança (${analysis.opaque.join('; ')})`
  if (!analysis.commands.length && !analysis.redirects.length) return 'nenhum comando'
  for (const part of analysis.commands) {
    const verdict = permissions.check(asker, { category: 'terminal', value: part.text, argv: part.argv }, { log: true })
    if (!verdict.allowed) return verdict.reason
  }
  for (const redirect of analysis.redirects) {
    const verdict = permissions.check(asker, { category: redirect.kind, value: workPath(root, redirect.target) }, { log: true })
    if (!verdict.allowed) return verdict.reason
  }
  return undefined
}

function workPath(root: string, target: string): string {
  if (target.startsWith('~')) return target
  const abs = realOf(resolve(root, target))
  const rel = relative(root, abs)
  return rel === '' ? '.' : !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs
}

/**
 * `update_todos`: a lista de tarefas da conversa, trocada inteira a cada chamada (o formato que os modelos já conhecem do
 * TodoWrite, sem estado parcial). Grava na conversa — a tela mostra — e devolve a lista, para o modelo ver o estado.
 */
function updateTodosTool(store: ITodoStore): ILocalTool {
  return {
    origin: 'local',
    name: UPDATE_TODOS_TOOL,
    description:
      'Keeps the task list of this conversation, which the person sees next to the chat. Use it for work with 3 or more steps: write the full list at the start, keep exactly one item in_progress while you work on it, and mark it done as soon as it is finished (send the whole list every time). Skip it for simple requests.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'The whole list, in order.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'The task, short and concrete.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] },
            },
            required: ['title', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      if (!context?.sessionId) return { status: 'error', result: `${UPDATE_TODOS_TOOL} only works inside a conversation.` }
      const issues = todoIssues(args.items)
      if (issues.length) return { status: 'error', result: `Not saved — fix and call again: ${issues.join('; ')}` }
      const items = (args.items as ITodoItem[]).map((item) => ({ title: item.title.trim(), status: item.status }))
      try {
        await store.saveTodos!(context.sessionId, items)
      } catch (error: unknown) {
        return { status: 'error', result: `Could not save the task list: ${toMessage(error)}` }
      }
      return { status: 'success', result: todoText(items) }
    },
  }
}

/**
 * `propose_draft`: o construtor entrega o rascunho. ⛔ NÃO GRAVA: confere com as regras do cadastro e devolve os
 * problemas ao modelo (para ele corrigir) ou o aceite. A tela lê o rascunho dos argumentos da chamada e a pessoa salva.
 * O tipo vem do agente (o construtor de skills só propõe skill); outro agente não tem o que propor.
 */
function proposeDraftTool(drafts: IDraftChecker): ILocalTool {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  return {
    origin: 'local',
    name: PROPOSE_DRAFT_TOOL,
    description:
      'Hands the draft to the person, who reviews it next to the conversation. Nothing is saved by this tool. It checks the draft with the same rules as saving and returns the problems field by field: fix them and call it again. Fields by kind — rule: title, body; spec/adr/knowledge: id, title, summary, body; skill/command: id, description, body, docIds; agent: agent (the record exactly as save_agent takes it), initialContext, resources.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'spec/adr/skill/command: slug of lowercase letters, digits or hyphens. An existing id of the same kind means adjusting it.' },
        title: { type: 'string', description: 'rule/spec/adr: the short title.' },
        summary: { type: 'string', description: 'spec/adr: one line — what shows in the conversation index.' },
        description: { type: 'string', description: 'skill/command: one concrete line — what it does and when to use it.' },
        body: { type: 'string', description: 'The body, following the protocol (markdown; a rule is one or two imperative sentences).' },
        docIds: { type: 'array', items: { type: 'string' }, description: 'skill/command: specs and ADRs to attach (ids from the document index).' },
        global: { type: 'boolean', description: 'true = global (all projects). Default: the project of the conversation.' },
        agent: {
          type: 'object',
          description:
            'agent: the record exactly as save_agent takes it (id, name, soul, systemPrompt, providers, modes, reasoningEfforts, allowedTools, role, adminOnly, projectId).',
        },
        initialContext: { type: 'array', items: { type: 'string' }, description: 'agent: spec ids it loads in full, in order (set_agent_initial_context).' },
        resources: { type: 'object', description: 'agent: { skills, commands } — ids, ["*"] = all, [] = none (set_agent_resources). Absent = the default (all).' },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const kind = builderKindOf(context?.agentId)
      if (!kind) return { status: 'error', result: `${PROPOSE_DRAFT_TOOL} is only for the core builder.` }
      const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)
      const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : undefined)
      if (kind === 'agent') {
        if (!drafts.agentDraftIssues) return { status: 'error', result: 'Agent drafts are not available here.' }
        const resources = record(args.resources)
        const draft = {
          kind,
          agent: record(args.agent),
          initialContext: ids(args.initialContext),
          ...(resources ? { resources: { skills: ids(resources.skills), commands: ids(resources.commands) } } : {}),
        }
        const checked = await drafts.agentDraftIssues(draft)
        if (checked.issues.length)
          return { status: 'error', result: `The draft has problems — fix and call again:\n${checked.issues.map((issue) => `- ${issue.field}: ${issue.message}`).join('\n')}` }
        return {
          status: 'success',
          result: `Draft delivered (${checked.updates ? `adjusts the existing agent ${checked.id}` : `new agent ${checked.id}`}, ${checked.projectId ? `project ${checked.projectId}` : 'global'}). Nothing was saved: the person reviews it next to the conversation. Save it only after they confirm here.`,
        }
      }
      if (typeof args.body !== 'string') return { status: 'error', result: 'The draft has problems — fix and call again:\n- body: required' }
      const draft = {
        kind,
        id: text(args.id),
        title: text(args.title),
        summary: text(args.summary),
        description: text(args.description),
        body: text(args.body),
        docIds: Array.isArray(args.docIds) ? args.docIds.filter((id): id is string => typeof id === 'string') : undefined,
        global: args.global === true,
      }
      const { issues, updates, id, projectId } = drafts.draftIssues(draft, context?.conversationProjectId)
      if (issues.length)
        return { status: 'error', result: `The draft has problems — fix and call again:\n${issues.map((issue) => `- ${issue.field}: ${issue.message}`).join('\n')}` }
      const scope = projectId ? `project ${projectId}` : 'global'
      const what = updates ? `adjusts the existing ${kind} ${id}` : `new ${kind}${id ? ` ${id}` : ''}`
      return {
        status: 'success',
        result: `Draft delivered (${what}, ${scope}). Nothing was saved: the person reviews it next to the conversation. Save it only after they confirm here.`,
      }
    },
  }
}

/**
 * `use_skill`: a skill inteira (e os documentos anexados a ela), das que o índice "## Skills" do prompt lista.
 * ⛔ Só uma skill liberada a ESTE agente (o `agentId` do contexto); outra responde como inexistente.
 */
function useSkillTool(skills: ISkillLoader, permissions?: IPermissionChecker): ILocalTool {
  return {
    origin: 'local',
    name: USE_SKILL_TOOL,
    description:
      'Loads the full instructions of a skill listed under "Skills" in your instructions, by its id, with the documents attached to it. Load it before doing what the skill covers.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The skill id, as listed' } },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const verdict = id ? permissions?.check(askerOf(context), { category: 'skill', value: id }, { log: true }) : undefined
      if (verdict && !verdict.allowed) return { status: 'error', result: `Not permitted: ${verdict.reason}` }
      const skill = id ? skills.loadSkill(id, context?.agentId) : undefined
      if (!skill) return { status: 'error', result: `Skill not found: ${id || '(no id)'}` }
      return { status: 'success', result: skill }
    },
  }
}

/**
 * `search_docs`: acha documentos pelo ASSUNTO — no título, no resumo e no texto —, com o trecho que casou. O índice do
 * prompt só tem título e resumo (e, com muitos documentos, só os recentes): é por aqui que o agente chega no resto.
 * ⛔ Só os globais e os do projeto da conversa, como o `read_doc`.
 */
function searchDocsTool(docs: IDocReader): ILocalTool {
  return {
    origin: 'local',
    name: SEARCH_DOCS_TOOL,
    description:
      'Searches the reference documents (specs, ADRs and knowledge studies) by subject — in the title, the summary and the full text — and returns the best matches with the excerpt that matched. Then read one in full with read_doc.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words about the subject, in any order (accents optional)' },
        kind: { type: 'string', description: 'Optional: only spec, adr or knowledge' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) return { status: 'error', result: 'search_docs requires a non-empty query.' }
      const kind = DOC_KINDS.find((item) => item === args.kind)
      const hits = docs.searchDocs!(query, context?.conversationProjectId, kind)
      if (!hits.length) return { status: 'success', result: `No document matches "${query}".` }
      return {
        status: 'success',
        result: hits.map((hit) => `- [${hit.kind}] ${hit.id} — ${hit.title}${hit.summary ? `: ${hit.summary}` : ''}\n  …${hit.excerpt}…`).join('\n'),
      }
    },
  }
}

/**
 * `read_doc`: o documento inteiro (markdown) de uma spec ou ADR do índice que a conversa recebeu no prompt.
 * ⛔ Só o global ou o do projeto da conversa; o de outro projeto responde como inexistente.
 */
function readDocTool(docs: IDocReader): ILocalTool {
  return {
    origin: 'local',
    name: READ_DOC_TOOL,
    description: 'Reads the full markdown of a spec or ADR listed under "Documentos de referência" in your instructions, by its id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The document id, as listed' } },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const doc = id ? docs.readDoc(id, context?.conversationProjectId) : undefined
      if (!doc) return { status: 'error', result: `Document not found: ${id || '(no id)'}` }
      return { status: 'success', result: `# ${doc.title} [${doc.kind}]\n\n${doc.body}` }
    },
  }
}

/** O HTML do DuckDuckGo é estável o bastante para os cinco primeiros resultados. */
function parseResults(html: string): string {
  const results: string[] = []
  const blocks = html.split('result__body').slice(1, 6)

  for (const block of blocks) {
    const title = stripTags(match(block, /class="result__a"[^>]*>([\s\S]*?)<\/a>/))
    const snippet = stripTags(match(block, /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/))
    if (title && snippet) results.push(`Title: ${title}\nSnippet: ${snippet}`)
  }

  return results.join('\n\n') || 'No results found.'
}

function match(source: string, pattern: RegExp): string {
  return pattern.exec(source)?.[1] ?? ''
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
