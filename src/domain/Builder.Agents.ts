import { IAgent, IAgentTarget } from './models/Agent.Model'
import { ICoreProtocol, PROTOCOL_KINDS, TProtocolKind } from './models/Protocol.Model'
import { EMode } from './enums/EMode.Enum'
import { ADR_PROTOCOL } from './protocols/Adr.Protocol'
import { COMMAND_PROTOCOL } from './protocols/Command.Protocol'
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
}

const KINDS: Readonly<Record<TProtocolKind, IBuilderKind>> = {
  skill: {
    article: 'uma skill',
    name: 'Construtor de skills',
    read: ['list_resources'],
    save: 'save_resource',
    after: 'Avise que nenhum agente a usa até ser liberada na guia Recursos dele.',
  },
  command: {
    article: 'um command',
    name: 'Construtor de commands',
    read: ['list_resources'],
    save: 'save_resource',
    after: 'Avise que só quem conversa com um agente que o libera (guia Recursos) pode dispará-lo.',
  },
  rule: {
    article: 'uma rule',
    name: 'Construtor de rules',
    read: ['list_rules'],
    save: 'save_rule',
    after: 'Avise que ela vale para as conversas que começarem agora.',
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
  const { article, read, save, after } = KINDS[kind]
  return `Você constrói ${article} por conversa, com quem administra: entrega um rascunho e, quando a pessoa confirmar, grava.

## Como trabalhar
1. Entenda o pedido: o que é, para quem, em que projeto. Pergunte o que faltar, uma coisa por vez.
2. Confira o que já existe ("O que já existe", abaixo; o conteúdo inteiro com ${read.join(' e ')}). Se já houver um parecido, diga qual e proponha ajustá-lo em vez de criar outro.
3. Procure as specs e ADRs relacionadas (o índice "Documentos de referência"; leia com read_doc). Cite ou anexe em vez de copiar regra.
4. Monte o rascunho seguindo o protocolo abaixo e o complemento de quem administra (o complemento vem depois e acrescenta; em conflito, vale o complemento).
5. Entregue com ${PROPOSE_DRAFT_TOOL}. Se ela devolver problemas, corrija e entregue de novo. Depois, diga em uma ou duas frases o que propôs, que o rascunho está ao lado e pergunte se pode gravar.
6. A pessoa pediu mudança: ajuste e entregue de novo com ${PROPOSE_DRAFT_TOOL}.
7. ⛔ Só grave com ${save} DEPOIS que a pessoa disser nesta conversa que pode gravar — e grave exatamente o último rascunho entregue (mesmo id, texto e escopo). Sem confirmação explícita, não grave. ${after}

## Escopo
A conversa diz o projeto atual. Nasce nele (global: false; ao gravar, o projectId da conversa); global só se a pessoa pedir.

${PROTOCOLS[kind].body}`
}

/**
 * O agente construtor de um tipo, no provider e modelo dados.
 * ⚠️ Só a lane `agent`: a `chat` não tem ferramentas, e sem elas não há rascunho.
 */
export function builderAgent(kind: TProtocolKind, target: IAgentTarget): IAgent {
  const { name, read, save } = KINDS[kind]
  return {
    id: builderAgentId(kind),
    name,
    providers: [{ provider: target.provider, models: [...target.models] }],
    soul: SOUL,
    systemPrompt: prompt(kind),
    reasoningEfforts: ['low', 'medium', 'high'],
    modes: [EMode.AGENT],
    allowedTools: [...[...read, save].map((tool) => `mcp:gateway/${tool}`), PROPOSE_DRAFT_TOOL],
    adminOnly: true,
  }
}
