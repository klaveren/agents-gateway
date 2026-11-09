<script setup lang="ts">
  import { lite, LITE_HIDDEN_AGENT_TABS } from '@/lib/edition'
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { useRoute } from 'vue-router'
  import { ApiError } from '@/lib/api'
  import ImportIssues from '@/components/ImportIssues.vue'
  import TagsInput from '@/components/TagsInput.vue'
  import { tagNames } from '@/lib/listFilter'
  import type { IResourceFile } from '@/lib/resourceFiles'
  import { effortLabel, sizeHint } from '@/lib/format'
  import { BUILD_KINDS, builderAgentId, type TBuildKind } from '@/lib/builder'
  import {
    defaultLanes,
    envDuplicates,
    envRecord,
    envRows,
    findOrphans,
    isUsableProvider,
    mcpServersFor,
    pruneModels,
    pruneNatives,
    summarizeIssues,
    unionLanes,
    unionLevels,
    type IEnvRow,
  } from '@/lib/agentForm'
  import { useProvidersStore } from '@/stores/providers'
  import { useSettingsStore } from '@/stores/settings'
  import { useAuthStore } from '@/stores/auth'
  import { useProtocolsStore } from '@/stores/protocols'
  import type { IAgentDetail, IAgentInput, ICatalogModel, IMcpServer, INativeTool, TMode, TPermissionCategory, TSandboxLevel } from '@/lib/types'
  import { useAgentsStore } from '@/stores/agents'
  import { useMcpStore } from '@/stores/mcp'
  import { useProjectsStore } from '@/stores/projects'
  import { toolsTokens, toolTokens } from '@/lib/toolTokens'
  import AgentFootprint from './AgentFootprint.vue'
  import CliPromptMeter from './CliPromptMeter.vue'
  import AgentHooks from './AgentHooks.vue'
  import AgentSchedules from './AgentSchedules.vue'
  import AgentLedger from './AgentLedger.vue'
  import SecretVariables from './SecretVariables.vue'
  import ShareProjects from './ShareProjects.vue'
  import { scopeLabel, sharedFromOf } from '@/lib/guidance'
  import AgentModelGroup from './AgentModelGroup.vue'
  import PermissionCategoryTabs from './PermissionCategoryTabs.vue'
  import PermissionRules from './PermissionRules.vue'
  import PermissionTester from './PermissionTester.vue'
  import PermissionRequests from './PermissionRequests.vue'
  import type { IPermissionRequest } from '@/lib/permissionRequests'
  import AgentInitialContext from './AgentInitialContext.vue'
  import AgentResources from './AgentResources.vue'
  import TriggersEditor from './TriggersEditor.vue'
  import ResourceFiles from './ResourceFiles.vue'
  import HistoryPanel from './HistoryPanel.vue'
  import ConfirmDialog from './ConfirmDialog.vue'

  const props = defineProps<{ agent?: IAgentDetail; creating: boolean; sharedFrom?: string }>()
  /** Os construtores do core como alvos de delegação (fora da lista de agentes). */
  const CORE_BUILDERS = (Object.keys(BUILD_KINDS) as TBuildKind[]).map((kind) => ({ id: builderAgentId(kind), name: BUILD_KINDS[kind].builder, noun: BUILD_KINDS[kind].noun }))
  const emit = defineEmits<{ saved: [id: string]; duplicate: [agent: IAgentDetail]; removed: [] }>()

  const agents = useAgentsStore()
  const projects = useProjectsStore()
  const providers = useProvidersStore()
  const protocols = useProtocolsStore()
  const mcp = useMcpStore()

  /**
   * Providers e protocolos carregados: sem eles o formulário não sabe lanes, níveis nem nativas, e o Salvar
   * fica desligado (⚠️ antes ele salvava com o que estivesse na tela, que podia ser o provider errado).
   */
  const ready = ref(false)
  const loadError = ref<string>()
  async function loadBase() {
    loadError.value = undefined
    try {
      await Promise.all([providers.ensure(), protocols.ensure()])
      ready.value = true
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Os MCPs: por servidor ligado, "todas as ferramentas" (`mcp:<id>/*`) ou uma a uma (`mcp:<id>/<tool>`).
   * As ferramentas de cada servidor ficam na store: lidas uma vez, não a cada formulário aberto.
   */
  const mcpReady = ref(false)
  onMounted(async () => {
    void loadBase()
    if (auth.isAdmin) void settings.ensure().catch(() => undefined)
    const loaded = await mcp.ensure().then(
      () => true,
      () => false,
    )
    await Promise.all(mcp.list.filter((server) => server.enabled).map((server) => mcp.ensureTools(server.key).catch(() => [])))
    mcpReady.value = loaded
  })
  const mcpRef = (server: string, tool: string) => `mcp:${server}/${tool}`
  /**
   * ⛔ Só os do escopo do agente: os globais e os do projeto DELE (o agente global, só os globais). O servidor recusa o
   * resto ao salvar; aqui nem aparece.
   */
  const enabledMcp = computed(() =>
    mcpServersFor(
      mcp.list.filter((server) => server.enabled),
      form.value.projectId,
    ),
  )
  /**
   * ⚖️ Órfã de MCP é só a de um servidor que não existe ou está desligado — a mesma regra do servidor, que
   * não exige a ferramenta. A listagem que a tela recebe não prova que ela sumiu: o servidor pode estar fora
   * do ar, só listar dentro de uma conversa, ou (o MCP do próprio gateway) listar para a tela só as
   * ferramentas que não são de admin. As escolhidas e não listadas aparecem no servidor delas, marcadas.
   */
  function mcpOffered(entry: string): boolean {
    const [server] = entry.slice(4).split('/')
    return enabledMcp.value.some((candidate) => candidate.id === server)
  }
  /** As ferramentas de um servidor na tela: as que ele lista agora e as escolhidas que ele não listou. */
  function mcpChips(server: IMcpServer): Array<{ name: string; description?: string; inputSchema?: unknown; unlisted?: boolean }> {
    const listed = mcp.tools[server.key] ?? []
    const chosen = form.value.allowedTools
      .filter((entry) => entry.startsWith(`mcp:${server.id}/`) && !entry.endsWith('/*'))
      .map((entry) => entry.slice(`mcp:${server.id}/`.length))
      .filter((name) => !listed.some((tool) => tool.name === name))
    // A lite mostra só o que o servidor lista: a escolhida que ele não oferece (a semente tem as da PRO) não aparece.
    if (lite.value) return listed
    return [...listed, ...chosen.map((name) => ({ name, unlisted: true }))]
  }
  /** O peso, por chamada ao modelo, das ferramentas deste servidor que o agente tem (todas, com `*`). */
  function mcpWeight(server: IMcpServer): number {
    const listed = mcp.tools[server.key] ?? []
    if (form.value.allowedTools.includes(mcpRef(server.id, '*'))) return toolsTokens(listed)
    return toolsTokens(listed.filter((tool) => form.value.allowedTools.includes(mcpRef(server.id, tool.name))))
  }
  function toggleAllMcp(server: string) {
    const all = mcpRef(server, '*')
    if (form.value.allowedTools.includes(all)) form.value.allowedTools = form.value.allowedTools.filter((entry) => entry !== all)
    // "Todas" substitui as escolhidas uma a uma do mesmo servidor.
    else form.value.allowedTools = [...form.value.allowedTools.filter((entry) => !entry.startsWith(`mcp:${server}/`)), all]
  }

  /** Os providers configurados e ligados; um desligado só aparece se for deste agente. */
  const providerOptions = computed(() => providers.list.filter((provider) => provider.enabled || chosen.value.includes(provider.id)))
  /** Os providers do agente, na ordem — o primeiro é o padrão. */
  const chosen = computed(() => form.value.providers.map((target) => target.provider))
  /** Cada provider escolhido com o seu protocolo (o do banco) e o que o servidor diz dele (`GET /protocols`). */
  const selected = computed(() =>
    form.value.providers.map((target) => {
      const protocol = protocols.protocolOf(target.provider) ?? target.provider
      const status = providers.list.find((provider) => provider.id === target.provider)
      const info = protocols.get(protocol)
      return { target, protocol, info, status, compatible: !!status?.baseUrl, official: protocol === target.provider && !info?.subscription }
    }),
  )
  const infos = computed(() => selected.value.map((entry) => entry.info))
  /** ⚖️ Quem manda é o servidor (`GET /protocols`): assinatura só tem a lane agent (as APIs de chat exigem chave). */
  const lanesAllowed = computed<TMode[]>(() => unionLanes(infos.value))
  const anySubscription = computed(() => selected.value.some((entry) => entry.info?.subscription))
  const anyCompatible = computed(() => selected.value.some((entry) => entry.compatible))
  const anyGoogle = computed(() => selected.value.some((entry) => entry.protocol === 'google'))
  /** Os que recebem o prompt como argumento de linha de comando (limite do Linux: ver `CliPromptMeter`). */
  const cliSelected = computed(() => selected.value.filter((entry) => entry.protocol === 'codex' || entry.protocol === 'antigravity'))
  const savedIdentity = computed(() => (props.agent && !props.creating ? { soul: props.agent.soul, systemPrompt: props.agent.systemPrompt } : undefined))
  const families = computed(() => [...new Set(selected.value.flatMap((entry) => (entry.info ? [entry.info.nativeFamily] : [])))])

  /** As ferramentas nativas do SDK dos providers escolhidos (pela família do protocolo), na ordem do risco. */
  const RISK_ORDER = ['hosted', 'session', 'server-network', 'server-read', 'server-exec']
  /** Os níveis que algum protocolo escolhido aceita (Google: nenhum). Cada provider usa os do seu. */
  const reasoningLevels = computed(() => unionLevels(infos.value))

  const natives = computed(() =>
    agents.nativeTools.filter((tool) => families.value.includes(tool.protocol)).sort((a, b) => RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk)),
  )
  const RISK_LABEL: Record<string, string> = {
    hosted: 'no provedor',
    session: 'só a conversa',
    'server-network': 'usa a internet',
    'server-read': 'lê arquivos',
    'server-exec': 'escreve e executa',
  }
  const RISK_CLASS: Record<string, string> = {
    hosted: 'bg-zinc-800 text-zinc-300',
    session: 'bg-zinc-800 text-zinc-300',
    'server-network': 'bg-amber-500/15 text-amber-300',
    'server-read': 'bg-amber-500/15 text-amber-300',
    'server-exec': 'bg-rose-500/15 text-rose-300',
  }

  type TSelected = (typeof selected.value)[number]

  /**
   * A guia SDK, um bloco por provider do agente: cada um tem o seu nível de acesso. As nativas são as da
   * família do protocolo (o Claude da assinatura roda as do Claude), e o sandbox, nos que o têm (Codex,
   * Antigravity), é escolhido aqui, por agente.
   */
  const sdkSections = computed(() =>
    selected.value.map((entry) => {
      const family = entry.info?.nativeFamily
      const tools = family ? natives.value.filter((tool) => tool.protocol === family) : []
      // A mesma nativa vale em todos os providers da família: marcar num marca no outro.
      const shared = family
        ? selected.value.filter((other) => other !== entry && other.info?.nativeFamily === family).map((other) => protocols.providerName(other.target.provider))
        : []
      return { entry, tools, shared, levels: entry.info?.sandboxLevels ?? [], network: !!entry.info?.sandboxNetwork }
    }),
  )

  /** Por que uma nativa não roda neste provider — ou nada, se roda. */
  function nativeBlock(tool: INativeTool, entry: TSelected): string | undefined {
    return tool.officialOnly && !entry.official ? 'Só no provedor oficial.' : undefined
  }

  const SANDBOX_LABEL: Record<TSandboxLevel, string> = {
    'read-only': 'Só leitura',
    'workspace-write': 'Escreve na pasta da conversa',
    full: 'Acesso total',
  }
  const SANDBOX_HINT: Record<TSandboxLevel, string> = {
    'read-only': 'Lê o disco, não escreve.',
    'workspace-write': 'Escreve só na pasta da conversa.',
    full: 'Lê, escreve e executa no servidor, sem limites.',
  }
  function sandboxLabel(protocol: string, level: TSandboxLevel): string {
    // No Antigravity é ligado/desligado: com sandbox, nega o que pede permissão.
    return protocol === 'antigravity' && level === 'read-only' ? 'Restrito' : SANDBOX_LABEL[level]
  }
  function sandboxHint(protocol: string, level: TSandboxLevel): string {
    return protocol === 'antigravity' && level === 'read-only' ? 'Não executa comandos nem lê arquivos.' : SANDBOX_HINT[level]
  }
  /** O padrão (o primeiro nível) não é gravado: o agente segue o padrão do protocolo. */
  function setSandbox(entry: TSelected, levels: TSandboxLevel[], level: TSandboxLevel) {
    entry.target.sandbox = level === levels[0] ? undefined : level
  }

  /**
   * Os modelos que cada provider PODE oferecer ao agente: os ativados no catálogo dele. Sem nenhum ativado,
   * o formulário manda para Modelos.
   */
  const catalogs = computed<Record<string, ICatalogModel[] | undefined>>(() =>
    Object.fromEntries(
      chosen.value.map((id) => {
        // Ausente: ainda lendo. A leitura que falhou vale como nenhum ativado (manda para Modelos).
        const known = providers.catalogs.has(id) || providers.catalogs.error(id) !== undefined
        return [id, known ? (providers.catalogs.get(id) ?? []).filter((model) => model.enabled) : undefined]
      }),
    ),
  )
  const modelSearch = ref('')
  function visibleModels(providerId: string): ICatalogModel[] {
    const term = modelSearch.value.trim().toLowerCase()
    return (catalogs.value[providerId] ?? []).filter((model) => !term || model.modelId.toLowerCase().includes(term) || model.label?.toLowerCase().includes(term))
  }
  const manyModels = computed(() => Object.values(catalogs.value).some((models) => (models?.length ?? 0) > 8))

  /** Marca/desmarca; o primeiro marcado é o padrão daquele provider (e "tornar padrão" o leva para o topo). */
  function toggleModel(target: { models: string[] }, modelId: string) {
    const at = target.models.indexOf(modelId)
    if (at === -1) target.models.push(modelId)
    else target.models.splice(at, 1)
  }

  function makeDefault(target: { models: string[] }, modelId: string) {
    target.models = [modelId, ...target.models.filter((model) => model !== modelId)]
  }

  /** O provider vira o padrão do agente: vai para o topo. */
  function makeDefaultProvider(id: string) {
    const target = form.value.providers.find((candidate) => candidate.provider === id)
    if (target) form.value.providers = [target, ...form.value.providers.filter((candidate) => candidate !== target)]
  }

  /** Ferramentas que mudam algo fora da conversa: quem diz é o servidor (`dangerous` em `GET /tools`). */
  const dangerousNames = computed(() => new Set(agents.tools.filter((tool) => tool.dangerous).map((tool) => tool.name)))
  const dangerousChosen = computed(() => [
    ...agents.capabilities.filter((item) => item.dangerous && form.value.allowedTools.includes(item.id)).map((item) => item.label),
    ...form.value.allowedTools.filter((name) => dangerousNames.value.has(name)).map((name) => LOCAL_TOOL_LABEL[name] ?? name),
  ])
  /** As capacidades escolhidas e como cada uma roda nos provedores do agente ("Anthropic: nativa do Claude · Google: do gateway"). */
  const capabilityRows = computed(() =>
    agents.capabilities
      .filter((item) => form.value.allowedTools.includes(item.id))
      .map((item) => ({
        id: item.id,
        label: item.label,
        runs: form.value.providers
          .map((target) => `${protocols.providerName(target.provider)}: ${item.runs[protocols.protocolOf(target.provider) ?? target.provider] ?? 'indisponível'}`)
          .join(' · '),
      })),
  )
  const dangerousNatives = computed(() => natives.value.filter((tool) => tool.dangerous && form.value.allowedTools.includes(tool.id)).map((tool) => tool.label))
  /** Os providers do agente sem sandbox ou com a rede dele aberta. */
  const openSandboxes = computed(() =>
    form.value.providers.filter((target) => target.sandbox === 'full' || target.network).map((target) => protocols.providerName(target.provider)),
  )

  /** O nome que a pessoa vê de cada campo, para o resumo do erro perto do Salvar. */
  const FIELD_LABEL: Record<string, string> = {
    triggers: 'Triggers',
    id: 'Identificador',
    name: 'Nome',
    providers: 'Provedores',
    models: 'Modelos',
    modes: 'Modos',
    reasoningEfforts: 'Raciocínio',
    allowedTools: 'Ferramentas',
    soul: 'Personalidade',
    systemPrompt: 'System Prompt',
    role: 'Subagente',
    adminOnly: 'Administradores',
    projectId: 'Projeto',
    tags: 'Tags',
    env: 'Variáveis de ambiente',
  }

  // Agente novo nasce no projeto atual (o seletor do trilho); global só se alguém escolher.
  const blank = (): IAgentInput => ({
    id: '',
    name: '',
    providers: [],
    soul: '',
    systemPrompt: '',
    reasoningEfforts: [],
    modes: ['chat', 'agent'],
    allowedTools: [],
    role: null,
    adminOnly: false,
    projectId: projects.current ?? null,
    permissions: [],
    triggers: [],
    tags: [],
  })
  const form = ref<IAgentInput>(blank())
  /** As tags que os agentes já usam (as sugestões do campo). */
  const knownTags = computed(() => tagNames(agents.list))
  /** As variáveis de ambiente do agente, em linhas (o par nome/valor): viram o registro só ao salvar. */
  const envList = ref<IEnvRow[]>([])
  /**
   * A pasta do agente como está no disco (o que a tela pôs e o que ele gravou): guia própria, gravada à parte (o Salvar
   * do agente não a manda nem a apaga). A gravação leva o que a guia mostrava: só o que ela tirou sai da pasta.
   */
  const agentFiles = ref<IResourceFile[]>([])
  async function saveAgentFiles(files: IResourceFile[]) {
    if (!props.agent) return
    await agents.saveFiles(
      props.agent.id,
      files,
      agentFiles.value.map((file) => file.path),
    )
    agentFiles.value = files
  }
  const envRepeated = computed(() => envDuplicates(envList.value))

  const DIAGNOSTIC_CHECKS: Array<{ key: 'typecheck' | 'lint' | 'format'; label: string }> = [
    { key: 'typecheck', label: 'Tipos (tsc)' },
    { key: 'lint', label: 'Lint (eslint)' },
    { key: 'format', label: 'Formato (prettier)' },
  ]
  /**
   * O GRUPO DE MODELOS do agente: `''` = o padrão (vai como `null`), `none` = não troca, senão o id. ⚖️ Os grupos vêm
   * das Configurações (só admin): sem elas, a lista fica só com as opções fixas.
   */
  const settings = useSettingsStore()
  const auth = useAuthStore()
  /** Agente global: só o admin do gateway altera; quem administra o projeto lê. */
  const globalLocked = computed(() => !props.creating && !!props.agent && !props.agent.projectId && !auth.isAdmin)
  /** Veio de outro projeto (compartilhado): o projeto de origem. Aqui é só leitura; só as Variáveis (valores deste projeto) se editam. */
  const sharedFrom = computed(() => (props.creating || !props.agent ? undefined : props.sharedFrom ?? sharedFromOf(props.agent, projects.current)))
  const locked = computed(() => globalLocked.value || !!sharedFrom.value)
  const groupChoice = computed({
    get: () => (form.value.modelGroup === undefined || form.value.modelGroup === null ? '' : form.value.modelGroup),
    set: (value: string) => (form.value.modelGroup = value === '' ? null : value),
  })

  /** Entradas `sdk:`/`agent:`/`mcp:` que nenhuma lista oferece: sem checkbox, mas o servidor recusa o salvamento. */
  const orphans = computed(() =>
    findOrphans(form.value.allowedTools, {
      natives: agents.toolsLoaded && protocols.loaded ? new Set(natives.value.map((tool) => tool.id)) : undefined,
      agents: agents.loaded
        ? new Set([...agents.list.filter((candidate) => candidate.id !== form.value.id).map((candidate) => candidate.id), ...CORE_BUILDERS.map((builder) => builder.id)])
        : undefined,
      mcp: mcpReady.value ? mcpOffered : undefined,
    }),
  )

  /** Modelos que o agente declarava e que estão desligados no catálogo, por provider: saem ao salvar. */
  const droppedModels = ref<Record<string, string[]>>({})
  const dropped = computed(() => Object.entries(droppedModels.value).filter(([, models]) => models.length))
  const issues = ref<Record<string, string[]>>({})
  const failure = ref<string>()
  const saving = ref(false)
  const confirmingSave = ref(false)
  const confirming = ref(false)
  const deleting = ref(false)

  /**
   * As guias do formulário: o texto do agente na primeira, e cada grupo de capacidades na sua. A contagem diz
   * quanto está escolhido sem abrir a guia; o ponto vermelho, que o servidor recusou algo ali.
   */
  /**
   * Um pedido de permissão aprovado: as regras do agente são as que o servidor gravou. ⛔ O formulário passa a mostrá-las
   * — senão o próximo Salvar regravaria as de antes e desfaria a aprovação.
   */
  function permissionsApproved(request: IPermissionRequest, permissions: IAgentInput['permissions']) {
    if (!props.agent) return
    // O patch aprovado muda outros campos: o agente é relido (o formulário volta ao gravado).
    if (request.kind === 'agent-patch') return void agents.details.refresh(props.agent.id).catch(() => undefined)
    form.value.permissions = (permissions ?? []).map((rule) => ({ ...rule }))
    agents.setPermissions(props.agent.id, permissions)
  }

  type TTab = 'agente' | 'personalidade' | 'instrucoes' | 'triggers' | 'modelos' | 'ferramentas' | 'delegacao' | 'mcps' | 'sdk' | 'recursos' | 'arquivos' | 'contexto' | 'tamanho' | 'hooks' | 'agendamentos' | 'memoria' | 'variaveis' | 'compartilhar' | 'historico' | 'problemas'
  // `#agendamentos` no link (a visão geral dos agendamentos) abre direto na guia.
  /** O nome das ferramentas do gateway na guia Ferramentas (o id técnico fica na dica). */
  const LOCAL_TOOL_LABEL: Record<string, string> = {
    update_todos: 'Lista de tarefas',
    run_bash: 'Terminal',
    search_web: 'Busca na web',
    read_doc: 'Ler documento',
    search_docs: 'Buscar documentos',
    use_resource: 'Usar recurso (skill, command, trigger)',
    search_resources: 'Buscar recursos',
    agent_trigger: 'Editar triggers',
    ssh_sign: 'Assinar SSH',
    conversation_panel: 'Painel da conversa',
  }

  const initialHash = useRoute().hash
  const HASH_TAB: Record<string, TTab> = { '#agendamentos': 'agendamentos', '#memoria': 'memoria', '#variaveis': 'variaveis', '#compartilhar': 'compartilhar', '#historico': 'historico', '#problemas': 'problemas', '#personalidade': 'personalidade', '#instrucoes': 'instrucoes' }
  const tab = ref<TTab>(HASH_TAB[initialHash] ?? 'agente')
  /** Por que o agente não roda agora (e o servidor recusa delegar a ele), ou nada. Só administradores não impede delegar. */
  const cannotRun = (other: { unavailable?: { reason: string; label: string } }) =>
    other.unavailable && other.unavailable.reason !== 'admin_only' ? other.unavailable.label : undefined
  /** A guia aberta dentro de Modelos: os modelos do agente ou o grupo de modelos. */
  const modelsTab = ref<'agente' | 'grupo'>('agente')
  /** O que a guia Permissões mostra: as regras (uma guia por categoria) ou o nível de acesso dos CLIs. */
  const permissionPane = ref<'rules' | 'access'>('rules')
  /** A guia aberta dentro de Ferramentas. */
  const toolsTab = ref<'gateway' | 'provedor' | 'config'>('gateway')
  /** A categoria aberta na guia Permissões: uma guia por categoria, como nas permissões do projeto. */
  const permissionSection = ref<TPermissionCategory>('terminal')

  /** Sobram guias à direita (a barra rola de lado): a borda esmaece, para ninguém achar que acabaram. */
  const tabBar = ref<HTMLElement>()
  const moreTabs = ref(false)
  const measureTabs = () => {
    const bar = tabBar.value
    moreTabs.value = !!bar && bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4
  }
  const tabObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measureTabs)
  watch(tabBar, (bar, old) => {
    if (old) tabObserver?.unobserve(old)
    if (bar) tabObserver?.observe(bar)
    measureTabs()
  })
  onBeforeUnmount(() => tabObserver?.disconnect())
  // A guia escolhida (inclusive a que veio no link) fica à vista.
  watch([tab, tabBar], () => void nextTick(() => tabBar.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })), {
    immediate: true,
  })
  const TAB_FIELDS: Record<TTab, string[]> = {
    agente: ['id', 'name', 'role', 'adminOnly', 'projectId', 'tags'],
    personalidade: ['soul'],
    instrucoes: ['systemPrompt'],
    triggers: ['triggers'],
    modelos: ['providers', 'models', 'modes', 'reasoningEfforts'],
    ferramentas: ['allowedTools'],
    delegacao: [],
    mcps: [],
    sdk: [],
    recursos: [],
    arquivos: ['files'],
    contexto: [],
    tamanho: [],
    hooks: [],
    agendamentos: [],
    memoria: [],
    variaveis: ['env'],
    compartilhar: [],
    historico: [],
    problemas: [],
  }
  /** Os problemas da importação do agente (da store: o "Descartar" troca a lista sem refazer o formulário). */
  const importIssues = computed(() => (props.agent ? (agents.details.get(props.agent.id)?.importIssues ?? props.agent.importIssues ?? []) : []))
  /** Os provedores com nível de acesso (guia Permissões) e os com extras (guia Ferramentas → Do provedor). */
  const accessSections = computed(() => sdkSections.value.filter((section) => section.levels.length))
  const toolSections = computed(() => sdkSections.value.filter((section) => section.tools.length))
  const toolTabs = computed(() => [
    { id: 'gateway' as const, label: 'Do gateway' },
    ...(toolSections.value.length ? [{ id: 'provedor' as const, label: 'Do provedor' }] : []),
    { id: 'config' as const, label: 'Configurações' },
  ])
  // A guia que sumiu (o provedor saiu) não fica aberta vazia.
  watch(toolSections, (list) => {
    if (!list.length && toolsTab.value === 'provedor') toolsTab.value = 'gateway'
  })
  watch(accessSections, (list) => {
    if (!list.length && permissionPane.value === 'access') permissionPane.value = 'rules'
  })

  /** Os projetos com que o agente está compartilhado (o salvo). */
  const sharedNow = ref<string[]>([])
  watch(() => props.agent?.sharedWith, (list) => (sharedNow.value = [...(list ?? [])]), { immediate: true })
  const canShare = computed(() => !props.creating && !!props.agent?.projectId && !sharedFrom.value && projects.manages)
  async function saveShares(list: string[]) {
    if (!props.agent) return
    const saved = await agents.share(props.agent.id, list)
    sharedNow.value = [...(saved.sharedWith ?? list)]
  }

  const tabs = computed(() => {
    const tools = form.value.allowedTools
    const alert = (id: TTab) => (TAB_FIELDS[id].some((field) => issues.value[field]?.length) ? 'Corrija os campos desta guia.' : undefined)
    const all: Array<{ id: TTab; label: string; count?: number; alert?: string }> = [
      { id: 'agente', label: 'Agente', alert: alert('agente') },
      { id: 'personalidade', label: 'Personalidade', alert: alert('personalidade') },
      { id: 'instrucoes', label: 'Protocolo', alert: alert('instrucoes') },
      { id: 'triggers', label: 'Triggers', count: form.value.triggers?.length ?? 0, alert: alert('triggers') },
      { id: 'modelos', label: 'Modelos', count: form.value.providers.reduce((total, target) => total + target.models.length, 0), alert: alert('modelos') },
      {
        id: 'ferramentas',
        label: 'Ferramentas',
        count: tools.filter((entry) => !entry.startsWith('mcp:') && !entry.startsWith('sdk:')).length,
        alert: alert('ferramentas') ?? (orphans.value.length ? 'Há ferramentas indisponíveis' : undefined),
      },
      { id: 'mcps', label: 'MCPs', count: tools.filter((entry) => entry.startsWith('mcp:')).length },
      // A delegação numa guia só dela: a quem pede ajuda (as ferramentas `agent:`) e as regras de delegação, juntas.
      {
        id: 'delegacao',
        label: 'Delegação',
        count: tools.filter((entry) => entry.startsWith('agent:')).length + (form.value.permissions ?? []).filter((rule) => rule.category === 'delegate').length,
      },
      {
        id: 'sdk',
        label: 'Permissões',
        count: (form.value.permissions ?? []).filter((rule) => rule.category !== 'delegate').length + tools.filter((entry) => entry.startsWith('sdk:')).length,
      },
      { id: 'recursos', label: 'Recursos' },
      { id: 'arquivos', label: 'Arquivos', count: agentFiles.value.length },
      { id: 'contexto', label: 'Contexto inicial' },
      { id: 'tamanho', label: 'Tamanho' },
      { id: 'hooks', label: 'Hooks' },
      { id: 'agendamentos', label: 'Agendamentos' },
      // O ledger do agente (o que ele aprendeu de como agir): só para agente já gravado.
      { id: 'memoria', label: 'Memória' },
      // As variáveis secretas do agente: só admin e só para agente já gravado (o valor entra e nunca volta).
      // As variáveis do terminal: as fixas (com o Salvar) e as secretas (só admin, agente já gravado).
      { id: 'variaveis', label: 'Variáveis', count: envList.value.length, alert: alert('variaveis') },
      // Compartilhar: só o agente de um projeto, já gravado, e do projeto dono (quem recebe não repassa).
      ...(canShare.value ? [{ id: 'compartilhar' as const, label: 'Compartilhar', count: sharedNow.value.length }] : []),
      { id: 'historico', label: 'Histórico' },
      // Só aparece com problema: o que a importação deixou anotado no agente (não impediu a gravação).
      ...(importIssues.value.length ? [{ id: 'problemas' as const, label: 'Problemas da importação', count: importIssues.value.length }] : []),
    ]
    // A guia Permissões aparece sempre: as regras do agente moram nela, haja ou não nível de acesso ou extras.
    return lite.value ? all.filter((item) => !LITE_HIDDEN_AGENT_TABS.has(item.id)) : all
  })
  // A guia que sumiu (tirou o provider das nativas) não fica aberta vazia.
  watch(tabs, (list) => {
    // ⚖️ O link `#problemas` espera os problemas chegarem (o detalhe completo vem depois da lista).
    if (tab.value === 'problemas' && initialHash === '#problemas' && !importIssues.value.length) return
    if (!list.some((item) => item.id === tab.value)) tab.value = 'agente'
  })

  /** O padrão de um agente novo: o primeiro provider que já abre conversa (ligado, com chave ou assinatura). */
  const defaultProvider = computed(() => providers.list.find((provider) => isUsableProvider(provider, protocols.get(provider.protocol)))?.id ?? '')
  function applyDefaultProvider() {
    if (props.creating && !props.agent && !form.value.providers.length && defaultProvider.value) toggleProvider(defaultProvider.value)
  }
  watch(defaultProvider, applyDefaultProvider)

  /**
   * Os providers que a PESSOA acabou de pôr: quando o catálogo deles chega, o primeiro modelo ativado vira o
   * padrão. Carregar um agente existente não pode mexer no que ele declara.
   */
  const added = new Set<string>()

  /**
   * A pessoa pôs ou tirou um provider.
   *
   * Pôr: entra no fim (o primeiro continua o padrão); os modelos chegam com o catálogo (watcher abaixo). Sendo
   * o único, as lanes e os níveis partem do protocolo dele.
   *
   * Tirar: o que só ele sustentava sai já — a nativa `sdk:` de uma família que ficou sem provider, a lane e o
   * nível que nenhum protocolo restante aceita fariam o servidor recusar.
   */
  function toggleProvider(id: string) {
    const existing = form.value.providers.find((target) => target.provider === id)
    if (existing) {
      form.value.providers = form.value.providers.filter((target) => target !== existing)
      added.delete(id)
      delete droppedModels.value[id]
    } else {
      form.value.providers = [...form.value.providers, { provider: id, models: [] }]
      added.add(id)
      if (form.value.providers.length === 1) {
        const info = protocols.get(protocols.protocolOf(id) ?? id)
        form.value.modes = defaultLanes(info)
        form.value.reasoningEfforts = protocols.levelsFor(info?.id ?? id, form.value.reasoningEfforts ?? [])
      }
    }
    const lanes = lanesAllowed.value
    form.value.modes = form.value.modes.filter((mode) => lanes.includes(mode))
    if (!form.value.modes.length) form.value.modes = [...lanes]
    if (existing) {
      const levels = reasoningLevels.value
      form.value.reasoningEfforts = (form.value.reasoningEfforts ?? []).filter((level) => levels.includes(level))
      if (agents.toolsLoaded && protocols.loaded) form.value.allowedTools = pruneNatives(form.value.allowedTools, agents.nativeTools, families.value)
    }
  }

  watch(
    chosen,
    (ids) => {
      // Em paralelo: um catálogo lento (o do Google lista centenas) não segura o dos outros.
      // A store guarda cada catálogo e junta os pedidos iguais: o que já foi lido não é lido de novo.
      for (const id of ids)
        void providers
          .models(id)
          .catch(() => undefined)
          .then(() => settleAdded(id))
    },
    { immediate: true },
  )

  /** O catálogo de um provider que a pessoa acabou de pôr chegou: o primeiro ativado vira o padrão dele. */
  function settleAdded(id: string) {
    if (!added.has(id)) return
    const target = form.value.providers.find((candidate) => candidate.provider === id)
    const offered = catalogs.value[id]
    if (!target || !offered) return
    added.delete(id)
    target.models = pruneModels(
      target.models,
      offered.map((model) => model.modelId),
    )
  }

  watch(
    () => [props.agent, props.creating] as const,
    ([agent]) => {
      added.clear()
      modelSearch.value = ''
      // Os desligados no catálogo não entram no formulário: salvar com eles seria recusado.
      droppedModels.value = Object.fromEntries((agent?.providers ?? []).map((provider) => [provider.id, provider.disabledModels ?? []]))
      form.value = agent
        ? {
            id: agent.id,
            name: agent.name,
            providers: agent.providers.map((provider) => ({
              provider: provider.id,
              models: provider.models.filter((model) => !provider.disabledModels?.includes(model)),
              ...(provider.sandbox ? { sandbox: provider.sandbox } : {}),
              ...(provider.network ? { network: true } : {}),
            })),
            soul: agent.soul ?? '',
            systemPrompt: agent.systemPrompt,
            reasoningEfforts: [...(agent.reasoningEfforts ?? [])],
            modes: [...agent.modes],
            allowedTools: [...agent.allowedTools],
            role: agent.role ?? null,
            adminOnly: !!agent.adminOnly,
            projectId: agent.projectId ?? null,
            permissions: (agent.permissions ?? []).map((rule) => ({ ...rule })),
            terminal: agent.terminal ? { ...agent.terminal } : null,
            diagnostics: agent.diagnostics ? { ...agent.diagnostics } : null,
            triggers: (agent.triggers ?? []).map((trigger) => ({ ...trigger })),
            tags: [...(agent.tags ?? [])],
            modelGroup: agent.modelGroup ?? null,
          }
        : blank()
      envList.value = envRows(agent?.env)
      agentFiles.value = (agent?.files ?? []).map((file) => ({ ...file }))
      issues.value = {}
      failure.value = undefined
      applyDefaultProvider()
    },
    { immediate: true },
  )

  function toggle<T>(values: T[], value: T) {
    const at = values.indexOf(value)
    if (at === -1) values.push(value)
    else values.splice(at, 1)
  }

  function slugify() {
    if (!props.creating || form.value.id) return
    form.value.id = form.value.name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48)
  }

  /** O que será gravado, em uma linha, para a confirmação do Salvar. */
  /**
   * ⚖️ UM SALVAR SÓ: o "Salvar agente" grava o formulário e, depois, as guias com cadastro próprio que mudaram (Recursos,
   * Arquivos, Contexto inicial e a sequência de Troca automática). Cada uma fica montada e expõe `dirty` e `commit`.
   */
  interface IPart {
    dirty: boolean
    commit: () => Promise<void>
  }
  const resourcesPart = ref<IPart>()
  const filesPart = ref<IPart>()
  const contextPart = ref<IPart>()
  const groupPart = ref<IPart & { name?: string; users?: number }>()
  const parts = computed(() => {
    const all: Array<[TTab, string, IPart | undefined]> = [
      ['recursos', 'Recursos', resourcesPart.value],
      ['arquivos', 'Arquivos', filesPart.value],
      ['contexto', 'Contexto inicial', contextPart.value],
      ['modelos', 'Troca automática', groupPart.value],
    ]
    return all.filter((entry): entry is [TTab, string, IPart] => !!entry[2])
  })
  /** As guias com mudança não salva (ganham um ponto amarelo). */
  const unsavedTabs = computed<TTab[]>(() => parts.value.filter(([, , part]) => part.dirty).map(([id]) => id))
  /** As guias sem nada que o "Salvar agente" grave: só leitura, ou listas que gravam na hora. */
  const FOOTERLESS_TABS: readonly TTab[] = ['compartilhar', 'tamanho', 'hooks', 'agendamentos', 'memoria', 'historico', 'problemas']

  const saveSummary = computed(() => {
    const { providers: targets, modes, allowedTools } = form.value
    const list = targets.map(
      (target, index) => `${protocols.providerName(target.provider)} (${target.models.length} modelo(s)${index === 0 && target.models[0] ? `, padrão ${target.models[0]}` : ''})`,
    )
    const base = `${targets.length > 1 ? 'Provedores' : 'Provedor'} ${list.join(', ') || 'nenhum'}; modos ${modes.map((mode) => (mode === 'chat' ? 'Conversa' : 'Agente')).join(' + ') || 'nenhum'}; ${allowedTools.length} ferramenta(s).`
    const changed = parts.value.filter(([, , part]) => part.dirty)
    const extra = changed.length ? ` Também grava: ${changed.map(([, label]) => label).join(', ')}.` : ''
    const group = groupPart.value
    const shared =
      group?.dirty && (group.users ?? 0) > 1 ? ` A sequência ${group.name ?? ''} muda para os ${group.users} agentes que a usam.` : group?.dirty ? ` A sequência ${group.name ?? ''} muda para todo agente que a usa.` : ''
    return base + extra + shared
  })

  async function save() {
    confirmingSave.value = false
    saving.value = true
    issues.value = {}
    failure.value = undefined
    if (envRepeated.value.length) {
      issues.value = { env: envRepeated.value.map((name) => `${name} aparece mais de uma vez`) }
      failure.value = 'Corrija as variáveis de ambiente.'
      saving.value = false
      return
    }
    // Sem modelo marcado (o catálogo tira os desativados), o servidor recusaria com a mensagem crua da validação.
    if (!form.value.providers.some((target) => target.models.length)) {
      issues.value = { providers: ['marque ao menos um modelo. Nenhum aparece? Ative um no menu Modelos.'] }
      failure.value = 'O agente precisa de ao menos um modelo.'
      tab.value = 'modelos'
      saving.value = false
      return
    }
    try {
      const input: IAgentInput = {
        ...form.value,
        reasoningEfforts: (form.value.reasoningEfforts ?? []).filter((level) => reasoningLevels.value.includes(level)),
        permissions: (form.value.permissions ?? []).filter((rule) => rule.pattern.trim()),
        // Vazio volta ao global (Sistema → Limites).
        terminal: form.value.terminal?.timeoutSeconds || form.value.terminal?.maxOutputChars ? form.value.terminal : null,
        // Nada ligado = desligado.
        // Vazio apaga todos.
        triggers: form.value.triggers ?? [],
        diagnostics: form.value.diagnostics?.typecheck || form.value.diagnostics?.lint || form.value.diagnostics?.format ? form.value.diagnostics : null,
        // Nenhuma apaga todas.
        env: envRecord(envList.value),
        // Padrão vai como `null` (na edição volta ao grupo padrão); criando, ausente.
        modelGroup: form.value.modelGroup ?? null,
      }
      const saved = await agents.save(input, props.creating)
      // Depois do agente, as guias com cadastro próprio que mudaram, uma a uma: a que falhar diz onde.
      for (const [id, label, part] of parts.value) {
        if (!part.dirty) continue
        try {
          await part.commit()
        } catch (error) {
          tab.value = id
          throw new Error(`O agente foi salvo, mas ${label} não: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      emit('saved', saved.id)
    } catch (error) {
      // ⚠️ Todo 422 vira resumo perto do Salvar: o campo com problema pode nem ter input na tela.
      if (error instanceof ApiError && error.status === 422) issues.value = error.fieldIssues
      failure.value = error instanceof Error ? error.message : String(error)
    } finally {
      saving.value = false
    }
  }

  async function remove() {
    if (!props.agent) return
    deleting.value = true
    try {
      await agents.remove(props.agent.id)
      confirming.value = false
      emit('removed')
    } catch (error) {
      // 409 `agent_in_use`: a mensagem do servidor diz quem ainda referencia o agente.
      failure.value = error instanceof Error ? error.message : String(error)
      confirming.value = false
    } finally {
      deleting.value = false
    }
  }
</script>

<template>
  <form class="mx-auto flex max-w-3xl flex-col gap-5" @submit.prevent="confirmingSave = true" @invalid.capture="tab = ($event.target as HTMLElement).dataset.tab === 'instrucoes' ? 'instrucoes' : 'agente'">
    <!-- Uma linha só: com muitas guias, rola de lado (quebrar em duas linhas desalinhava o sublinhado). -->
    <nav ref="tabBar" class="no-scrollbar flex gap-1 overflow-x-auto border-b border-zinc-800" :class="{ 'fade-right': moreTabs }" role="tablist" @scroll.passive="measureTabs">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        role="tab"
        :data-test="`agent-tab-${item.id}`"
        :aria-selected="tab === item.id"
        class="flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
        :class="tab === item.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
        @click="tab = item.id"
      >
        {{ item.label }}
        <span v-if="item.count" class="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">{{ item.count }}</span>
        <span v-if="item.alert" class="h-1.5 w-1.5 rounded-full bg-rose-400" :title="item.alert" />
        <span v-else-if="unsavedTabs.includes(item.id)" class="h-1.5 w-1.5 rounded-full bg-amber-400" title="Mudança não salva" />
      </button>
    </nav>
    <p v-if="sharedFrom" class="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-200" data-test="shared-readonly">Compartilhado por {{ scopeLabel(sharedFrom, projects.list) }}: só leitura aqui; a manutenção é lá.</p>
    <p v-else-if="locked" class="text-xs text-amber-300" data-test="global-readonly">Global: só o administrador do gateway altera.</p>
    <fieldset :disabled="locked" class="contents">
    <fieldset v-show="tab === 'agente'" class="grid gap-4 sm:grid-cols-2">
      <label class="field">
        <span>Nome</span>
        <input v-model="form.name" required maxlength="80" class="input" @blur="slugify" />
        <small v-for="message in issues.name" :key="message" class="error">{{ message }}</small>
      </label>
      <label class="field">
        <span>Identificador</span>
        <input v-model="form.id" :disabled="!creating" required pattern="[a-z0-9][a-z0-9-]{1,47}" class="input font-mono disabled:opacity-60" placeholder="meu-agente" />
        <small v-if="creating" class="hint">Identificador único. Não muda depois.</small>
        <small v-for="message in issues.id" :key="message" class="error">{{ message }}</small>
      </label>

      <label class="field sm:col-span-2">
        <span>Projeto</span>
        <select v-model="form.projectId" class="input">
          <option :value="null" :disabled="!auth.isAdmin">Global — aparece em todos os projetos</option>
          <!-- Só o projeto escolhido no topo (ou o do agente, se for outro): sem lista de projetos aqui. -->
          <option v-for="project in projects.list.filter((item) => item.id === projects.current || item.id === (agent?.projectId ?? form.projectId))" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
        <small class="hint">{{ form.projectId ? 'Só os membros do projeto veem o agente.' : 'Qualquer projeto vê o agente.' }}</small>
        <small v-for="message in issues.projectId" :key="message" class="error">{{ message }}</small>
      </label>
      <TagsInput v-model="form.tags" label="Tags" :suggestions="knownTags" :issues="issues.tags" class="sm:col-span-2" />
      <div class="field">
        <label class="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            :aria-checked="form.role === 'subagent'"
            class="switch"
            :class="{ on: form.role === 'subagent' }"
            @click="form.role = form.role === 'subagent' ? null : 'subagent'"
          >
            <span />
          </button>
          <span>Subagente</span>
        </label>
        <small class="hint">Só outros agentes o chamam (em "Pode delegar a"). Não aparece em Nova conversa.</small>
      </div>
      <div class="field">
        <label class="flex items-center gap-3">
          <button type="button" role="switch" :aria-checked="!!form.adminOnly" class="switch" :class="{ on: form.adminOnly }" @click="form.adminOnly = !form.adminOnly">
            <span />
          </button>
          <span>Administradores</span>
        </label>
        <small class="hint">Desligado, qualquer pessoa com conta pode conversar com este agente.</small>
      </div>

    </fieldset>
    <!-- Quem o agente é (Personalidade) e o que ele faz (Protocolo), cada um na sua guia. -->
    <fieldset v-show="tab === 'personalidade'" class="grid gap-4 sm:grid-cols-2">
      <label class="field sm:col-span-2">
        <span>
          Personalidade
          <em class="font-normal text-zinc-500">— quem o agente é: identidade, tom e jeito de falar.</em>
        </span>
        <textarea
          v-model="form.soul"
          class="input prompt-area text-[13px] leading-relaxed"
          placeholder="Você é a Íris: gentil, direta, explica sem jargão e admite quando não sabe."
        />
        <small v-if="form.soul" class="hint">{{ sizeHint(form.soul, 'a cada turno') }}</small>
        <small v-for="message in issues.soul" :key="message" class="error">{{ message }}</small>
      </label>
    </fieldset>
    <fieldset v-show="tab === 'instrucoes'" class="grid gap-4 sm:grid-cols-2">
      <label class="field sm:col-span-2">
        <span>
          System Prompt
          <em class="font-normal text-zinc-500">— o que o agente faz: função, regras, como usar as ferramentas</em>
        </span>
        <!-- ⚖️ O texto ocupa a altura que sobra da tela (o rodapé com o Salvar fica sempre à vista, ver `.form-footer`). -->
        <textarea
          v-model="form.systemPrompt"
          required
          data-tab="instrucoes"
          class="input prompt-area font-mono text-[13px] leading-relaxed"
          placeholder="Você é o agente…"
        />
        <small v-if="form.systemPrompt" class="hint">{{ sizeHint(form.systemPrompt, 'a cada turno') }}</small>
        <small v-if="anyGoogle" class="hint">Com Gemini, evite {chaves} no texto: viram variáveis e dão erro.</small>
        <CliPromptMeter
          v-if="cliSelected.length && form.systemPrompt"
          :providers="cliSelected.map((entry) => protocols.providerName(entry.target.provider))"
          :codex="cliSelected.some((entry) => entry.protocol === 'codex')"
          :soul="form.soul"
          :system-prompt="form.systemPrompt"
          :agent-id="savedIdentity ? agent?.id : undefined"
          :project-id="agent?.projectId"
          :saved="savedIdentity"
        />
        <small v-for="message in issues.systemPrompt" :key="message" class="error">{{ message }}</small>
      </label>
    </fieldset>
    <fieldset v-show="tab === 'triggers'" class="flex flex-col gap-4">
      <TriggersEditor
        v-model="form.triggers!"
        title="Triggers — ações ativadas sob demanda"
        intro='Procedimentos deste agente, e de mais ninguém. O prompt lista só o nome e o "quando usar" de cada um; o procedimento entra quando o pedido se encaixa (o agente o carrega com use_resource).'
        empty='Nenhum trigger. Um trigger é um subcomando do agente: o "quando usar" vai no índice do prompt, e o procedimento só quando precisa.'
        :issues="issues.triggers"
      />
    </fieldset>
    <!-- Duas guias: os modelos do agente (o que a pessoa escolhe) e a troca automática (a sequência de modelos quando um falha). -->
    <fieldset v-show="tab === 'modelos'" class="flex flex-col gap-3">
      <nav class="no-scrollbar flex gap-1 overflow-x-auto border-b border-zinc-800" role="tablist">
        <button
          v-for="item in [
            { id: 'agente', label: 'Do agente' },
            { id: 'grupo', label: 'Troca automática' },
          ] as const"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="modelsTab === item.id"
          :data-test="`models-tab-${item.id}`"
          class="shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
          :class="modelsTab === item.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
          @click="modelsTab = item.id"
        >
          {{ item.label }}
        </button>
      </nav>
      <div v-show="modelsTab === 'agente'" class="flex flex-col gap-3" role="tabpanel">
      <section class="tool-card">
        <header>
          <h3>Provedores</h3>
          <span class="count">{{ chosen.length || 'nenhum' }}</span>
        </header>
        <p class="hint px-3 pt-2">Onde o agente roda. O primeiro é o padrão.</p>
        <div class="flex flex-wrap gap-1.5 p-3">
          <button
            v-for="provider in providerOptions"
            :key="provider.id"
            type="button"
            class="chip"
            :class="{ on: chosen.includes(provider.id) }"
            @click="toggleProvider(provider.id)"
          >
            {{ provider.name }}
            <span v-if="chosen[0] === provider.id" class="ml-1 text-[10px] text-emerald-300">padrão</span>
            <span v-if="!provider.enabled" class="text-[10px] text-zinc-500">desligado</span>
          </button>
          <span v-if="!providerOptions.length" class="text-sm text-zinc-500">
            {{ chosen.length ? chosen.map((id) => protocols.providerName(id)).join(', ') : 'Nenhum provedor pronto. Configure em Modelos.' }}
          </span>
        </div>
        <small v-for="message in issues.providers" :key="message" class="error px-3 pb-3">{{ message }}</small>
      </section>
      <section v-if="form.providers.length" class="tool-card">
        <header>
          <h3>Modelos</h3>
          <span class="count">{{ form.providers.reduce((total, target) => total + target.models.length, 0) || 'nenhum' }}</span>
        </header>
        <p class="hint px-3 pt-2">Os que a pessoa escolhe na conversa. O padrão é o usado quando ninguém escolhe.</p>
        <div class="flex flex-col gap-3 p-3">
        <p v-if="dropped.length" class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-normal text-amber-200">
          <!-- Aviso, não erro: o agente salva sem eles. Numa linha só, para não sobrar espaço antes da pontuação. -->
          Não estão ativos no menu Modelos e saem do agente ao salvar: <template v-for="([providerId, models], index) in dropped" :key="providerId">{{ index ? '; ' : '' }}{{ protocols.providerName(providerId) }}: <code>{{ models.join(', ') }}</code></template>. Para manter, ative-os no menu Modelos.
        </p>
        <input v-if="manyModels" v-model="modelSearch" type="search" placeholder="Buscar modelo…" class="input text-sm" />
        <div v-for="(target, index) in form.providers" :key="target.provider" class="flex flex-col gap-1.5">
          <div class="flex items-center gap-2 text-xs font-normal">
            <span class="font-medium text-zinc-200">{{ protocols.providerName(target.provider) }}</span>
            <span v-if="index === 0" class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">provedor padrão</span>
            <button v-else type="button" class="text-zinc-400 hover:text-zinc-100" @click="makeDefaultProvider(target.provider)">tornar padrão</button>
          </div>
          <p v-if="catalogs[target.provider] === undefined" class="text-xs font-normal text-zinc-500">Carregando modelos…</p>
          <p v-else-if="!catalogs[target.provider]?.length" class="text-sm font-normal text-amber-300">
            Nenhum modelo ativado neste provedor.
            <RouterLink to="/models" class="underline">Ative em Modelos</RouterLink>
            .
          </p>
          <ul v-else class="max-h-64 divide-y divide-zinc-800/70 overflow-y-auto rounded-lg border border-zinc-800">
            <li v-for="model in visibleModels(target.provider)" :key="model.modelId" class="flex items-center gap-3 px-3 py-2 font-normal">
              <input type="checkbox" class="accent-emerald-500" :checked="target.models.includes(model.modelId)" @change="toggleModel(target, model.modelId)" />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-mono text-[13px]">{{ model.modelId }}</span>
                <span v-if="model.price" class="text-xs text-zinc-500">${{ model.price.input }} / ${{ model.price.output }} por 1M</span>
              </span>
              <span v-if="target.models[0] === model.modelId" class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">padrão</span>
              <button v-else-if="target.models.includes(model.modelId)" type="button" class="text-xs text-zinc-400 hover:text-zinc-100" @click="makeDefault(target, model.modelId)">
                tornar padrão
              </button>
            </li>
          </ul>
        </div>
        <small v-if="anyCompatible" class="hint">Neste provedor, o uso de ferramentas e o raciocínio dependem do modelo.</small>
        <small v-for="message in issues.models" :key="message" class="error">{{ message }}</small>
        </div>
      </section>
      <section class="tool-card">
        <header>
          <h3>Modos e raciocínio</h3>
        </header>
        <div class="grid gap-4 p-3 sm:grid-cols-2">
      <div class="field">
        <span>Modos</span>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="mode in ['chat', 'agent'] as TMode[]"
            :key="mode"
            type="button"
            class="chip disabled:opacity-40"
            :class="{ on: form.modes.includes(mode) }"
            :disabled="!lanesAllowed.includes(mode)"
            @click="toggle(form.modes, mode)"
          >
            {{ mode === 'chat' ? 'Conversa' : 'Agente' }}
          </button>
        </div>
        <small v-if="anySubscription" class="hint">Com assinatura, só o modo Agente. Quem conversa usa a própria assinatura.</small>
        <small v-for="message in issues.modes" :key="message" class="error">{{ message }}</small>
      </div>
      <div class="field">
        <span>Níveis de raciocínio</span>
        <div v-if="reasoningLevels.length" class="flex flex-wrap gap-1.5">
          <button
            v-for="level in reasoningLevels"
            :key="level"
            type="button"
            class="chip"
            :class="{ on: form.reasoningEfforts?.includes(level) }"
            @click="toggle((form.reasoningEfforts ??= []), level)"
          >
            {{ effortLabel(level) }}
          </button>
        </div>
        <small v-else class="hint">O Antigravity não permite escolher o nível de raciocínio.</small>
        <small v-if="reasoningLevels.length" class="hint">Os níveis que a pessoa pode escolher na conversa.</small>
        <small v-for="message in issues.reasoningEfforts" :key="message" class="error">{{ message }}</small>
      </div>
        </div>
      </section>
      </div>
      <div v-show="modelsTab === 'grupo'" role="tabpanel">
        <AgentModelGroup ref="groupPart" v-model="groupChoice" />
      </div>
    </fieldset>
    <!-- Três guias: as ferramentas do gateway, os extras que só um provedor tem e as configurações do terminal. -->
    <fieldset v-show="tab === 'ferramentas'" class="flex flex-col gap-3">
      <nav class="no-scrollbar flex gap-1 overflow-x-auto border-b border-zinc-800" role="tablist">
        <button
          v-for="item in toolTabs"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="toolsTab === item.id"
          :data-test="`tools-tab-${item.id}`"
          class="shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
          :class="toolsTab === item.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
          @click="toolsTab = item.id"
        >
          {{ item.label }}
        </button>
      </nav>
      <!-- Um bloco por assunto, no desenho das permissões: o título, quantas estão marcadas e o que o bloco quer dizer. -->
      <div v-show="toolsTab === 'gateway'" class="flex flex-col gap-3" role="tabpanel">
      <section class="tool-card">
        <header>
          <h3>Capacidades</h3>
          <span class="count">{{ agents.capabilities.filter((item) => form.allowedTools.includes(item.id)).length || 'nenhuma' }}</span>
        </header>
        <p class="hint px-3 pt-2">O que o agente pode fazer. O gateway decide como roda em cada provedor.</p>
        <div class="flex flex-wrap gap-1.5 p-3">
          <button
            v-for="item in agents.capabilities"
            :key="item.id"
            type="button"
            class="chip"
            :class="{ on: form.allowedTools.includes(item.id), danger: item.dangerous }"
            :title="item.description"
            @click="toggle(form.allowedTools, item.id)"
          >
            {{ item.label }}
          </button>
        </div>
        <dl v-if="capabilityRows.length && form.providers.length" class="mx-3 mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-zinc-900/60 px-3 py-2 text-xs">
          <template v-for="row in capabilityRows" :key="row.id">
            <dt class="text-zinc-300">{{ row.label }}</dt>
            <dd class="text-zinc-500">{{ row.runs }}</dd>
          </template>
        </dl>
      </section>

      <section v-if="agents.tools.length" class="tool-card">
        <header>
          <h3>Ferramentas do gateway</h3>
          <span class="count">{{ agents.tools.filter((tool) => form.allowedTools.includes(tool.name)).length || 'nenhuma' }}</span>
        </header>
        <p class="hint px-3 pt-2">Documentos, recursos, o painel da conversa e a assinatura SSH: rodam no gateway, em qualquer provedor.</p>
        <div class="flex flex-wrap gap-1.5 p-3">
          <button
            v-for="tool in agents.tools"
            :key="tool.name"
            type="button"
            class="chip"
            :class="{ on: form.allowedTools.includes(tool.name), danger: tool.dangerous }"
            :title="`${tool.name} — ${tool.description}`"
            @click="toggle(form.allowedTools, tool.name)"
          >
            {{ LOCAL_TOOL_LABEL[tool.name] ?? tool.name }}
          </button>
        </div>
      </section>

      <p v-if="dangerousChosen.length" class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
        ⚠ {{ dangerousChosen.join(', ') }} dá acesso ao servidor. Quem conversar com este agente também terá esse acesso.
        <template v-if="!form.adminOnly">Marque "Administradores" na guia Agente se não for para todos.</template>
      </p>
      <small v-for="message in issues.allowedTools" :key="message" class="error">{{ message }}</small>

      <section v-if="orphans.length" class="tool-card border-amber-500/40">
        <header>
          <h3>Indisponíveis</h3>
          <span class="count">{{ orphans.length }}</span>
        </header>
        <p class="hint px-3 pt-2">Escolhidas, mas não oferecidas pelos provedores. Remova para salvar.</p>
        <div class="flex flex-wrap gap-1.5 p-3">
          <button
            v-for="entry in orphans"
            :key="entry"
            type="button"
            class="chip on danger font-mono text-xs"
            title="Clique para tirar do agente"
            @click="toggle(form.allowedTools, entry)"
          >
            <span class="mr-1 rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-200">indisponível</span>
            {{ entry }} ✕
          </button>
        </div>
      </section>
      </div>
      <div v-show="toolsTab === 'provedor'" class="flex flex-col gap-3" role="tabpanel">
        <p class="text-xs text-zinc-500">Só no modo Agente: as ferramentas que só um provedor tem. Terminal, arquivos e busca ficam em Do gateway.</p>
        <p v-if="!form.modes.includes('agent')" class="text-xs text-amber-300">O modo Agente está desligado: nada daqui é usado.</p>
          <section v-for="section in toolSections" :key="section.entry.target.provider" class="tool-card">
            <header>
              <h3>{{ protocols.providerName(section.entry.target.provider) }}</h3>
              <span class="count">{{ section.tools.filter((tool) => form.allowedTools.includes(tool.id)).length || 'nenhum' }}</span>
            </header>
            <div class="flex flex-col gap-2 p-3">
        <ul v-if="section.tools.length" class="divide-y divide-zinc-800/70 rounded-lg border border-zinc-800">
          <li v-for="tool in section.tools" :key="tool.id" class="flex items-center gap-3 px-3 py-2" :class="{ 'opacity-50': nativeBlock(tool, section.entry) }">
            <input
              type="checkbox"
              class="accent-emerald-500"
              :checked="form.allowedTools.includes(tool.id)"
              :disabled="!!nativeBlock(tool, section.entry) && !form.allowedTools.includes(tool.id)"
              @change="toggle(form.allowedTools, tool.id)"
            />
            <span class="min-w-0 flex-1">
              <span class="block text-sm">
                {{ tool.label }}
                <code class="text-[11px] text-zinc-500">{{ tool.sdkName }}</code>
              </span>
              <span class="block text-xs text-zinc-500">{{ tool.description }}</span>
              <span v-if="nativeBlock(tool, section.entry)" class="block text-xs text-zinc-500">{{ nativeBlock(tool, section.entry) }}</span>
            </span>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-[10px]" :class="RISK_CLASS[tool.risk]">{{ RISK_LABEL[tool.risk] }}</span>
          </li>
        </ul>
            </div>
          </section>
        <small v-if="dangerousNatives.length" class="text-amber-300">
          ⚠ {{ dangerousNatives.join(', ') }} dá acesso ao disco, à internet e aos comandos do servidor. Quem conversar com este agente também terá esse acesso.
          <template v-if="!form.adminOnly">Marque "Administradores" na guia Agente se não for para todos.</template>
        </small>
      </div>
      <div v-show="toolsTab === 'config'" class="flex flex-col gap-4" role="tabpanel">
      <div class="flex flex-col gap-2">
        <h3 class="text-sm font-medium text-zinc-200">Terminal</h3>
        <p class="text-xs text-zinc-500">
          Para quem builda e roda teste: quanto um comando pode levar e quanto da saída volta ao modelo (o começo e o fim; o resto fica no log). Vazio = o padrão do sistema.
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="field">
            Tempo por comando (segundos, até 7200)
            <input
              class="input"
              type="number"
              min="1"
              max="7200"
              :value="form.terminal?.timeoutSeconds ?? ''"
              @input="form.terminal = { ...(form.terminal ?? {}), timeoutSeconds: Number(($event.target as HTMLInputElement).value) || undefined }"
            />
          </label>
          <label class="field">
            Saída (caracteres, até 200000)
            <input
              class="input"
              type="number"
              min="500"
              max="200000"
              :value="form.terminal?.maxOutputChars ?? ''"
              @input="form.terminal = { ...(form.terminal ?? {}), maxOutputChars: Number(($event.target as HTMLInputElement).value) || undefined }"
            />
          </label>
        </div>
      </div>
      <div class="flex flex-col gap-2">
        <h3 class="text-sm font-medium text-zinc-200">Diagnóstico depois de editar</h3>
        <p class="text-xs text-zinc-500">
          Depois de cada edição de arquivo, o gateway roda o que o pacote já tem em node_modules/.bin, no mesmo cerco do terminal e sem rede, e o resultado volta ao modelo junto da
          ferramenta.
        </p>
        <div class="flex flex-wrap gap-4 text-sm">
          <label v-for="check in DIAGNOSTIC_CHECKS" :key="check.key" class="flex items-center gap-2">
            <input
              type="checkbox"
              class="accent-emerald-500"
              :checked="!!form.diagnostics?.[check.key]"
              @change="form.diagnostics = { ...(form.diagnostics ?? {}), [check.key]: ($event.target as HTMLInputElement).checked }"
            />
            {{ check.label }}
          </label>
        </div>
        <label class="field sm:max-w-xs">
          Tempo de cada ferramenta (segundos, 5 a 600)
          <input
            class="input"
            type="number"
            min="5"
            max="600"
            placeholder="60"
            :value="form.diagnostics?.timeoutSeconds ?? ''"
            @input="form.diagnostics = { ...(form.diagnostics ?? {}), timeoutSeconds: Number(($event.target as HTMLInputElement).value) || undefined }"
          />
        </label>
      </div>
      </div>
    </fieldset>
    <fieldset v-show="tab === 'delegacao'" class="flex flex-col gap-3">
      <section class="tool-card">
        <header>
          <h3>A quem pode pedir ajuda</h3>
          <span class="count">{{ form.allowedTools.filter((entry) => entry.startsWith('agent:')).length || 'nenhum' }}</span>
        </header>
        <p class="hint px-3 pt-2">Os agentes que este chama pela ferramenta de delegação.</p>
        <div class="flex flex-col gap-3 p-3">
          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-zinc-500">Agentes</span>
            <div class="flex flex-wrap gap-1.5">
              <!-- ⛔ O servidor só aceita delegar a quem pode rodar agora (com modelo ativo): o resto aparece desligado, com o
                   motivo. O já marcado continua clicável, para poder tirar. -->
              <button
                v-for="other in agents.list.filter((candidate) => candidate.id !== form.id)"
                :key="other.id"
                type="button"
                class="chip disabled:cursor-not-allowed disabled:opacity-40"
                :class="{ on: form.allowedTools.includes(`agent:${other.id}`), danger: !!cannotRun(other) && form.allowedTools.includes(`agent:${other.id}`) }"
                :disabled="!!cannotRun(other) && !form.allowedTools.includes(`agent:${other.id}`)"
                :title="cannotRun(other) ? `Não dá para delegar: ${cannotRun(other)}. Ative um modelo dele em Modelos.` : undefined"
                @click="toggle(form.allowedTools, `agent:${other.id}`)"
              >
                {{ other.name }}
                <span v-if="other.role === 'subagent'" class="ml-1 text-[10px] text-zinc-500">subagente</span>
                <span v-if="cannotRun(other)" class="ml-1 text-[10px] text-amber-300">{{ cannotRun(other) }}</span>
              </button>
              <span v-if="agents.list.length <= 1" class="text-xs text-zinc-500">Nenhum outro agente ainda.</span>
            </div>
          </div>
          <!-- Os construtores do core: não estão na lista de agentes, mas recebem delegação (o Atlas cria conteúdo por eles). -->
          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-zinc-500">Do sistema · só para administradores</span>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="builder in CORE_BUILDERS"
                :key="builder.id"
                type="button"
                class="chip"
                :class="{ on: form.allowedTools.includes(`agent:${builder.id}`) }"
                title="Agente do sistema, só para administradores"
                @click="toggle(form.allowedTools, `agent:${builder.id}`)"
              >
                {{ builder.name }}
              </button>
            </div>
          </div>
          <small v-if="form.allowedTools.some((entry) => entry.startsWith('agent:')) && !form.modes.includes('agent')" class="hint">A delegação só funciona no modo Agente.</small>
        </div>
      </section>

      <!-- As regras de delegação do agente (padrões de id), antes na guia Permissões: moram aqui, junto da escolha. -->
      <p class="hint">Marcar acima dá a ferramenta; a regra libera a chamada. Precisa dos dois: a regra pode estar aqui ou nas permissões do projeto.</p>
      <PermissionRules v-model="form.permissions!" only="delegate" />
    </fieldset>
    <fieldset v-show="tab === 'mcps'" class="grid gap-4 sm:grid-cols-2">
      <div class="field sm:col-span-2">
        <span>
          MCPs
          <em class="font-normal text-zinc-500">— o agente usa só o que estiver marcado.</em>
        </span>
        <div v-if="enabledMcp.length" class="flex flex-col gap-2">
          <div v-for="server in enabledMcp" :key="server.key" class="rounded-xl border border-zinc-800 px-3 py-2 font-normal">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm text-zinc-200">{{ server.name }}</span>
              <span v-if="server.projectId" class="text-[11px] text-zinc-500">do projeto</span>
              <span v-if="!server.status.connected" class="text-[11px] text-amber-300">sem conexão</span>
              <span v-if="mcpWeight(server)" class="text-[11px] text-zinc-500" title="Tamanho das ferramentas escolhidas, enviado a cada mensagem">
                ≈ {{ mcpWeight(server).toLocaleString('pt-BR') }} tokens por mensagem
              </span>
              <label class="ml-auto flex items-center gap-1.5 text-xs text-zinc-400">
                <input type="checkbox" class="accent-emerald-500" :checked="form.allowedTools.includes(mcpRef(server.id, '*'))" @change="toggleAllMcp(server.id)" />
                Todas as ferramentas
              </label>
            </div>
            <div v-if="!form.allowedTools.includes(mcpRef(server.id, '*'))" class="mt-2 flex flex-wrap gap-1.5">
              <button
                v-for="tool in mcpChips(server)"
                :key="tool.name"
                type="button"
                class="chip font-mono text-xs"
                :class="{ on: form.allowedTools.includes(mcpRef(server.id, tool.name)) }"
                :title="tool.unlisted ? 'Escolhida, mas o servidor não a mostra agora' : `${tool.description ?? ''} (≈ ${toolTokens(tool)} tokens)`"
                @click="toggle(form.allowedTools, mcpRef(server.id, tool.name))"
              >
                {{ tool.name }}
                <span v-if="tool.unlisted" class="ml-1 text-[10px] text-zinc-500">não listada</span>
              </button>
              <span v-if="!mcpChips(server).length" class="text-xs text-zinc-500">Nenhuma ferramenta listada agora.</span>
            </div>
          </div>
        </div>
        <span v-else class="text-sm font-normal text-zinc-500">
          Nenhum MCP ligado.
          <RouterLink to="/mcp" class="text-emerald-400 hover:underline">Cadastre em MCPs</RouterLink>
          .
        </span>
      </div>
    </fieldset>
    <fieldset v-show="tab === 'sdk'" class="flex flex-col gap-4">
      <PermissionRequests v-if="agent && !creating" :agent-id="agent.id" @approved="permissionsApproved" />
      <div class="flex flex-col gap-2">
        <h3 class="text-sm font-medium text-zinc-200">Permissões deste agente</h3>
        <p class="text-xs text-zinc-500">
          Valem antes das do projeto: liberam o que o projeto fechou, ou fecham mais. Sem regra no agente nem no projeto, negado. As do sistema valem sempre.
        </p>
        <PermissionCategoryTabs v-model="permissionSection" :rules="form.permissions ?? []" :exclude="['delegate']" :active="permissionPane === 'rules'" @pick="permissionPane = 'rules'">
          <!-- O nível de acesso dos CLIs por assinatura (o sandbox deles): só quando algum provedor do agente o tem. -->
          <button
            v-if="accessSections.length"
            type="button"
            role="tab"
            :aria-selected="permissionPane === 'access'"
            data-test="tab-access"
            class="shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
            :class="permissionPane === 'access' ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
            @click="permissionPane = 'access'"
          >
            Nível de acesso
          </button>
        </PermissionCategoryTabs>
        <template v-if="permissionPane === 'rules'">
          <PermissionRules v-model="form.permissions!" :only="permissionSection" />
          <PermissionTester
            v-if="agent && !creating && (agent.projectId ?? projects.current)"
            :project-id="(agent.projectId ?? projects.current)!"
            :agent-id="agent.id"
            :initial="permissionSection"
          />
          <small class="hint">O teste usa as regras já salvas.</small>
        </template>
        <div v-else class="flex flex-col gap-3">
          <p class="text-xs text-zinc-500">Só no modo Agente: o quanto o CLI do provedor (por assinatura) alcança do servidor, no sandbox dele.</p>
          <p v-if="!form.modes.includes('agent')" class="text-xs text-amber-300">O modo Agente está desligado: nada daqui é usado.</p>
          <section v-for="section in accessSections" :key="section.entry.target.provider" class="tool-card">
            <header>
              <h3>{{ protocols.providerName(section.entry.target.provider) }}</h3>
              <span v-if="section.entry.info" class="count">{{ section.entry.info.label }}</span>
            </header>
            <div class="p-3">
        <div v-if="section.levels.length" class="flex flex-col gap-1.5">
          <span class="text-xs text-zinc-400">Nível de acesso</span>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="level in section.levels"
              :key="level"
              type="button"
              class="chip"
              :class="{ on: (section.entry.target.sandbox ?? section.levels[0]) === level, danger: level === 'full' }"
              :title="sandboxHint(section.entry.protocol, level)"
              @click="setSandbox(section.entry, section.levels, level)"
            >
              {{ sandboxLabel(section.entry.protocol, level) }}
              <span v-if="level === section.levels[0]" class="ml-1 text-[10px] text-zinc-500">padrão</span>
            </button>
          </div>
          <small class="hint">{{ sandboxHint(section.entry.protocol, section.entry.target.sandbox ?? section.levels[0]) }}</small>
          <label v-if="section.network" class="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              class="accent-emerald-500"
              :checked="!!section.entry.target.network"
              @change="section.entry.target.network = !section.entry.target.network || undefined"
            />
            Acesso à internet
          </label>
        </div>

            </div>
          </section>
          <small v-if="openSandboxes.length" class="text-amber-300">
            ⚠ {{ openSandboxes.join(', ') }}: acesso total. Quem conversar com este agente também terá esse acesso.
            <template v-if="!form.adminOnly">Marque "Administradores" na guia Agente se não for para todos.</template>
          </small>
        </div>
      </div>
    </fieldset>

    <p v-if="failure && !Object.keys(issues).length" class="text-sm whitespace-pre-line text-rose-300">{{ failure }}</p>
    <!-- O erro de campo aparece junto do campo, que pode estar fora da tela: aqui, perto do Salvar, o resumo. -->
    <p v-else-if="Object.keys(issues).length" class="text-sm text-rose-300">Não foi possível salvar. Corrija: {{ summarizeIssues(issues, FIELD_LABEL) }}</p>
    <!-- ⚖️ Os recursos (skills e commands) têm o próprio cadastro (fora do Salvar do agente): só para agente já gravado. -->
    <!-- ⚖️ Recursos, Arquivos e Contexto inicial ficam montados (v-show): o rascunho de cada uma vai no "Salvar agente". -->
    <section v-show="tab === 'recursos'">
      <AgentResources
        v-if="agent && !creating"
        ref="resourcesPart"
        embedded
        :agent-id="agent.id"
        :project-id="agent.projectId"
        :project-name="projects.list.find((item) => item.id === agent?.projectId)?.name"
      />
      <p v-else class="text-sm text-zinc-400">Salve o agente primeiro para usar esta guia.</p>
    </section>

    <!-- Os arquivos moram na pasta do agente: só para agente já gravado. -->
    <section v-show="tab === 'arquivos'">
      <ResourceFiles
        v-if="agent && !creating"
        ref="filesPart"
        embedded
        :files="agentFiles"
        :where="`${agent.projectId ? `projects/${agent.projectId}` : 'global'}/agents/${agent.id}`"
        :save="saveAgentFiles"
        owned
      />
      <p v-else class="text-sm text-zinc-400">Salve o agente primeiro para usar esta guia.</p>
    </section>

    <!-- O contexto inicial: só para agente já gravado. -->
    <section v-show="tab === 'contexto'">
      <AgentInitialContext
        v-if="agent && !creating"
        ref="contextPart"
        :agent-id="agent.id"
        :project-id="agent.projectId"
        :project-name="projects.list.find((item) => item.id === agent?.projectId)?.name"
      />
      <p v-else class="text-sm text-zinc-400">Salve o agente primeiro para usar esta guia.</p>
    </section>

    <!-- O tamanho é medido no servidor, sobre o agente salvo: só para agente já gravado. -->
    <section v-if="tab === 'tamanho'">
      <AgentFootprint v-if="agent && !creating" :agent-id="agent.id" :project-id="agent.projectId" />
      <p v-else class="text-sm text-zinc-400">Salve o agente primeiro para usar esta guia.</p>
    </section>

    <!-- ⚖️ Os hooks têm o próprio cadastro (não vão no Salvar do agente): só existem para um agente já gravado. -->
    <section v-if="tab === 'hooks'">
      <AgentHooks v-if="agent && !creating" :agent-id="agent.id" />
      <p v-else class="text-sm text-zinc-400">Salve o agente primeiro para usar esta guia.</p>
    </section>

    <!-- Os agendamentos também têm o próprio cadastro, como os hooks. -->
    <section v-if="tab === 'agendamentos'">
      <AgentSchedules v-if="agent && !creating" :agent-id="agent.id" :project-id="agent.projectId" />
      <p v-else class="text-sm text-zinc-400">Salve o agente primeiro para usar esta guia.</p>
    </section>

    <!-- O ledger (a memória durável do agente) tem o próprio cadastro, como os hooks: fora do Salvar do agente. -->
    <section v-if="tab === 'memoria'">
      <AgentLedger v-if="agent && !creating" :agent-id="agent.id" />
      <p v-else class="text-sm text-zinc-400">Salve o agente primeiro para usar esta guia.</p>
    </section>

    <section v-if="tab === 'problemas' && agent">
      <ImportIssues :issues="importIssues" :resolve="(issue) => agents.resolveIssue(agent!.id, issue)" />
    </section>

    <!-- O histórico do agente: as revisões, o diff e "Restaurar esta versão" (grava pelo histórico, fora do Salvar). -->
    <section v-if="tab === 'historico'">
      <HistoryPanel
        v-if="agent && !creating"
        kind="agent"
        :id="agent.id"
        @restored="(result) => (result.exists ? emit('saved', agent!.id) : emit('removed'))"
      />
      <p v-else class="text-sm text-zinc-400">Salve o agente primeiro para usar esta guia.</p>
    </section>

    <p v-if="agent?.updatedBy" class="text-xs text-zinc-500">
      Alterado por {{ agent.updatedBy }} em {{ agent.updatedAt ? new Date(agent.updatedAt).toLocaleString('pt-BR') : '' }}
    </p>

    <p v-if="loadError" class="text-sm text-rose-300">
      Não foi possível carregar os provedores ({{ loadError }}), então não dá para salvar.
      <button type="button" class="underline hover:text-rose-200" @click="loadBase">Tentar de novo</button>
    </p>
    <p v-else-if="!ready" class="text-xs text-zinc-500">Carregando provedores…</p>

    </fieldset>

    <section v-if="tab === 'compartilhar' && canShare && agent" class="flex flex-col gap-3">
      <ShareProjects :owner="agent.projectId ?? ''" :shared="sharedNow" :save="saveShares" description="O outro projeto conversa com o agente, sem editar. A conversa roda na pasta e nas regras do projeto de lá. Segredos não vão junto: cada projeto configura os seus." />
    </section>

    <!-- As variáveis secretas também têm o próprio cadastro: fora do Salvar do agente. -->
    <!-- ⚖️ As duas formas de variável do terminal, juntas: as fixas (texto, no registro do agente, gravadas com o Salvar) e
         as secretas (cifradas; o valor só entra, gravado à parte). Chegam ao mesmo terminal; a secreta vence a fixa. -->
    <section v-if="tab === 'variaveis'" class="flex flex-col gap-3">
      <fieldset :disabled="locked" class="contents">
      <section class="tool-card">
        <header>
          <h3>Fixas</h3>
          <span class="count">{{ envList.length || 'nenhuma' }} · salvas com o botão Salvar do agente</span>
        </header>
        <div class="flex flex-col gap-2 p-3">
        <p class="hint">
          Texto comum, em todo terminal deste agente (o dele e o dos CLIs): a autoria do git (GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL…), idioma, região. O que o gateway monta
          (HOME, PATH, a identidade) vence. Segredo não mora aqui: vai em Secretas, logo abaixo, ou nas contas do projeto.
        </p>
        <div v-for="(row, index) in envList" :key="index" class="flex flex-wrap items-center gap-2">
          <input v-model="row.name" class="input w-56 font-mono text-xs" placeholder="GIT_AUTHOR_NAME" :aria-label="`Nome da variável ${index + 1}`" />
          <input v-model="row.value" class="input min-w-0 flex-1 font-mono text-xs" placeholder="valor" :aria-label="`Valor da variável ${index + 1}`" />
          <button type="button" class="btn btn-sm btn-danger" @click="envList.splice(index, 1)">Remover</button>
        </div>
        <button type="button" class="btn btn-sm btn-ghost self-start" @click="envList.push({ name: '', value: '' })">+ Variável</button>
        <small v-for="name in envRepeated" :key="`dup-${name}`" class="error">{{ name }} aparece mais de uma vez</small>
        <small v-for="message in issues.env" :key="message" class="error">{{ message }}</small>
        </div>
      </section>
      </fieldset>
      <section class="tool-card">
        <header>
          <h3>Secretas</h3>
          <span class="count">cifradas · cada uma é gravada na hora, à parte do Salvar</span>
        </header>
        <div class="p-3">
          <p v-if="sharedFrom && agent && !creating" class="mb-2 text-sm text-sky-200" data-test="shared-secrets">Valores deste projeto (não vêm do projeto de origem)</p>
          <SecretVariables v-if="agent && !creating && !globalLocked" :base-path="`/agents/${encodeURIComponent(agent.id)}`" :project="sharedFrom ? projects.current : undefined" scope-label="deste agente (sempre disponíveis para ele)" />
          <p v-else-if="globalLocked" class="text-sm text-zinc-400">Só quem administra o gateway cadastra variável secreta de agente global.</p>
          <p v-else class="text-sm text-zinc-400">Salve o agente primeiro para cadastrar variável secreta.</p>
        </div>
      </section>
    </section>


    <!-- O rodapé com o Salvar fica preso embaixo, à vista em qualquer guia, por mais longa que seja. -->
    <div v-if="!sharedFrom" v-show="!FOOTERLESS_TABS.includes(tab)" class="form-footer flex gap-2">
      <button v-if="!locked" type="submit" :disabled="saving || !ready || !!loadError || !form.providers.length" class="btn btn-primary">
        {{ saving ? 'Salvando…' : creating ? 'Criar agente' : 'Salvar agente' }}
      </button>
      <button v-if="!creating && agent" type="button" class="btn btn-secondary" @click="emit('duplicate', agent)">Duplicar agente</button>
      <button v-if="!creating && agent && !locked" type="button" class="btn btn-danger ml-auto" @click="confirming = true">Apagar agente</button>
    </div>
    <ConfirmDialog
      :open="confirmingSave"
      :title="`${creating ? 'Criar' : 'Salvar'} o agente ${form.name}?`"
      :message="saveSummary"
      :action="creating ? 'Criar' : 'Salvar'"
      tone="neutral"
      @confirm="save"
      @cancel="confirmingSave = false"
    />
    <ConfirmDialog
      :open="confirming"
      :title="`Apagar o agente ${agent?.name ?? ''}?`"
      message="O agente sai da lista e não abre mais conversas. As conversas já feitas continuam."
      :busy="deleting"
      @confirm="remove"
      @cancel="confirming = false"
    />
  </form>
</template>

<style scoped>
  @reference '../style.css';

  .field {
    @apply flex flex-col gap-1.5 text-sm font-medium text-zinc-300;
  }
  .input {
    @apply rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
  }
  .hint {
    @apply text-xs font-normal text-zinc-500;
  }
  .prompt-area {
    /* A tela menos o que fica em volta: o topo, o cabeçalho do agente, as guias, o rótulo, as dicas e o rodapé (a
       Personalidade e o System Prompt). */
    height: max(18rem, calc(100dvh - 24rem));
    resize: vertical;
  }
  .form-footer {
    @apply sticky -bottom-5 z-10 -mx-4 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur;
  }
  .tool-card {
    @apply rounded-xl border border-zinc-800;
  }
  .tool-card > header {
    @apply flex items-baseline gap-2 border-b border-zinc-800 px-3 py-2;
  }
  .tool-card h3 {
    @apply text-sm font-medium text-zinc-200;
  }
  .tool-card .count {
    @apply text-xs text-zinc-500;
  }
  .error {
    @apply text-xs font-normal text-rose-300;
  }
  .chip.danger.on {
    @apply border-amber-500/60 bg-amber-500/15 text-amber-200;
  }
  .switch {
    @apply relative h-6 w-11 shrink-0 rounded-full bg-zinc-700 transition-colors;
  }
  .switch span {
    @apply absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform;
  }
  .switch.on {
    @apply bg-emerald-500;
  }
  .switch.on span {
    @apply translate-x-5;
  }
</style>
