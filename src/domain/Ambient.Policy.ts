/**
 * ⚖️ O MÍNIMO QUE O AGENTE SABE SEM GASTAR FERRAMENTA: quem ele é (o id), em que projeto está e onde opera (o diretório).
 * Vai no system prompt, uma vez (ver `composeSystemPrompt`): é estável na sessão. O id da conversa não está aqui — nasce
 * depois da composição e a sessão pode adotar outro — e vai na entrada do modelo (ver `conversationNote`).
 */
export interface IAmbient {
  agentId: string
  /** O projeto da conversa. `own`: o agente é dele, e trabalha na pasta dele. */
  project?: { id: string; name?: string; own: boolean }
  /** Aberta num repositório do projeto (e numa worktree dele). */
  repository?: { name: string; worktree?: string; branch?: string }
  /**
   * O diretório de operação: o do repositório ou da worktree, senão o do projeto do agente. É o `cwd` das lanes de código
   * (Claude Agent SDK, Codex) e a raiz das ferramentas do gateway (`run_bash`, arquivos). Ausente: a pasta vazia da conversa.
   */
  directory?: string
  /** A pasta PRIVADA do agente e se ele grava nela (ver `agentFolderAccess`). Ausente: ele não a alcança. */
  files?: { dir: string; write: boolean }
  /** As variáveis secretas que o agente pode usar (só os nomes; ver `ResourceSecret.Model`). */
  secrets?: IAmbientSecrets
  /** A conversa tem o painel (ver `ConversationPanel.Model`). */
  panel?: boolean
  /** O agente tem o terminal: a linha da pasta temporária (o `/tmp` dele some a cada comando). */
  terminal?: boolean
  /**
   * O agente fala com outros (`agent:<id>`): a linha do `talk`. `legacy`: o prompt dele ainda cita o `delegate_to_agent`,
   * o nome de antes — a linha diz que agora é `talk`.
   */
  talk?: { legacy: boolean }
  /** O agente arma vigia nesta conversa (ver `Watch.Model`): a regra de espera cita as ferramentas. Ausente: só a proibição. */
  watch?: boolean
}

/** Os NOMES das variáveis secretas: as do agente e as de cada skill ou command que ele pode carregar. */
export interface IAmbientSecrets {
  agent: string[]
  /** As secretas do projeto da conversa (valem para todo agente dele, por baixo das suas). */
  project?: string[]
  resources: Array<{ kind: 'skill' | 'command'; id: string; names: string[] }>
}

/**
 * ⚖️ COMO FALAR COM OUTRO AGENTE: uma ferramenta só, o `talk`. Os agentes procuravam `send_message` (que é de pessoa) e não
 * sabiam que dava para continuar a conversa que a pessoa já tem com o outro agente.
 */
export function talkLine(legacy: boolean): string {
  return `- Outro agente: fale com \`talk\` — sem nada, mostra com quem você fala e as conversas abertas; \`conversation\` continua uma conversa (inclusive a que a pessoa já tem com ele, pelo id que ela passar); \`wait: 0\` não espera, e a resposta chega depois aqui. Não existe \`send_message\` nem \`start_conversation\` para você.${legacy ? ' Onde o seu prompt diz `delegate_to_agent`, use `talk`.' : ''}`
}

/** A seção "## Ambiente" do system prompt. */
export function ambientSection(ambient: IAmbient): string {
  const lines = ['## Ambiente', `- Agente: ${ambient.agentId}.`]
  const { project, repository, directory } = ambient
  if (project) {
    const label = project.name ? `${project.name} (projectId "${project.id}")` : `projectId "${project.id}"`
    lines.push(project.own || repository ? `- Projeto: ${label}.` : `- Projeto atual: ${label}. Agentes, hooks e conversas que você criar aqui pertencem a este projeto.`)
  }
  if (repository)
    lines.push(`- Repositório: ${repository.name}${repository.worktree ? `, worktree ${repository.worktree}` : ''}${repository.branch ? ` (branch ${repository.branch})` : ''}.`)
  if (!directory) lines.push('- Diretório de trabalho: uma pasta vazia, só desta conversa.')
  else if (repository) lines.push(`- Diretório de trabalho: ${directory}. Fora dele você não lê nem grava; o git dele funciona (status, commit, push).`)
  else lines.push(`- Diretório de trabalho: ${directory} — persistente e compartilhado pelas conversas do projeto. Fora dele você não lê nem grava.`)
  if (ambient.files) lines.push(agentFolderLine(ambient.files))
  if (ambient.terminal) lines.push(TEMP_LINE)
  if (ambient.talk) lines.push(talkLine(ambient.talk.legacy))
  lines.push(waitLine(ambient))
  if (ambient.panel)
    lines.push(
      '- Arquivo para a pessoa (CSV, relatório, imagem, PDF): entregue com `deliver_file` — ela baixa pelo botão na conversa. Ela não abre a sua pasta; não mande o caminho.',
    )
  if (ambient.panel)
    lines.push(
      '',
      '## Painel da conversa',
      'A pessoa vê, ao lado da conversa, o painel que VOCÊ mantém com `conversation_panel`, sem precisar pedir. O resumo dele vem no começo de cada turno: siga a rota, não se desvie.',
      '- **Um item por pedido.** Separe a mensagem da pessoa em pedidos distintos, e cada um vira um item da fila (`add`), com título curto do que foi pedido. Nunca um item genérico que junta tudo ("ajustes", "melhorias").',
      '- **O ciclo do item:** começou → `doing`; entregou → `done`, com o que entregou e os links; travou → `blocked`, com o motivo. O rumo mudou → `set_goal`; o combinado → `decide`; o que depende dela → `ask`.',
      '- **As etapas do item vão no `update_todos`**: ao começar um item com mais de um passo, liste os passos dele; um em andamento por vez; marque o feito na hora. Passos curtos, sem texto corrido.',
    )
  if (ambient.secrets) lines.push('', secretsSection(ambient.secrets))
  return lines.join('\n')
}

/**
 * ⛔ A PROMESSA VAZIA: o agente só fala quando recebe mensagem, e "quando terminar eu te aviso" sem nada conferindo deixava
 * a pessoa esperando um aviso que não vinha. Todo agente recebe a proibição; quem arma vigia recebe o caminho.
 */
export function waitLine(ambient: Pick<IAmbient, 'watch' | 'terminal'>): string {
  const head = '- Você não volta sozinho a esta conversa: só fala quando recebe mensagem.'
  if (!ambient.watch) return `${head} Não prometa avisar depois ("te aviso quando…"): nada o traz de volta. Diga o que ficou pendente e que é preciso perguntar de novo.`
  const tools = ambient.terminal
    ? '`watch_start` (um comando confere de tempos em tempos; a conversa retoma quando ele sair com 0) ou `wake_me` (acorda num horário, para o que só uma ferramenta enxerga)'
    : '`wake_me` (acorda esta conversa num horário; você confere e continua)'
  return `${head} Para esperar algo: se é curto (até uns minutos), espere DENTRO do turno e confira antes de responder; se é longo, arme uma vigia — ${tools}. Só prometa "te aviso quando…" com a vigia armada; sem ela, diga que é preciso perguntar de novo.`
}

/**
 * ⛔ As variáveis secretas: o agente sabe o NOME e usa `$NOME` no terminal; o valor nunca passa por ele. Imprimir é recusado
 * e o que sair com o valor é mascarado.
 */
function secretsSection(secrets: IAmbientSecrets): string {
  const lines = [
    '## Variáveis secretas',
    'Estão no ambiente dos seus comandos: use `$NOME` (ex.: `curl -H "Authorization: Bearer $NOME"`). Nunca as imprima, copie para arquivo nem as passe ao modelo; o valor não está aqui de propósito. Falta uma? Peça com `request_secret`.',
  ]
  if (secrets.agent.length) lines.push(`- Suas: ${secrets.agent.map((name) => `\`${name}\``).join(', ')}.`)
  if (secrets.project?.length) lines.push(`- Do projeto: ${secrets.project.map((name) => `\`${name}\``).join(', ')}.`)
  for (const resource of secrets.resources)
    lines.push(`- ${resource.kind === 'skill' ? 'Skill' : 'Command'} ${resource.id} (valem depois de carregá-la): ${resource.names.map((name) => `\`${name}\``).join(', ')}.`)
  return lines.join('\n')
}

/**
 * O id da conversa, na ENTRADA do modelo: no primeiro turno e quando o histórico do modelo recomeça (repasse, compactação,
 * retomada). ⛔ Não é gravado, não aparece na tela, não entra na transcrição: é do sistema, não da pessoa.
 */
export function conversationNote(conversationId: string): string {
  return `<contexto>id desta conversa: ${conversationId}</contexto>`
}

/**
 * ⛔ A pasta PRIVADA do agente, como ele a recebe: é dele, persistente e só dele (nenhum outro agente a alcança), e vale
 * em todas as conversas dele, de qualquer pessoa. Grava só com Escrever arquivos (`write`).
 */
export function agentFolderLine(files: { dir: string; write: boolean }): string {
  const use = files.write
    ? 'leia e grave nela seus scripts, notas e dados de trabalho (o caminho absoluto, pelas ferramentas de arquivo ou pelo terminal)'
    : 'leia e rode por ela seus scripts e modelos (só leitura para você: gravar pede Escrever arquivos)'
  return `- Sua pasta: ${files.dir} — privada, sua: nenhum outro agente a vê. Persiste entre conversas e vale em todas as suas, de qualquer pessoa: não guarde nela o que uma pessoa não pode ver da outra. ${use[0]!.toUpperCase()}${use.slice(1)}. Quem cuida do gateway também pode pôr arquivos nela.`
}

/**
 * ⚖️ O terminal roda isolado: o `/tmp` dele é novo a cada comando (o arquivo gravado num some no seguinte), e os agentes
 * gastavam tentativas nisso. O `$TMPDIR` persiste (fica na pasta do projeto, fora do git).
 */
export const TEMP_LINE =
  '- Arquivos temporários: use `$TMPDIR` (persiste entre os comandos do terminal). O `/tmp` do terminal é seu e some no fim do comando: o que você grava nele não existe no seguinte; para guardar entre comandos, use a pasta tmp do projeto (`$TMPDIR`).'
