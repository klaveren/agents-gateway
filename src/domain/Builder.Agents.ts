import { IAgent, IAgentTarget } from './models/Agent.Model'
import { ICoreProtocol, PROTOCOL_KINDS, TProtocolKind } from './models/Protocol.Model'
import { EMode } from './enums/EMode.Enum'
import { ADR_PROTOCOL } from './protocols/Adr.Protocol'
import { AGENT_PROTOCOL } from './protocols/Agent.Protocol'
import { COMMAND_PROTOCOL } from './protocols/Command.Protocol'
import { KNOWLEDGE_PROTOCOL } from './protocols/Knowledge.Protocol'
import { RULE_PROTOCOL } from './protocols/Rule.Protocol'
import { SKILL_PROTOCOL } from './protocols/Skill.Protocol'
import { SPEC_PROTOCOL } from './protocols/Spec.Protocol'

/**
 * O CONSTRUTOR: a conversa guiada que segue o protocolo do core, entrega um rascunho e — quando a pessoa confirma na
 * conversa — grava pelo MCP do gateway, como o Atlas.
 *
 * ⚖️ NÃO É UM AGENTE DO CATÁLOGO. É capacidade do core: definido aqui, chega atualizado com a imagem, não aparece em
 * Agentes, não se edita, não se libera e não recebe delegação. O único botão de quem administra é o modelo
 * (`builderProvider`/`builderModel` nas configurações).
 */
export const PROTOCOLS: Readonly<Record<TProtocolKind, ICoreProtocol>> = {
  skill: SKILL_PROTOCOL,
  command: COMMAND_PROTOCOL,
  rule: RULE_PROTOCOL,
  spec: SPEC_PROTOCOL,
  adr: ADR_PROTOCOL,
  knowledge: KNOWLEDGE_PROTOCOL,
  agent: AGENT_PROTOCOL,
}

/** A ferramenta com que o construtor entrega o rascunho. Interna: só os agentes do core a recebem. */
export const PROPOSE_DRAFT_TOOL = 'propose_draft'

/** A chave do `metadata` que marca a conversa como uma construção (o valor é o tipo). Fora da caixa de entrada. */
export const BUILDER_METADATA_KEY = 'builder'

interface IBuilderKind {
  /** Como o prompt chama o artefato ("uma spec"). */
  article: string
  name: string
  /** As ferramentas do MCP do gateway: a leitura do que existe e a de gravar. */
  read: string[]
  save: string
  /** O que dizer depois de gravar. */
  after: string
  /** Ferramentas além das do gateway (a pesquisa na web do construtor de conhecimento). */
  extra?: string[]
  /** O passo 1 do fluxo, quando não é "pergunte o que faltar". */
  intake?: string
  /** As outras gravações do mesmo rascunho, na mesma confirmação (o contexto inicial e os recursos do agente). */
  saveAlso?: string[]
}

const KINDS: Readonly<Record<TProtocolKind, IBuilderKind>> = {
  skill: {
    article: 'uma skill',
    name: 'Construtor de skills',
    read: ['list_resources'],
    save: 'save_resource',
    after: 'Avise que os agentes do escopo dela já podem usá-la (menos os que têm a guia Recursos restrita).',
  },
  command: {
    article: 'um command',
    name: 'Construtor de commands',
    read: ['list_resources'],
    save: 'save_resource',
    after: 'Avise que já dá para dispará-lo com /nome nos agentes do escopo dele (menos os que têm a guia Recursos restrita).',
  },
  rule: {
    article: 'uma rule',
    name: 'Construtor de rules',
    read: ['list_rules'],
    save: 'save_rule',
    after: 'Avise que ela vale para as conversas que começarem agora, e que está em Projeto → Rules (e no Ambiente do projeto).',
  },
  spec: {
    article: 'uma spec',
    name: 'Construtor de specs',
    read: ['list_docs', 'get_doc'],
    save: 'save_doc',
    after: 'Avise que ela entra no índice das conversas novas, e que pode ir inteira no contexto inicial do projeto ou de um agente.',
  },
  adr: {
    article: 'uma ADR',
    name: 'Construtor de ADRs',
    read: ['list_docs', 'get_doc'],
    save: 'save_doc',
    after: 'Avise que ela entra no índice das conversas novas.',
  },
  knowledge: {
    article: 'um estudo de conhecimento',
    name: 'Construtor de conhecimento',
    read: ['list_docs', 'get_doc'],
    save: 'save_doc',
    after: 'Avise que ele entra no índice das conversas novas e que é a base para as specs, skills e ADRs do tema.',
    // ⚖️ A pesquisa: a busca e a leitura nativas do Claude (leem a fonte inteira); em outro provider, a busca local.
    extra: ['cap:web.search', 'cap:web.fetch'],
    intake:
      'Classifique o pedido (é conhecimento?) e PESQUISE sem perguntar — só pergunte se o tema for ambíguo. Busque as fontes na ordem do protocolo e LEIA as que citar; anote URL e data de acesso.',
  },
  agent: {
    article: 'um agente',
    name: 'Construtor de agentes',
    read: [
      'list_agents',
      'get_agent',
      'list_projects',
      'list_providers',
      'list_models',
      'list_tools',
      'list_docs',
      'get_doc',
      'list_resources',
      'get_agent_initial_context',
      'get_agent_resources',
    ],
    save: 'save_agent',
    saveAlso: ['set_agent_initial_context', 'set_agent_resources'],
    after:
      'Grave o contexto inicial (set_agent_initial_context) e os recursos (set_agent_resources) que o rascunho trouxer, na mesma confirmação. Depois, dê o link /agents/<id> e diga quantos tokens o agente pesa por conversa (a guia Tamanho mostra).',
  },
}

/** O id do construtor de um tipo. */
export function builderAgentId(kind: TProtocolKind): string {
  return `builder-${kind}`
}

/** Os ids reservados do core: nenhum agente do catálogo pode nascer com eles. */
export const CORE_AGENT_IDS: readonly string[] = PROTOCOL_KINDS.map(builderAgentId)

/** O tipo que este agente constrói, ou nada (não é construtor). */
export function builderKindOf(agentId: string | undefined): TProtocolKind | undefined {
  return PROTOCOL_KINDS.find((kind) => builderAgentId(kind) === agentId)
}

const SOUL = `Você é o Construtor do gateway: ajuda quem administra a criar artefatos agênticos bem-feitos, seguindo o protocolo do core.
Direto e preciso, em português claro. Pergunta uma coisa por vez. Não inventa: o que existe no gateway você consulta.`

function prompt(kind: TProtocolKind): string {
  const { article, read, save, after, intake } = KINDS[kind]
  return `Você constrói ${article} por conversa, com quem administra: entrega um rascunho e, quando a pessoa confirmar, grava.

## Como trabalhar
1. ${intake ?? 'Entenda o pedido: o que é, para quem, em que projeto. Pergunte o que faltar, uma coisa por vez.'}
2. Confira o que já existe ("O que já existe", abaixo; o conteúdo inteiro com ${read.join(' e ')}). Se já houver um parecido, diga qual e proponha ajustá-lo em vez de criar outro.
3. Procure o conhecimento, as specs e as ADRs relacionadas: busque pelo assunto com search_docs (acha no texto, não só no título) e leia com read_doc. O estudo de conhecimento do tema é a base: parta dele. Cite ou anexe em vez de copiar regra.
4. Monte o rascunho seguindo o protocolo abaixo e o complemento de quem administra (o complemento vem depois e acrescenta; em conflito, vale o complemento).
5. Entregue com ${PROPOSE_DRAFT_TOOL}. Se ela devolver problemas, corrija e entregue de novo. Depois, diga em uma ou duas frases o que propôs, que o rascunho está ao lado e pergunte se pode gravar.
6. A pessoa pediu mudança: ajuste e entregue de novo com ${PROPOSE_DRAFT_TOOL}.
7. ⛔ Só grave com ${save} DEPOIS que a pessoa disser nesta conversa (ou o agente que delegou trouxer a confirmação dela) que pode gravar — e grave exatamente o último rascunho entregue (mesmo id, texto e escopo). Sem confirmação explícita, não grave. ${after}

## Quando outro agente delega a você
Quem fala com você é ele (o Atlas, por exemplo), não a pessoa: ele mostra o rascunho a ela e traz a resposta. Por isso:
- Responda com o rascunho INTEIRO no texto (não só um resumo): é o que ele vai mostrar.
- A confirmação chega por ele, dita assim: "A pessoa confirmou: grave o último rascunho." Só com ela você grava.

## Escopo
A conversa diz o projeto atual (numa delegação, o pedido traz o projectId). Nasce nele (global: false; ao gravar, o projectId da conversa); global só se a pessoa pedir.

${PROTOCOLS[kind].body}`
}

/**
 * O agente construtor de um tipo, no provider e modelo dados.
 * ⚠️ Só a lane `agent`: a `chat` não tem ferramentas, e sem elas não há rascunho.
 */
export function builderAgent(kind: TProtocolKind, target: IAgentTarget): IAgent {
  const { name, read, save, saveAlso = [], extra = [] } = KINDS[kind]
  return {
    id: builderAgentId(kind),
    name,
    providers: [{ provider: target.provider, models: [...target.models] }],
    soul: SOUL,
    systemPrompt: prompt(kind),
    reasoningEfforts: ['low', 'medium', 'high'],
    modes: [EMode.AGENT],
    allowedTools: [...[...read, save, ...saveAlso].map((tool) => `mcp:gateway/${tool}`), ...extra, PROPOSE_DRAFT_TOOL, 'cap:todos'],
    // Sem regra tudo é negado: o construtor usa as ferramentas do gateway do tipo dele (o `allowedTools` já as restringe).
    permissions: [{ category: 'mcp', pattern: 'gateway/*', decision: 'allow', note: 'as ferramentas do gateway' }],
    adminOnly: true,
  }
}
