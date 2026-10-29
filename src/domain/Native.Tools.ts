import { EProvider } from './enums/EProvider.Enum'

/**
 * Onde uma ferramenta nativa roda — e, por isso, o que ela alcança.
 *
 * ⚖️ A LINHA É A MÁQUINA DO GATEWAY: `hosted` roda no fornecedor (busca, sandbox dele) e `session` só mexe
 * no estado da conversa; as `server-*` rodam NESTE servidor — saem para a rede dele, leem o disco dele
 * (`.env`, `secrets.key`, o banco), escrevem e executam nele. É informação para quem configura o agente,
 * não trava: todas valem, e quem cria o agente decide se ele é só para admin (`IAgent.adminOnly`).
 */
export type TNativeToolRisk = 'hosted' | 'session' | 'server-network' | 'server-read' | 'server-exec'

export interface INativeTool {
  /** O id gravado em `agent.allowedTools`. O prefixo `sdk:` impede colisão com tool local ou do MCP. */
  id: string
  protocol: EProvider
  /** O nome que o SDK conhece. */
  sdkName: string
  label: string
  description: string
  risk: TNativeToolRisk
  /** Só com o provider OFICIAL: depende de recurso que os compatíveis não têm (a Responses API). */
  officialOnly: boolean
  /**
   * Os nomes que o SDK de HOJE liga para esta ferramenta, quando mudaram. O id gravado nos agentes
   * fica o mesmo; só o que vai ao CLI muda.
   */
  sdkNames?: readonly string[]
}

export const NATIVE_TOOL_PREFIX = 'sdk:'

const claude = (sdkName: string, label: string, description: string, risk: TNativeToolRisk): INativeTool => ({
  id: `${NATIVE_TOOL_PREFIX}${sdkName}`,
  protocol: EProvider.CLAUDE,
  sdkName,
  label,
  description,
  risk,
  officialOnly: false,
})
const hosted = (protocol: EProvider, sdkName: string, label: string, description: string, officialOnly: boolean): INativeTool => ({
  id: `${NATIVE_TOOL_PREFIX}${protocol}:${sdkName}`,
  protocol,
  sdkName,
  label,
  description,
  risk: 'hosted',
  officialOnly,
})

/**
 * As ferramentas nativas que um agente pode receber, por protocolo, das versões instaladas dos SDKs.
 *
 * ⚖️ CURADA, não descoberta: nenhum SDK tem uma API que liste "o que existe", e boa parte do que o
 * Claude Agent SDK expõe é do Claude Code (worktree, cron, workflow) e não faz sentido aqui. Fora, por
 * ora: `fileSearchTool` (precisa de vector store), `computer`/`shell`/`applyPatch` (precisam de uma
 * implementação na máquina) e o `Task` do Claude (subagente que herda tudo). Do Codex ficam travados os
 * conectores da conta (`apps`), navegador, computer use, plugins, skills, hooks e subagentes.
 */
export const NATIVE_TOOLS: readonly INativeTool[] = [
  claude('WebSearch', 'Busca na web', 'Busca na internet, feita pela Anthropic.', 'hosted'),
  // A lista de tarefas NÃO é nativa: é a do gateway (`update_todos`), igual em todo provedor e visível na conversa.
  claude('WebFetch', 'Abrir página', 'Baixa uma URL A PARTIR DESTE SERVIDOR — alcança a rede interna dele.', 'server-network'),
  claude('Read', 'Ler arquivo', 'Lê qualquer arquivo deste servidor, inclusive .env, chaves e o banco.', 'server-read'),
  claude('Glob', 'Procurar arquivos', 'Lista arquivos deste servidor por padrão de nome.', 'server-read'),
  claude('Grep', 'Buscar em arquivos', 'Procura texto nos arquivos deste servidor.', 'server-read'),
  claude('Write', 'Escrever arquivo', 'Cria e sobrescreve arquivos neste servidor.', 'server-exec'),
  claude('Edit', 'Editar arquivo', 'Altera arquivos deste servidor.', 'server-exec'),
  claude('NotebookEdit', 'Editar notebook', 'Altera notebooks Jupyter neste servidor.', 'server-exec'),
  claude('Bash', 'Terminal', 'Executa comandos neste servidor, sem as travas do run_bash.', 'server-exec'),
  hosted(EProvider.OPENAI, 'web_search', 'Busca na web', 'Busca na internet, feita pela OpenAI.', true),
  hosted(EProvider.OPENAI, 'code_interpreter', 'Interpretador de código', 'Roda Python num sandbox da OpenAI.', true),
  hosted(EProvider.OPENAI, 'image_generation', 'Gerar imagem', 'Gera imagens na OpenAI.', true),
  hosted(EProvider.GOOGLE, 'google_search', 'Google Search', 'Busca no Google, feita pelo Gemini.', true),
  hosted(EProvider.GOOGLE, 'url_context', 'Contexto de URL', 'O Gemini lê páginas pela infraestrutura do Google.', true),
  hosted(EProvider.GOOGLE, 'code_execution', 'Execução de código', 'Roda código no sandbox do Gemini.', true),
  hosted(EProvider.CODEX, 'web_search', 'Busca na web', 'Busca na internet, feita pelo Codex na conta do ChatGPT.', false),
  // As do Codex são `features` do CLI (`CODEX_LOCKED_FEATURES`): ligar a nativa destrava a feature, e o
  // `sdkNames` diz quais. O alcance real depende do sandbox do agente naquele provider (`Sandbox.Policy`).
  {
    ...hosted(EProvider.CODEX, 'shell', 'Terminal', 'Executa comandos NESTE SERVIDOR, dentro do sandbox escolhido no provider (lê o disco já no read-only).', false),
    risk: 'server-exec',
    sdkNames: ['shell_tool', 'unified_exec'],
  },
  { ...hosted(EProvider.CODEX, 'view_image', 'Ver imagem', 'Abre imagens do disco deste servidor.', false), risk: 'server-read' },
  hosted(EProvider.CODEX, 'image_generation', 'Gerar imagem', 'Gera imagens na conta do ChatGPT.', false),
]

export function isNativeTool(id: string): boolean {
  return id.startsWith(NATIVE_TOOL_PREFIX)
}

export function nativeTool(id: string): INativeTool | undefined {
  return NATIVE_TOOLS.find((tool) => tool.id === id)
}

/** As ferramentas nativas ligadas de um agente, para um protocolo. */
export function nativeToolsOf(allowedTools: readonly string[], protocol: EProvider): INativeTool[] {
  return NATIVE_TOOLS.filter((tool) => tool.protocol === protocol && allowedTools.includes(tool.id))
}
