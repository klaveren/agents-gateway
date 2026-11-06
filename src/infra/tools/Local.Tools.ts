import { applyPanelOp, IConversationPanel, PANEL_TOOL, panelMarkdown, TPanelOp } from '@domain/models/ConversationPanel.Model'
import { printsSecret } from '@domain/models/ResourceSecret.Model'
import { terminalEnv } from '@domain/Agent.Identity'
import type { IPermissionAsker, IPermissionChecker } from '@application/Permissions.Service'
import { cercoPlan } from '@domain/Cerco.Plan'
import { commandMatches, type IPermissionRule } from '@domain/Permission.Policy'
import type { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { exec } from 'node:child_process'
import { rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { networkGate } from '@infra/permissions/Network.Gate'
import { analyzeShell } from '@infra/permissions/Shell.Parse'
import { bashPolicy, COMMAND_REASONS, deniedReasons, PRIVILEGE_ESCALATION, realReasons, truncate, type IBashPolicy } from './Bash.Guard'
import { subscriptionEnv, workspaceFor } from '@infra/adapters/support/Subscription.Workspace'
import { projectAliases } from '@infra/workspace/Work.Folder'
import { accountsDir, ISshKitIdentity, removeSshKit, writeSshKit } from '@infra/accounts/Ssh.Kit'
import { CLUSTER_SECRET_REFUSAL, dumpsClusterSecret } from '@domain/Secret.Mask'
import { BACKGROUND_LIMITS, BackgroundProcesses, backgroundProcesses, clipOutput, startCommand, tailOf } from './Background.Processes'
import { IProjectSandbox, projectSandbox, SANDBOX_SHELL } from '@infra/sandbox/Project.Sandbox'
import { DOC_KINDS, IProjectDoc, READ_DOC_TOOL, SEARCH_DOCS_TOOL, TDocKind, TDocStatus } from '@domain/models/ProjectDoc.Model'
import { IDocHit } from '@domain/ports/GuidanceRepository.Port'
import { AGENT_TRIGGER_TOOL, SEARCH_RESOURCES_TOOL, TUsableKind, USABLE_KINDS, USE_RESOURCE_TOOL } from '@domain/models/Resource.Model'
import type { IAgentTrigger } from '@domain/models/Agent.Model'
import { IBuilderDraft } from '@domain/models/Protocol.Model'
import { builderKindOf, PROPOSE_DRAFT_TOOL } from '@domain/Builder.Agents'
import { ITodoItem, todoIssues, todoText, UPDATE_TODOS_TOOL } from '@domain/models/ConversationTodo.Model'
import { type IOwnFolder, makeFileTools, realOf } from './File.Tools'
import type { IEditDiagnostics } from './Edit.Diagnostics'
import type { IAgentDiagnostics } from '@domain/models/Agent.Model'
import { ILocalTool, IToolResult } from './Tool.Types'
import { IImportDesk, IRepositoryBrowser, makeImportTools } from './Import.Tools'

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
  /**
   * O documento que o agente lê pelo anexo, e por onde (ver `GuidanceService.attachedDoc`): anexado a uma skill ou
   * command que ele pode carregar, ou a um documento que ele já pode ler (`doc`).
   */
  attachedDoc?(id: string, agentId?: string, projectId?: string): { doc: IProjectDoc; via: Array<{ kind: 'skill' | 'command' | 'doc'; id: string }> } | undefined
  /** O texto que o agente recebe: o documento e os anexos dele (ver `GuidanceService.docText`). Ausente = só o documento. */
  docText?(doc: IProjectDoc): string
  /** A busca de texto (ver `GuidanceService.searchDocs`). Ausente = sem `search_docs`. */
  searchDocs?(query: string, projectId?: string, kind?: TDocKind): IDocHit[]
}

/** Quem confere o rascunho do construtor sem gravar (o `GuidanceService`). */
export interface IDraftChecker {
  draftIssues(draft: IBuilderDraft, projectId?: string): { issues: Array<{ field: string; message: string }>; updates: boolean; id?: string; projectId?: string }
  /** O rascunho de agente (assíncrono: confere o registro com as regras do cadastro). Ausente = sem rascunho de agente. */
  agentDraftIssues?(draft: IBuilderDraft): Promise<{ issues: Array<{ field: string; message: string }>; updates: boolean; id?: string; projectId?: string }>
}

/** Quem carrega e busca os recursos do agente: skills, commands e triggers (o `GuidanceService`). */
export interface IResourceLoader {
  loadResource(kind: TUsableKind, id: string, agentId?: string): string | undefined
  searchResources?(query: string, kind: TUsableKind | undefined, agentId?: string): Array<{ kind: TUsableKind; id: string; description: string }>
  /** O tipo de um recurso pelo id (para o trigger `<recurso>/<trigger>` passar pela regra da skill dona). */
  resourceKindOf?(id: string): 'skill' | 'command' | undefined
}

/** Onde moram os triggers dos agentes (o catálogo de agentes). */
export interface ITriggerStore {
  /** Os triggers do agente; `undefined` = agente que não existe (ou de fábrica, que não se edita). */
  triggersOf(agentId: string): IAgentTrigger[] | undefined
  /** Grava a lista inteira; lança com os problemas quando ela não passa pela regra. */
  saveTriggers(agentId: string, triggers: IAgentTrigger[], by: string): void
  /**
   * O trigger veio de uma fonte do repositório (`importedFrom`): o Importador do projeto do agente marca o item como
   * importado (ver `ImportJobService.markImported`). Lança com o motivo; ausente = sem a marca.
   */
  markImported?(agentId: string, triggerId: string, source: { path: string; repository?: string }, who: { agentId?: string; conversationId?: string }): void
}

export interface ILocalToolDeps {
  exec?: TExec
  fetchHtml?: TFetchHtml
  policy?: IBashPolicy
  /** O cerco do agente de projeto (ver `Project.Sandbox`). Ausente = o do processo. */
  sandbox?: IProjectSandbox
  /** Os triggers dos agentes, para o `agent_trigger`. Ausente = sem a ferramenta. */
  triggers?: ITriggerStore
  /** Os recursos do agente (skills, commands, triggers). Ausente = sem `use_resource` nem `search_resources`. */
  resources?: IResourceLoader
  /** Os documentos (specs e ADRs). Ausente = sem `read_doc`. */
  docs?: IDocReader
  /** O conferente dos rascunhos do construtor. Ausente = sem `propose_draft`. */
  drafts?: IDraftChecker
  /** O modo importação do construtor (ver `Import.Tools`). Ausente = sem as ferramentas de importação. */
  imports?: IImportDesk
  /** A leitura do repositório pelo construtor fora do Importador (ver `Import.Tools`). Ausente = só o do Importador lê. */
  repositoryBrowse?: IRepositoryBrowser
  /** Onde fica a lista de tarefas da conversa (o repositório de conversas). Ausente = sem `update_todos`. */
  todos?: ITodoStore
  /** O painel da conversa (ver `ConversationPanel.Model`) e o turno em curso de cada conversa. Ausente = sem a ferramenta. */
  panels?: {
    get(sessionId: string): Promise<IConversationPanel>
    save(sessionId: string, panel: IConversationPanel): Promise<void>
    turnOf?(sessionId: string): number | undefined
  }
  /** As permissões dos agentes (ver `Permission.Policy`). Ausente = sem regras (só as travas fixas valem). */
  permissions?: IPermissionChecker
  /** As variáveis de ambiente fixas de cada agente (o campo `env` dele). Ausente = nenhuma. */
  agentEnv?: (agentId: string) => Readonly<Record<string, string>> | undefined
  /** O tempo e a saída do terminal de cada agente (o campo `terminal` dele). Ausente = o global. */
  agentTerminal?: (agentId: string) => { timeoutSeconds?: number; maxOutputChars?: number } | undefined
  /** ⛔ A pasta privada do agente e o que ele faz nela (ver `agentFolderAccess`): a ferramenta de arquivo e o cerco a abrem. */
  agentFolder?: (agentId: string) => IOwnFolder | undefined
  /** Os processos em segundo plano (ver `Background.Processes`). Ausente = o do processo. */
  processes?: BackgroundProcesses
  /** A máscara de segredos (ver `Secret.Masker`). Ausente = a saída vai como saiu. */
  mask?: ILocalMask
  /**
   * ⛔ As variáveis secretas do agente e das skills e commands carregados (ver `ResourceSecrets.Service`): o valor entra no
   * ambiente do comando, nunca na linha dele. Ausente = sem variáveis.
   */
  secrets?: {
    envFor(agentId: string | undefined, sessionId: string | undefined): { env: Record<string, string> }
    sources(agentId: string | undefined, sessionId: string | undefined): Array<{ name: string }>
    markLoaded(sessionId: string | undefined, kind: 'skill' | 'command', id: string): void
  }
  /** O detector de laço (ver `Loop.Guard`): recusa a chamada repetida antes de ela rodar. Ausente = sem detector. */
  loops?: { check(sessionId: string | undefined, tool: string, args: unknown): string | undefined }
  /** O diagnóstico depois de editar (ver `Edit.Diagnostics`): vai junto do `write_file`/`edit_file`. Ausente = nenhum. */
  diagnostics?: IEditDiagnostics
  /** O diagnóstico de cada agente (o campo `diagnostics` dele). Ausente = desligado. */
  agentDiagnostics?: (agentId: string) => IAgentDiagnostics | undefined
  /** As contas do projeto que vão para cada comando (ver `ProjectAccounts.Service`). Ausente = nenhuma. */
  accounts?: {
    commandEnv(projectId: string, allowed: (id: string) => boolean): Promise<{ env: Record<string, string>; problems: string[]; ssh?: ISshKitIdentity[] }>
    /** A assinatura com a chave SSH importada (`ssh_sign`). Ausente = sem a ferramenta. */
    sign?(projectId: string, id: string, namespace: string, data: string): Promise<string>
  }
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
/** As ferramentas que editam arquivo: as que ganham o diagnóstico. */
const EDIT_TOOLS = new Set(['write_file', 'edit_file'])

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
  const processes = deps.processes ?? backgroundProcesses()

  /**
   * ⛔ O TERMINAL COM PERMISSÕES, em duas travas:
   * 1. a ANÁLISE: cada comando da linha (`git status; rm -rf x` são dois) passa pela regra de terminal, e cada
   *    redirecionamento pela de leitura ou escrita; o que não dá para analisar (`eval`, nome vindo de variável) é negado;
   * 2. o CERCO montado das mesmas regras (`Cerco.Plan`): o que rodou só lê e grava o que elas liberam — um `node -e`
   *    lendo o `.env` falha no sistema operacional —, e a rede só sai pela porta do gateway, destino a destino.
   * Vale para TODO agente; sem cerco no servidor, o terminal fica bloqueado.
   */
  // Os arquivos na MESMA pasta do `run_bash`: a do projeto, ou a da conversa (ou o `BASH_CWD`).
  const fileRoot = (context?: IExecutionContext) =>
    context?.workFolder?.dir ?? (context?.projectId ? workspaceFor(context.projectId, '') : policy.cwd || workspaceFor(undefined, context?.sessionId ?? 'files'))
  const masked = (text: string, context: IExecutionContext | undefined) => (deps.mask ? deps.mask.text(text, context?.sessionId) : text)

  /** As variáveis fixas do agente que chama (ver `IAgent.env`). */
  function envOf(context: IExecutionContext | undefined): Readonly<Record<string, string>> | undefined {
    return context?.agentId ? deps.agentEnv?.(context.agentId) : undefined
  }

  /** O tempo e a saída deste agente (o campo `terminal` dele), ou o global. */
  function terminalOf(context: IExecutionContext | undefined): { timeoutMs: number; maxOutputChars: number } {
    const own = context?.agentId ? deps.agentTerminal?.(context.agentId) : undefined
    return {
      timeoutMs: own?.timeoutSeconds ? own.timeoutSeconds * 1000 : policy.timeoutMs,
      maxOutputChars: own?.maxOutputChars ?? policy.maxOutputChars,
    }
  }

  /**
   * O comando pronto para rodar CERCADO: a análise por partes, o cerco das regras, as contas do projeto e o token de rede.
   * ⛔ Quem recebe é dono de chamar `release` quando o processo sair (o token morre, o kit SSH sai).
   */
  async function prepareSandboxed(command: string, context: IExecutionContext | undefined, permissions: IPermissionChecker): Promise<IPrepared | IToolResult> {
    const asker = askerOf(context)
    const folder = context?.workFolder
    const root = realOf(folder?.dir ?? (context?.projectId ? workspaceFor(context.projectId, '') : policy.cwd || workspaceFor(undefined, context?.sessionId ?? 'run_bash')))
    // O rascunho (HOME, caches, as contas) fica na pasta do projeto, fora da worktree; o `.git` comum entra no cerco.
    const own = context?.agentId ? deps.agentFolder?.(context.agentId) : undefined
    const place: { scratchBase?: string; gitCommonDir?: string; worktreeGitDir?: string; agentFolder?: IOwnFolder } = {
      ...(folder
        ? {
            scratchBase: realOf(folder.projectDir),
            ...(folder.gitCommonDir ? { gitCommonDir: realOf(folder.gitCommonDir) } : {}),
            ...(folder.worktreeGitDir ? { worktreeGitDir: realOf(folder.worktreeGitDir) } : {}),
          }
        : {}),
      ...(own ? { agentFolder: { ...own, dir: realOf(own.dir) } } : {}),
    }
    const refusal = await terminalRefusal(command, root, permissions, asker, folder)
    if (refusal) return { status: 'error', result: `Not permitted: ${refusal}` }
    if (!sandbox.wrapWith) return { status: 'error', result: 'O terminal fica bloqueado: este servidor não monta o cerco das permissões.' }
    const { system, ...layers } = permissions.layers?.(asker) ?? { system: [] }
    // Os serviços locais que as regras liberam EXATOS (`localhost:27017`): no Linux, um encaminhador por porta.
    const localPorts = [...(layers.agent ?? []), ...(layers.project ?? [])]
      .filter((rule) => rule.category === 'network' && rule.decision === 'allow')
      .map((rule) => /^(?:localhost|127\.0\.0\.1):(\d{1,5})$/.exec(rule.pattern.trim())?.[1])
      .filter((port): port is string => !!port)
      .map(Number)
      // ⛔ A porta do próprio gateway nunca ganha encaminhador (o portão também a nega): o cliente recebe a recusa.
      .filter((port) => port !== (Number(process.env.PORT) || 3000))
    // TCP fora do HTTP liberado por regra EXATA (`10.10.0.1:32017`): o comando ganha o interceptador (ver `tcpInterceptor`).
    const tcp = [...(layers.agent ?? []), ...(layers.project ?? [])].some((rule) => rule.category === 'network' && rule.decision === 'allow' && exactTcpTarget(rule.pattern))
    // ⛔ As contas do projeto DA CONVERSA que este agente pode usar (`account <id>`), em variáveis do processo — nunca na
    // linha do comando, que aparece na lista de processos.
    const accounts =
      asker.projectId && deps.accounts ? await deps.accounts.commandEnv(asker.projectId, (id) => permissions.check(asker, { category: 'account', value: id }).allowed) : undefined
    // ⛔ O que as contas entregaram a ESTE comando passa a ser mascarado em tudo o que a conversa mostra e grava.
    if (accounts && context?.sessionId)
      deps.mask?.register(context.sessionId, [
        ...Object.entries(accounts.env)
          .filter(([name]) => !name.startsWith('GIT_CONFIG_'))
          .map(([name, value]) => ({ value, label: name })),
        ...(accounts.ssh ?? []).map((identity) => ({ value: identity.privateKey, label: `ssh ${identity.id}` })),
      ])
    const literal = deps.mask?.literalIn(command, context?.sessionId)
    const notes = [
      ...(accounts?.problems ?? []).map((problem) => `⚠️ ${problem}`),
      ...(literal ? [`⚠️ o comando tem um segredo escrito por extenso (${literal}): use a variável de ambiente, não o valor.`] : []),
    ]
      .map((line) => `${line}\n`)
      .join('')
    const gate = networkGate()
    let sshKit: string | undefined
    let wrapped = false
    let released = false
    const token = gate.register((host, port) => {
      // O portão quer o PADRÃO que liberou: rede local só passa com regra exata (sem `*`).
      const verdict = permissions.check(asker, { category: 'network', value: `${host}:${port}` }, { log: true })
      return { allowed: verdict.allowed, reason: verdict.reason, ...(verdict.rule ? { pattern: verdict.rule.pattern } : {}) }
    })
    // Uma vez só: o processo pode avisar a saída duas vezes (`error` e depois `close`), e a limpeza do cerco conta.
    const release = () => {
      if (released) return
      released = true
      gate.release(token)
      if (sshKit) removeSshKit(sshKit)
      if (wrapped) sandbox.done?.()
    }
    try {
      const line = await sandbox.wrapWith(command, root, (base) => cercoPlan(layers, { ...base, system }), token, { ...place, localPorts, tcp })
      wrapped = true
      // As variáveis do agente por baixo, a identidade de quem chama por cima (ver `Agent.Identity`); as contas do projeto vêm depois.
      // ⛔ As variáveis secretas por cima das contas (a do recurso é mais específica), lidas AGORA: a skill carregada no meio
      // do turno já vale aqui. A máscara as recebe antes do processo nascer.
      const secrets = deps.secrets?.envFor(context?.agentId, context?.sessionId).env
      const env: Record<string, string> = { ...terminalEnv(envOf(context), subscriptionEnv({ HOME: root }), context), ...accounts?.env, ...secrets }
      if (accounts?.ssh?.length) {
        const home = join(place.scratchBase ?? root, '.home')
        sshKit = accountsDir(home, token)
        const { bin } = writeSshKit(sshKit, accounts.ssh, `${process.execPath} ${join(home, '.gateway-connect.cjs')} %h %p`)
        env.PATH = `${bin}:${env.PATH ?? process.env.PATH ?? '/usr/bin:/bin'}`
      }
      return { line, root, env, notes, release, logDir: join(place.scratchBase ?? root, '.cache', 'logs') }
    } catch (error: unknown) {
      release()
      return { status: 'error', result: `${toMessage(error)}. O terminal fica bloqueado até o cerco funcionar.` }
    }
  }

  /** A trava do `Bash.Guard`, com a exceção do sudo remoto liberado por regra explícita (`remoteSudoAllowed`). */
  async function guardRefusal(command: string, context: IExecutionContext | undefined): Promise<string | undefined> {
    const textual = deniedReasons(command)
    // As travas de texto (rm -rf, mkfs…) valem como estão; o sudo e o reboot, só se o comando roda de verdade.
    const plain = textual.find((reason) => !COMMAND_REASONS.has(reason))
    if (plain) return plain
    if (!textual.length) return undefined
    const real = realReasons(await analyzeShell(command), textual)
    if (!real.length) return undefined
    if (real.every((reason) => reason === PRIVILEGE_ESCALATION) && deps.permissions && (await remoteSudoAllowed(command, deps.permissions, askerOf(context)))) return undefined
    return real[0]
  }

  async function guardedBash(command: string, context: IExecutionContext | undefined, permissions: IPermissionChecker, askedSeconds?: number): Promise<IToolResult> {
    const prepared = await prepareSandboxed(command, context, permissions)
    if ('status' in prepared) return prepared
    const limits = terminalOf(context)
    // O modelo pode pedir menos tempo, ou mais até o teto do agente.
    const ceiling = Math.max(limits.timeoutMs, policy.timeoutMs)
    const timeoutMs = askedSeconds && askedSeconds > 0 ? Math.min(askedSeconds * 1000, ceiling) : limits.timeoutMs
    // ⚠️ Pediu mais que o teto: o corte não é calado. Sem o aviso, o agente lia "Tempo esgotado" sem saber que o tempo
    // pedido nem valeu, e repetia (um pre-commit de 40 s morto aos 20 deixou lock órfão no repositório).
    if (askedSeconds && askedSeconds * 1000 > ceiling) prepared.notes += capNotice(askedSeconds, ceiling)
    if (deps.exec) return legacyRun(prepared, timeoutMs, limits.maxOutputChars)
    const id = processes.newId()
    const logFile = join(prepared.logDir, `${id}.log`)
    const result = await startCommand(prepared.line, { cwd: prepared.root, env: prepared.env, shell: SANDBOX_SHELL, timeoutMs, logFile, onExit: prepared.release }).done
    // Mascarado ANTES do corte: um segredo partido no limite escaparia.
    const raw = masked(result.output, context) || (result.timedOut ? '' : 'Command executed successfully with no output.')
    const long = raw.length > limits.maxOutputChars
    if (long && context?.sessionId)
      processes.remember({ id, sessionId: context.sessionId, name: command.slice(0, 80), command, startedAt: new Date(), code: result.code, timedOut: result.timedOut, logFile })
    else rmSync(logFile, { force: true })
    const body = clipOutput(raw, limits.maxOutputChars, long && context?.sessionId ? `o log inteiro: bash_logs id ${id}` : undefined)
    if (result.timedOut)
      return { status: 'error', result: `${prepared.notes}Tempo esgotado (${Math.round(timeoutMs / 1000)}s): o comando e os filhos dele foram parados.\n${body}` }
    if (result.code !== 0) return { status: 'error', result: `${prepared.notes}Exit code ${result.code ?? 1}: ${body.trim()}` }
    return { status: 'success', result: prepared.notes + body }
  }

  /** O caminho do `exec` injetado (os testes): a mesma preparação, a saída de uma vez. */
  async function legacyRun(prepared: IPrepared, timeoutMs: number, maxOutputChars: number): Promise<IToolResult> {
    try {
      const { stdout, stderr } = await run(prepared.line, { cwd: prepared.root, timeout: timeoutMs, maxBuffer: EXEC_BUFFER_BYTES, env: prepared.env, shell: SANDBOX_SHELL })
      // Os avisos ficam fora do corte, como no caminho de verdade (`guardedBash`).
      return { status: 'success', result: prepared.notes + clipOutput(stdout || stderr || 'Command executed successfully with no output.', maxOutputChars) }
    } catch (error: unknown) {
      // A linha embrulhada (a política do cerco) não interessa a quem lê; a saída de erro, sim.
      const failure = error as { stderr?: string; stdout?: string; code?: number }
      const output = [failure.stdout?.trim(), failure.stderr?.trim()].filter(Boolean).join('\n')
      if (output) return { status: 'error', result: prepared.notes + clipOutput(`Exit code ${failure.code ?? 1}: ${output}`, maxOutputChars) }
      return { status: 'error', result: `Execution failed: ${toMessage(error)}` }
    } finally {
      prepared.release()
    }
  }

  /** `bash_start`: o comando em segundo plano, com o mesmo cerco e as mesmas regras do `run_bash`. */
  async function startBackground(command: string, name: string | undefined, context: IExecutionContext | undefined, permissions: IPermissionChecker): Promise<IToolResult> {
    const sessionId = context?.sessionId
    if (!sessionId) return { status: 'error', result: 'bash_start só funciona dentro de uma conversa.' }
    const printing = secretPrintRefusal(command, context, deps.secrets)
    if (printing) return { status: 'error', result: printing }
    if (processes.running(sessionId).length >= BACKGROUND_LIMITS.perSession)
      return { status: 'error', result: `Já há ${BACKGROUND_LIMITS.perSession} processos em segundo plano nesta conversa: pare um com bash_stop.` }
    const prepared = await prepareSandboxed(command, context, permissions)
    if ('status' in prepared) return prepared
    const id = processes.newId()
    const entry = processes.start(sessionId, id, (name ?? command).slice(0, 80), command, prepared.line, {
      cwd: prepared.root,
      env: prepared.env,
      shell: SANDBOX_SHELL,
      logFile: join(prepared.logDir, `${id}.log`),
      onExit: prepared.release,
    })
    return {
      status: 'success',
      result: `${prepared.notes}Iniciado em segundo plano: id ${entry.id} (${entry.name}). Leia com bash_logs id ${entry.id}; pare com bash_stop id ${entry.id}. Vive até 8 h.`,
    }
  }

  const tools: ILocalTool[] = [
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
      description:
        'Executes a bash command in the working folder. Long outputs keep the start and the end (where errors are); the full log is readable with bash_logs. For long jobs (builds, test suites) pass timeoutSeconds; for servers and watchers use bash_start.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run' },
          timeoutSeconds: { type: 'number', description: 'Optional time limit for this command (up to the agent limit)' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      async execute(args, context): Promise<IToolResult> {
        const command = String(args.command ?? '')

        const denied = await guardRefusal(command, context)
        if (denied) {
          return { status: 'error', result: `Refused by the gateway tool policy: ${denied}.` }
        }
        if (dumpsClusterSecret(command)) return { status: 'error', result: CLUSTER_SECRET_REFUSAL }
        const printing = secretPrintRefusal(command, context, deps.secrets)
        if (printing) return { status: 'error', result: printing }
        const asked = Number(args.timeoutSeconds)
        if (deps.permissions) return guardedBash(command, context, deps.permissions, Number.isFinite(asked) ? asked : undefined)

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
            env: terminalEnv(envOf(context), subscriptionEnv({ HOME: cwd }), context),
            ...(context?.projectId ? { shell: SANDBOX_SHELL } : {}),
          })
          const output = stdout || stderr || 'Command executed successfully with no output.'
          return { status: 'success', result: truncate(output, policy.maxOutputChars) }
        } catch (error: unknown) {
          // Comando cercado: a linha embrulhada (a política do cerco) não interessa a quem lê; a saída de erro, sim.
          const failure = error as { stderr?: string; code?: number }
          if (context?.projectId && failure.stderr) return { status: 'error', result: truncate(`Exit code ${failure.code ?? 1}: ${failure.stderr.trim()}`, policy.maxOutputChars) }
          return { status: 'error', result: `Execution failed: ${toMessage(error)}` }
        } finally {
          if (line !== command) sandbox.done?.()
        }
      },
    },
    ...(deps.permissions && !deps.exec ? backgroundTools(processes, (command, name, context) => startBackground(command, name, context, deps.permissions!), guardRefusal) : []),
    ...(deps.accounts?.sign && deps.permissions ? [sshSignTool(deps.accounts.sign.bind(deps.accounts), deps.permissions)] : []),
    ...makeFileTools({
      rootFor: fileRoot,
      ownFolder: (context) => (context?.agentId ? deps.agentFolder?.(context.agentId) : undefined),
      ...(deps.permissions
        ? {
            access: (context, kind, path, log) => {
              // Numa worktree, o mesmo arquivo também a partir da pasta do projeto (ver `projectAliases`).
              const aliases = projectAliases(resolve(fileRoot(context), path), context?.workFolder)
              const verdict = deps.permissions!.check(askerOf(context), { category: kind, value: path, ...(aliases.length ? { aliases } : {}) }, { log })
              return verdict.allowed ? undefined : verdict.reason
            },
          }
        : {}),
    }),
    ...(deps.docs ? [readDocTool(deps.docs, deps.permissions)] : []),
    ...(deps.docs?.searchDocs ? [searchDocsTool(deps.docs)] : []),
    ...(deps.resources ? [useResourceTool(deps.resources, deps.permissions, deps.secrets)] : []),
    ...(deps.resources?.searchResources ? [searchResourcesTool(deps.resources)] : []),
    ...(deps.triggers ? [agentTriggerTool(deps.triggers, deps.permissions)] : []),
    ...(deps.drafts ? [proposeDraftTool(deps.drafts)] : []),
    ...(deps.imports ? makeImportTools(deps.imports, deps.repositoryBrowse) : []),
    ...(deps.todos?.saveTodos ? [updateTodosTool(deps.todos)] : []),
    ...(deps.panels ? [conversationPanelTool(deps.panels)] : []),
  ]
  // ⛔ A chamada repetida é recusada antes de rodar (ver `Loop.Policy`); a edição que deu certo ganha o diagnóstico do
  // pacote (ver `Edit.Diagnostics`); e toda saída passa pela máscara (ver `Secret.Mask`): o `read_file` de uma config, a
  // busca, os logs, a saída do tsc.
  const { mask, loops, diagnostics } = deps
  if (!mask && !loops && !diagnostics) return tools
  return tools.map((tool) => ({
    ...tool,
    async execute(args: Record<string, unknown>, context?: IExecutionContext) {
      const refusal = loops?.check(context?.sessionId, tool.name, args)
      if (refusal) return { status: 'error' as const, result: refusal }
      let outcome = await tool.execute(args, context)
      if (diagnostics && EDIT_TOOLS.has(tool.name) && outcome.status === 'success' && typeof args.path === 'string') {
        const root = fileRoot(context)
        const settings = context?.agentId ? deps.agentDiagnostics?.(context.agentId) : undefined
        const note = await diagnostics.after(resolve(root, args.path), root, settings, context)
        if (note) outcome = { ...outcome, result: `${outcome.result}\n\n${note}` }
      }
      return mask ? { ...outcome, result: mask.text(outcome.result, context?.sessionId) } : outcome
    },
  }))
}

/**
 * A primeira trava do terminal: o motivo da negação, ou nada se cada parte da linha é permitida. Registra cada decisão.
 * Redirecionamento: o caminho canônico, relativo à pasta de trabalho (ou absoluto, se fora dela).
 */
export async function terminalRefusal(
  command: string,
  root: string,
  permissions: IPermissionChecker,
  asker: IPermissionAsker,
  folder?: { dir: string; projectDir: string },
): Promise<string | undefined> {
  const analysis = await analyzeShell(command)
  if (analysis.opaque.length) return `não dá para analisar com segurança (${analysis.opaque.join('; ')})`
  if (!analysis.commands.length && !analysis.redirects.length) return 'nenhum comando'
  for (const part of analysis.commands) {
    const verdict = permissions.check(asker, { category: 'terminal', value: part.text, argv: part.argv }, { log: true })
    if (!verdict.allowed) return verdict.reason
  }
  for (const redirect of analysis.redirects) {
    const aliases = redirect.target.startsWith('~') ? [] : projectAliases(resolve(root, redirect.target), folder)
    const verdict = permissions.check(asker, { category: redirect.kind, value: workPath(root, redirect.target), ...(aliases.length ? { aliases } : {}) }, { log: true })
    if (!verdict.allowed) return verdict.reason
  }
  return undefined
}

/**
 * ⚖️ O `sudo` NO HOST REMOTO (`ssh 10.10.0.1 "sudo k3s kubectl …"`): o `Bash.Guard` recusa o sudo em qualquer ponto da
 * linha, e no cerco o sudo local nem roda. Dentro da string do `ssh` ele passa só com uma regra de terminal que LIBERA e
 * CITA o sudo (`ssh * sudo*k3s kubectl*`), aprovada pela pessoa: o `terminal *` não basta. O local segue recusado.
 */
export async function remoteSudoAllowed(command: string, permissions: IPermissionChecker, asker: IPermissionAsker): Promise<boolean> {
  const analysis = await analyzeShell(command)
  if (analysis.opaque.length) return false
  if (analysis.commands.some((part) => part.name === 'sudo' || part.name === 'doas' || /^\s*(sudo|doas)\b/.test(part.text))) return false
  const layers = permissions.layers?.(asker)
  const rules = [...(layers?.agent ?? []), ...(layers?.project ?? [])].filter((rule) => rule.category === 'terminal' && rule.decision === 'allow' && /\bsudo\b/.test(rule.pattern))
  // Só o ssh com sudo no comando remoto: a palavra num grep ao lado não é escalada (ver `realReasons`).
  const withSudo = analysis.commands.filter((part) => part.name === 'ssh' && part.argv.slice(1).some((word) => /(^|[\s;&|(])sudo(\s|$)/.test(word)))
  if (!withSudo.length) return false
  for (const part of withSudo) if (!(await sshCovered(part.argv, rules))) return false
  return true
}

/**
 * A regra contra o `ssh` com o comando remoto em PALAVRAS (`ssh * sudo k3s kubectl *`). O comando remoto vem logo depois do
 * host, entre aspas (`ssh h "sudo systemctl …; sudo journalctl …"`) ou solto (`ssh h sudo systemctl …`).
 * ⛔ Entre aspas, cada comando com sudo da linha remota precisa da SUA regra (o `*` de uma não engole o outro); sem
 * crase, `$(` nem quebra de linha, e a linha tem de se deixar analisar inteira. ⛔ Solto, o ssh junta as palavras com
 * espaço e o shell remoto relê a linha: só palavras sem nada que ele interprete (aspas, `$`, `*`, `\\`, espaço), para a
 * linha remota ser exatamente a que a regra viu.
 */
async function sshCovered(argv: readonly string[], rules: readonly IPermissionRule[]): Promise<boolean> {
  const at = sshRemoteStart(argv)
  const first = argv[at]
  if (first === undefined) return false
  if (first === 'sudo') return argv.slice(at).every((word) => REMOTE_PLAIN_WORD.test(word)) && rules.some((rule) => commandMatches(rule.pattern, argv))
  if (argv.slice(at + 1).length || /[`\n]|\$\(/.test(first)) return false
  const remote = await analyzeShell(first)
  if (remote.opaque.length) return false
  const prefix = argv.slice(0, at)
  return remote.commands.filter((command) => command.name === 'sudo').every((command) => rules.some((rule) => commandMatches(rule.pattern, [...prefix, ...command.argv])))
}

/** A palavra remota que o shell de lá lê como está. */
const REMOTE_PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/

/** As opções do `ssh` que levam valor na palavra seguinte (`-o BatchMode=yes`, `-p 22`). */
const SSH_VALUE_OPTIONS = /^-[BbcDEeFIiJLlmOoPpQRSWw]$/

/** Onde começa o comando remoto: depois das opções e do host. */
function sshRemoteStart(argv: readonly string[]): number {
  let i = 1
  while (i < argv.length && argv[i]!.startsWith('-')) {
    if (argv[i] === '--') {
      i += 1
      break
    }
    i += SSH_VALUE_OPTIONS.test(argv[i]!) ? 2 : 1
  }
  return i + 1
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
      'Keeps the task list of this conversation, which the person sees next to the chat: the STEPS of the panel item you are working on (the request itself lives in conversation_panel). When an item has 2 or more steps, write its steps at the start, keep exactly one in_progress, and mark each done as soon as it is finished (send the whole list every time). Short steps, a few words each; no prose. Skip it for one-step items.',
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
 * `conversation_panel`: o PAINEL DA CONVERSA (ver `ConversationPanel.Model`) — o agente registra o que a pessoa pede, o
 * andamento, o que entregou (com os links), as decisões e as perguntas. Cada chamada é UMA operação, e a resposta traz o
 * painel inteiro (para o agente se orientar). Quem grava é o agente do turno.
 */
function conversationPanelTool(panels: NonNullable<ILocalToolDeps['panels']>): ILocalTool {
  return {
    origin: 'local',
    name: PANEL_TOOL,
    description:
      'The PANEL of this conversation, which the person sees next to the chat: the goal, what is being done, the queue, what was delivered (with links), decisions and questions for the person. Keep it up to date WITHOUT being asked: split the person message into its distinct requests and `add` ONE item per request (a short title of what was asked; never one generic item bundling several); the steps of an item go in update_todos, not here; when you start it → `update` status doing; when it is delivered → `update` status done with `note` (what was delivered) and `links` (PR, file, conversation); blocked → status blocked with the reason; the person changed course → `set_goal`; something was agreed → `decide`; you need the person → `ask`. Delegated to another agent → `delegatedTo`. `read` returns the whole panel. Its summary comes at the start of every turn — follow it, do not drift.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['read', 'set_goal', 'add', 'update', 'move', 'decide', 'ask', 'answer'] },
        id: { type: 'string', description: 'update/move: the item (p1, p2…); answer: the question (q1…).' },
        goal: { type: 'string', description: 'set_goal: what this conversation wants to achieve, in one or two sentences.' },
        title: { type: 'string', description: 'add/update: the request, short.' },
        detail: { type: 'string', description: 'add/update: more of what was asked.' },
        status: { type: 'string', enum: ['queued', 'doing', 'blocked', 'done', 'dropped'] },
        note: { type: 'string', description: 'update: what was delivered, or why it is blocked or dropped.' },
        links: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' }, href: { type: 'string' } }, required: ['label'], additionalProperties: false },
          description: 'update: where the delivery is (PR url, file path, conversation id).',
        },
        delegatedTo: {
          type: 'object',
          properties: { agentId: { type: 'string' }, sessionId: { type: 'string' } },
          required: ['agentId'],
          additionalProperties: false,
          description: 'add/update: the agent (and its conversation) doing it.',
        },
        before: { type: 'string', description: 'move: put the item before this one (absent = at the end).' },
        text: { type: 'string', description: 'decide/ask: the decision or the question.' },
        why: { type: 'string', description: 'decide: the reason.' },
        answer: { type: 'string', description: 'answer: what the person answered.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      if (!context?.sessionId) return { status: 'error', result: `${PANEL_TOOL} only works inside a conversation.` }
      const sessionId = context.sessionId
      let current: IConversationPanel
      try {
        current = await panels.get(sessionId)
      } catch (error: unknown) {
        return { status: 'error', result: `Could not read the panel: ${toMessage(error)}` }
      }
      if (args.op === 'read') return { status: 'success', result: panelMarkdown(current) }
      const turn = panels.turnOf?.(sessionId)
      try {
        const { panel, changed } = applyPanelOp(current, args as unknown as TPanelOp, { ...(turn !== undefined ? { turn } : {}), by: context.agentId ?? 'agent', now: new Date() })
        await panels.save(sessionId, panel)
        return { status: 'success', result: `Saved: ${changed}\n\n${panelMarkdown(panel)}` }
      } catch (error: unknown) {
        return { status: 'error', result: `Not saved — fix and call again: ${toMessage(error)}` }
      }
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
      'Hands the draft to the person, who reviews it next to the conversation. Nothing is saved by this tool. It checks the draft with the same rules as saving and returns the problems field by field: fix them and call it again. Fields by kind — rule: title, body; spec/adr/knowledge: id, title, summary, body, docIds, docRefs; skill/command: id, description, body, docIds, docRefs; agent: agent (the record exactly as save_agent takes it), initialContext, resources.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'spec/adr/skill/command: slug of lowercase letters, digits or hyphens. An existing id of the same kind means adjusting it.' },
        title: { type: 'string', description: 'rule/spec/adr: the short title.' },
        summary: { type: 'string', description: 'spec/adr: one line — what shows in the conversation index.' },
        description: { type: 'string', description: 'skill/command: one concrete line — what it does and when to use it.' },
        body: { type: 'string', description: 'The body, following the protocol (markdown; a rule is one or two imperative sentences).' },
        docIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'skill/command/spec/adr/knowledge: other documents to attach (ids from the document index) — how a document relates to another, never a path in the text.',
        },
        docRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which of docIds go by reference (listed with id, title and size; read with read_doc only if needed) instead of in full. For large docs.',
        },
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
        docRefs: ids(args.docRefs),
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

/** ⛔ O comando que só mostra uma variável secreta que vale agora (ver `printsSecret`): o motivo da recusa, ou nada. */
function secretPrintRefusal(command: string, context: IExecutionContext | undefined, secrets: ILocalToolDeps['secrets']): string | undefined {
  const names = secrets?.sources(context?.agentId, context?.sessionId).map((source) => source.name) ?? []
  const reason = printsSecret(command, names)
  return reason ? `Recusado: ${reason}. Use a variável no comando ($NOME), nunca a imprima.` : undefined
}

/**
 * `use_resource`: um recurso inteiro, dos que o índice do prompt lista — a skill e o command liberados (com os documentos
 * anexados) ou um trigger do próprio agente. ⛔ Só o que ESTE agente (o `agentId` do contexto) pode usar; o resto responde
 * como inexistente. A skill ainda passa pela regra de permissão `skill`.
 */
function useResourceTool(resources: IResourceLoader, permissions?: IPermissionChecker, secrets?: ILocalToolDeps['secrets']): ILocalTool {
  return {
    origin: 'local',
    name: USE_RESOURCE_TOOL,
    description:
      'Loads, by kind and id, a resource listed in your instructions: a skill (a way of doing something), a command or a trigger (an action you run on demand: one of yours, or one of a loaded skill or command, id `<skill>/<trigger>`). Load it before doing what it covers, and follow it.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...USABLE_KINDS], description: 'skill, command or trigger' },
        id: { type: 'string', description: 'The id, as listed' },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const kind = USABLE_KINDS.find((item) => item === args.kind)
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!kind) return { status: 'error', result: `kind: one of ${USABLE_KINDS.join(', ')}` }
      // ⛔ O trigger de uma skill passa pela regra da skill dona: negada a skill, negados os triggers dela.
      const owner = kind === 'trigger' && id.includes('/') ? id.split('/')[0] : undefined
      const skill = kind === 'skill' ? id : owner && resources.resourceKindOf?.(owner) === 'skill' ? owner : undefined
      if (skill) {
        const verdict = permissions?.check(askerOf(context), { category: 'skill', value: skill }, { log: true })
        if (verdict && !verdict.allowed) return { status: 'error', result: `Not permitted: ${verdict.reason}` }
      }
      const body = id ? resources.loadResource(kind, id, context?.agentId) : undefined
      if (!body) return { status: 'error', result: `${kind} not found: ${id || '(no id)'}` }
      // As variáveis secretas da skill ou do command passam a valer nesta conversa (ver `ResourceSecret.Model`).
      if (kind === 'skill' || kind === 'command') secrets?.markLoaded(context?.sessionId, kind, id)
      return { status: 'success', result: body }
    },
  }
}

/** `search_resources`: acha, por palavras no id e na descrição, o recurso que o agente pode carregar (o índice pode não bastar). */
function searchResourcesTool(resources: IResourceLoader): ILocalTool {
  return {
    origin: 'local',
    name: SEARCH_RESOURCES_TOOL,
    description: 'Finds the skills, commands and triggers you can load, by words in their id and description. Then load one with use_resource.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for (every word must appear)' },
        kind: { type: 'string', enum: [...USABLE_KINDS], description: 'Only this kind (optional)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const query = typeof args.query === 'string' ? args.query : ''
      const kind = USABLE_KINDS.find((item) => item === args.kind)
      const found = resources.searchResources?.(query, kind, context?.agentId) ?? []
      if (!found.length) return { status: 'success', result: 'Nothing found.' }
      return { status: 'success', result: found.map((item) => `- ${item.kind} ${item.id} — ${item.description}`).join('\n') }
    },
  }
}

const TRIGGER_ACTIONS = ['list', 'get', 'create', 'update', 'delete'] as const

/**
 * `agent_trigger`: lista, lê, cria, edita e apaga os triggers de um agente (o próprio, sem `agentId`).
 * ⛔ Cada ação passa pela regra `trigger <id do agente>` — sem regra, negado, inclusive no próprio: um agente que reescreve
 * os próprios triggers muda o próprio comportamento. Sem regras de permissão no servidor, a ferramenta recusa tudo.
 */
function agentTriggerTool(store: ITriggerStore, permissions?: IPermissionChecker): ILocalTool {
  return {
    origin: 'local',
    name: AGENT_TRIGGER_TOOL,
    description:
      "Lists, reads, creates, updates and deletes an agent's triggers (actions run on demand: a name, a one-line 'when' and the procedure). Without agentId it acts on your own. Allowed only where your 'trigger' permission rules allow that agent.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...TRIGGER_ACTIONS], description: 'list, get, create, update or delete' },
        agentId: { type: 'string', description: 'The agent whose triggers to act on. Default: you' },
        id: { type: 'string', description: 'The trigger id (get, create, update, delete): lowercase letters, digits and hyphens' },
        when: { type: 'string', description: 'create/update: one line, when to use it (goes into the agent prompt index)' },
        body: { type: 'string', description: 'create/update: the procedure, in markdown' },
        importedFrom: {
          type: 'object',
          description:
            'create/update: you migrated this trigger from the repository yourself — the source path (the file, as the importer lists it). The importer marks it as imported (by you), and it leaves the queue.',
          properties: { path: { type: 'string' }, repository: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const action = TRIGGER_ACTIONS.find((item) => item === args.action)
      if (!action) return { status: 'error', result: `action: one of ${TRIGGER_ACTIONS.join(', ')}` }
      const target = typeof args.agentId === 'string' && args.agentId.trim() ? args.agentId.trim() : context?.agentId
      if (!target) return { status: 'error', result: 'agentId is required outside an agent conversation.' }
      if (!permissions) return { status: 'error', result: 'Not permitted: this server has no permission rules for triggers.' }
      const verdict = permissions.check(askerOf(context), { category: 'trigger', value: target }, { log: true })
      if (!verdict.allowed) return { status: 'error', result: `Not permitted: ${verdict.reason}` }
      const current = store.triggersOf(target)
      if (!current) return { status: 'error', result: `Agent not found: ${target}` }
      if (action === 'list') return { status: 'success', result: current.length ? current.map((item) => `- ${item.id} — ${item.when}`).join('\n') : 'No triggers.' }
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) return { status: 'error', result: 'id is required.' }
      const existing = current.find((item) => item.id === id)
      if (action === 'get')
        return existing
          ? { status: 'success', result: `# Trigger: ${existing.id}\n\nQuando: ${existing.when}\n\n${existing.body}` }
          : { status: 'error', result: `Trigger not found: ${id}` }
      if (action !== 'create' && !existing) return { status: 'error', result: `Trigger not found: ${id}` }
      if (action === 'create' && existing) return { status: 'error', result: `Trigger already exists: ${id} (use update)` }
      const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
      const next =
        action === 'delete'
          ? current.filter((item) => item.id !== id)
          : action === 'create'
            ? [...current, { id, when: text(args.when)?.trim() ?? '', body: text(args.body) ?? '' }]
            : current.map((item) => (item.id === id ? { id, when: text(args.when)?.trim() ?? item.when, body: text(args.body) ?? item.body } : item))
      try {
        store.saveTriggers(target, next, `agent:${context?.agentId ?? '?'}${context?.sessionId ? ` (conversa ${context.sessionId})` : ''}`)
      } catch (error: unknown) {
        const issues = (error as { issues?: Array<{ message: string }> }).issues
        return { status: 'error', result: issues?.length ? issues.map((issue) => issue.message).join('; ') : toMessage(error) }
      }
      const done = { create: 'Created', update: 'Updated', delete: 'Deleted' }[action]
      // A gravação vale sozinha: se a marca no Importador falhar, a resposta diz por quê.
      const source = args.importedFrom as { path?: unknown; repository?: unknown } | undefined
      let importer = ''
      if (action !== 'delete' && source && typeof source.path === 'string' && source.path.trim()) {
        if (!store.markImported) importer = ' Importer: not marked (the importer is not available here).'
        else
          try {
            store.markImported(
              target,
              id,
              { path: source.path.trim(), ...(typeof source.repository === 'string' && source.repository ? { repository: source.repository } : {}) },
              { ...(context?.agentId ? { agentId: context.agentId } : {}), ...(context?.sessionId ? { conversationId: context.sessionId } : {}) },
            )
            importer = ' Importer: marked as imported.'
          } catch (error: unknown) {
            importer = ` Importer: NOT marked — ${toMessage(error)}`
          }
      }
      return { status: 'success', result: `${done} trigger ${id} of ${target}. It applies to conversations from now on.${importer}` }
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
        result: hits
          .map((hit) => `- [${hit.kind}${hit.status ? ` · ${STATUS_LABEL[hit.status]}` : ''}] ${hit.id} — ${hit.title}${hit.summary ? `: ${hit.summary}` : ''}\n  …${hit.excerpt}…`)
          .join('\n'),
      }
    },
  }
}

/** O status na linha da busca: o substituído e o arquivado aparecem, mas marcados (não aplique). */
const STATUS_LABEL: Readonly<Record<TDocStatus, string>> = { proposed: 'proposta', accepted: 'aceita', superseded: 'SUBSTITUÍDA', archived: 'ARQUIVADA' }

/**
 * `read_doc`: o documento inteiro (markdown) de uma spec ou ADR do índice que a conversa recebeu no prompt.
 * ⛔ Só o global ou o do projeto da conversa; o de outro projeto responde como inexistente — a não ser que esteja
 * anexado a uma skill ou command que ESTE agente pode carregar, ou a um documento que ele já pode ler (a cadeia de
 * anexos, ver `GuidanceService.attachedDoc`). Pela skill, vale ainda a regra de permissão `skill`, como no
 * `use_resource`: o anexo não abre mais do que o recurso, ou o documento pai, carregado entregaria.
 * O texto devolvido traz os anexos do documento (inteiros e por referência).
 */
function readDocTool(docs: IDocReader, permissions?: IPermissionChecker): ILocalTool {
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
      const attached = (docId: string) => {
        const found = docs.attachedDoc?.(docId, context?.agentId, context?.conversationProjectId)
        const open = found?.via.some((item) => item.kind !== 'skill' || !permissions || permissions.check(askerOf(context), { category: 'skill', value: item.id }).allowed)
        return open ? found!.doc : undefined
      }
      const doc = id ? (docs.readDoc(id, context?.conversationProjectId) ?? attached(id)) : undefined
      if (!doc) return { status: 'error', result: `Document not found: ${id || '(no id)'}` }
      return { status: 'success', result: docs.docText ? docs.docText(doc) : `# ${doc.title} [${doc.kind}]\n\n${doc.body}` }
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

/**
 * `ssh_sign`: assina com a chave SSH importada de uma conta do projeto (Projeto → Contas) sem ela entrar no cerco — o
 * formato do `ssh-keygen -Y sign`, para gerar um token ou provar quem pede. ⛔ A permissão `account <id>` decide, e a
 * decisão fica registrada.
 */
function sshSignTool(sign: (projectId: string, id: string, namespace: string, data: string) => Promise<string>, permissions: IPermissionChecker): ILocalTool {
  return {
    origin: 'local',
    name: 'ssh_sign',
    description: 'Signs data with an SSH key of this project (Project → Accounts) without exposing it. Returns the signature in the `ssh-keygen -Y sign` format.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'The id of the SSH key account' },
        namespace: { type: 'string', description: 'The signature namespace (e.g. "git", "file", or the one the verifier expects)' },
        data: { type: 'string', description: 'The exact text to sign' },
      },
      required: ['account', 'namespace', 'data'],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      const asker = askerOf(context)
      const account = String(args.account ?? '').trim()
      const namespace = String(args.namespace ?? '').trim()
      if (!asker.projectId) return { status: 'error', result: 'ssh_sign só funciona numa conversa de projeto.' }
      if (!/^[A-Za-z0-9@._-]{1,64}$/.test(namespace)) return { status: 'error', result: 'namespace: letras, números, @ . _ -' }
      const verdict = permissions.check(asker, { category: 'account', value: account }, { log: true })
      if (!verdict.allowed) return { status: 'error', result: `Not permitted: ${verdict.reason}` }
      try {
        return { status: 'success', result: await sign(asker.projectId, account, namespace, String(args.data ?? '')) }
      } catch (error: unknown) {
        return { status: 'error', result: toMessage(error) }
      }
    },
  }
}

/** O comando cercado e pronto, e quem solta o que ele segura (o token de rede, o kit SSH). */
interface IPrepared {
  line: string
  root: string
  env: Record<string, string>
  notes: string
  release: () => void
  logDir: string
}

/** O aviso do tempo cortado: o que valeu e o caminho para o comando longo. */
export function capNotice(askedSeconds: number, ceilingMs: number): string {
  const ceiling = Math.round(ceilingMs / 1000)
  return `Aviso: você pediu ${askedSeconds}s, mas o limite do run_bash deste agente é ${ceiling}s; o comando roda com ${ceiling}s. Para comando longo (build, testes, pre-commit), use bash_start e acompanhe com bash_logs.\n`
}

/** `bash_logs`, `bash_stop` e `bash_list`: os processos da conversa (cada uma só vê os seus). */
function backgroundTools(
  processes: BackgroundProcesses,
  start: (command: string, name: string | undefined, context: IExecutionContext | undefined) => Promise<IToolResult>,
  guardRefusal: (command: string, context: IExecutionContext | undefined) => Promise<string | undefined>,
): ILocalTool[] {
  const describe = (entry: { id: string; name: string; status: string; code?: number | null; startedAt: Date; background: boolean }) =>
    `${entry.id} · ${entry.background ? 'segundo plano' : 'comando'} · ${entry.status}${entry.code !== undefined && entry.code !== null ? ` (código ${entry.code})` : ''} · ${entry.name} · desde ${entry.startedAt.toISOString().slice(11, 19)}`
  return [
    {
      origin: 'local',
      name: 'bash_start',
      description: 'Starts a long-running command in the background (a dev server, a watcher, a long test run), with the same rules and sandbox as run_bash. Returns an id.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The bash command' }, name: { type: 'string', description: 'A short label' } },
        required: ['command'],
        additionalProperties: false,
      },
      async execute(args, context) {
        const command = String(args.command ?? '')
        const denied = await guardRefusal(command, context)
        if (denied) return { status: 'error', result: `Refused by the gateway tool policy: ${denied}.` }
        if (dumpsClusterSecret(command)) return { status: 'error', result: CLUSTER_SECRET_REFUSAL }
        return start(command, typeof args.name === 'string' ? args.name : undefined, context)
      },
    },
    {
      origin: 'local',
      name: 'bash_logs',
      description: 'Reads the output of a background process (bash_start) or the full log of a long run_bash output, by id. Use tail for the last lines and grep to filter.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tail: { type: 'number', description: 'How many last lines (default 200, max 2000)' },
          grep: { type: 'string', description: 'Only the lines containing this text' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(args, context) {
        const entry = context?.sessionId ? processes.get(context.sessionId, String(args.id ?? '')) : undefined
        if (!entry?.logFile) return { status: 'error', result: `Não há processo com o id ${String(args.id)} nesta conversa.` }
        const lines = Math.min(Math.max(Number(args.tail) || 200, 1), 2000)
        const grep = typeof args.grep === 'string' && args.grep ? args.grep : undefined
        const text = tailOf(entry.logFile, grep ? 20_000 : lines)
        const picked = grep
          ? text
              .split('\n')
              .filter((line) => line.includes(grep))
              .slice(-lines)
              .join('\n')
          : text
        return { status: 'success', result: `${describe(entry)}\n${clipOutput(picked || '(sem saída ainda)', 20_000)}` }
      },
    },
    {
      origin: 'local',
      name: 'bash_stop',
      description: 'Stops a background process (and its children) by id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      async execute(args, context) {
        const entry = context?.sessionId ? processes.stop(context.sessionId, String(args.id ?? '')) : undefined
        if (!entry) return { status: 'error', result: `Não há processo com o id ${String(args.id)} nesta conversa.` }
        return { status: 'success', result: describe(entry) }
      },
    },
    {
      origin: 'local',
      name: 'bash_list',
      description: 'Lists the background processes and saved logs of this conversation.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async execute(_args, context) {
        const entries = context?.sessionId ? processes.list(context.sessionId) : []
        return { status: 'success', result: entries.length ? entries.map(describe).join('\n') : 'Nenhum processo nesta conversa.' }
      },
    },
  ]
}

/** A máscara que as ferramentas usam (ver `Secret.Masker`). */
export interface ILocalMask {
  text(text: string, sessionId?: string): string
  register(sessionId: string, secrets: ReadonlyArray<{ value: string; label: string }>): void
  literalIn(command: string, sessionId?: string): string | undefined
}

/** A regra é um destino TCP exato fora do HTTP: `host:porta`, sem `*`, porta que não é 80/443, e não o localhost (esse tem encaminhador). */
export function exactTcpTarget(pattern: string): boolean {
  const match = /^([^\s:*]+|\[[0-9a-f:]+\]):(\d{1,5})$/i.exec(pattern.trim())
  if (!match) return false
  const [, host, port] = match
  return !['80', '443'].includes(port) && !/^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(host)
}
