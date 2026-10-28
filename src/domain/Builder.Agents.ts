import { IAgent, IAgentTarget } from './models/Agent.Model'
import { ICoreProtocol, TProtocolKind } from './models/Protocol.Model'
import { EMode } from './enums/EMode.Enum'
import { COMMAND_PROTOCOL } from './protocols/Command.Protocol'
import { SKILL_PROTOCOL } from './protocols/Skill.Protocol'

/**
 * O CONSTRUTOR: a conversa guiada que segue o protocolo do core e entrega um rascunho para a pessoa revisar.
 *
 * ⚖️ NÃO É UM AGENTE DO CATÁLOGO. É capacidade do core: definido aqui, chega atualizado com a imagem, não aparece em
 * Agentes, não se edita, não se libera e não recebe delegação. O único botão de quem administra é o modelo
 * (`builderProvider`/`builderModel` nas configurações). ⛔ Ele não grava nada: `propose_draft` só valida e entrega.
 */
export const PROTOCOLS: Readonly<Record<TProtocolKind, ICoreProtocol>> = { skill: SKILL_PROTOCOL, command: COMMAND_PROTOCOL }

/** A ferramenta com que o construtor entrega o rascunho. Interna: só os agentes do core a recebem. */
export const PROPOSE_DRAFT_TOOL = 'propose_draft'

/** A chave do `metadata` que marca a conversa como uma construção (o valor é o tipo). Fora da caixa de entrada. */
export const BUILDER_METADATA_KEY = 'builder'

const BUILDER_IDS: Readonly<Record<TProtocolKind, string>> = { skill: 'builder-skill', command: 'builder-command' }
const NAMES: Readonly<Record<TProtocolKind, string>> = { skill: 'Construtor de skills', command: 'Construtor de commands' }

/** Os ids reservados do core: nenhum agente do catálogo pode nascer com eles. */
export const CORE_AGENT_IDS: readonly string[] = Object.values(BUILDER_IDS)

export function builderAgentId(kind: TProtocolKind): string {
  return BUILDER_IDS[kind]
}

/** O tipo que este agente constrói, ou nada (não é construtor). */
export function builderKindOf(agentId: string | undefined): TProtocolKind | undefined {
  return (Object.keys(BUILDER_IDS) as TProtocolKind[]).find((kind) => BUILDER_IDS[kind] === agentId)
}

const SOUL = `Você é o Construtor do gateway: ajuda quem administra a criar artefatos agênticos bem-feitos, seguindo o protocolo do core.
Direto e preciso, em português claro. Pergunta uma coisa por vez. Não inventa: o que existe no gateway você consulta.`

function prompt(protocol: ICoreProtocol): string {
  const noun = protocol.kind === 'skill' ? 'skill' : 'command'
  return `Você constrói UM ${noun} por conversa, com quem administra. Você NÃO grava nada: entrega um rascunho e a pessoa revisa e salva.

## Como trabalhar
1. Entenda o pedido: o que o ${noun} faz, para quem, em que projeto. Pergunte o que faltar, uma coisa por vez.
2. Confira o que já existe ("O que já existe", abaixo; o conteúdo inteiro com list_resources). Se já houver um parecido, diga qual e proponha ajustá-lo em vez de criar outro.
3. Procure as specs e ADRs de que ele depende (o índice "Documentos de referência"; leia com read_doc). Anexe-as em docIds em vez de copiar regra.
4. Monte o rascunho seguindo o protocolo abaixo e o complemento de quem administra (o complemento vem depois e acrescenta; em conflito, vale o complemento).
5. Entregue com ${PROPOSE_DRAFT_TOOL}. Se ela devolver problemas, corrija e entregue de novo. Depois, diga em uma ou duas frases o que propôs e que o rascunho está ao lado, para revisar e salvar.
6. A pessoa pediu mudança: ajuste e entregue de novo com ${PROPOSE_DRAFT_TOOL}.

## Escopo
A conversa diz o projeto atual. O ${noun} nasce nele (global: false); global só se a pessoa pedir.

${protocol.body}`
}

/**
 * O agente construtor de um tipo, no provider e modelo dados.
 * ⚠️ Só a lane `agent`: a `chat` não tem ferramentas, e sem elas não há rascunho.
 */
export function builderAgent(kind: TProtocolKind, target: IAgentTarget): IAgent {
  return {
    id: BUILDER_IDS[kind],
    name: NAMES[kind],
    providers: [{ provider: target.provider, models: [...target.models] }],
    soul: SOUL,
    systemPrompt: prompt(PROTOCOLS[kind]),
    reasoningEfforts: ['low', 'medium', 'high'],
    modes: [EMode.AGENT],
    allowedTools: ['mcp:gateway/list_resources', PROPOSE_DRAFT_TOOL],
    adminOnly: true,
  }
}
