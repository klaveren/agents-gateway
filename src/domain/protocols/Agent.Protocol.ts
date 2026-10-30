import { ICoreProtocol } from '@domain/models/Protocol.Model'

/** O protocolo do core para construir um AGENTE. ⚠️ Mudou o texto, sobe a versão. */
export const AGENT_PROTOCOL: ICoreProtocol = {
  kind: 'agent',
  version: '1.1.0',
  title: 'Protocolo de construção de agente',
  body: `# Protocolo de construção de agente

Um agente do gateway é um registro: id, nome, soul, prompt, providers e modelos, lanes, níveis de raciocínio, ferramentas, projeto e papel. Em toda conversa nova o prompt dele leva a soul, o prompt, as rules, as specs do contexto inicial e os índices (documentos, skills, commands) — e isso pesa em TODA conversa. O resto ele carrega sob demanda.

## Princípios
1. **O prompt é leve.** Só o que o agente precisa em todo turno. Padrão, contrato e regra moram em specs (no índice; read_doc/search_docs quando o assunto aparece); modo de fazer mora em skill (use_resource); o procedimento do próprio agente, ativado sob demanda, mora num TRIGGER dele (guia Triggers do agente: o prompt lista id e "quando", e ele carrega com use_resource). Spec inteira no contexto inicial só quando ela é lei para TUDO o que o agente faz.
2. **Quem ele é × o que ele faz.** A soul diz QUEM: identidade, tom, valores, o que ele não é. O prompt diz O QUE: a função, os modos de operação, os passos e as conferências, e quando escalar ou devolver para a pessoa. Uma não repete a outra.
3. **Lei positiva, no presente.** O agente lê o prompt a cada conversa: nada de história ("esta regra substituiu…", "antes ele errava…"). Histórico custa tokens para sempre e reforça o que se queria evitar.
4. **Caminho aberto, não veto.** Agente crítico (revisor, auditor) se mede pelo que destrava: ordena e prioriza, não só recusa. Proibir veredito tira dele a capacidade de priorizar.
5. **O mínimo necessário.** Cada ferramenta, MCP e delegação é alcance dado a quem conversa com ele. Só o que o trabalho pede. Ferramenta que alcança o servidor (Bash, arquivos, rede) pede "Só administradores".
6. **O id diz o papel.** Minúsculas e hífens ("revisor-de-pr"), nunca o nome de uma pessoa. O nome é o que a tela mostra.

## O checklist de nascimento
- **Projeto:** o da conversa (o agente só trabalha na pasta dele e só os membros o veem). Global só se ele servir a todos os projetos.
- **Providers e modelos:** só os ATIVADOS (list_providers, list_models). O primeiro provider e o primeiro modelo são o padrão; ofereça um segundo provider quando fizer sentido trocar no meio da conversa.
- **Lanes:** agent quando ele trabalha em vários passos ou usa o que o provedor tem de nativo; chat para conversa pura. Assinatura só roda agent.
- **Raciocínio:** os níveis que o trabalho pede (low, medium, high).
- **Ferramentas:** as CAPACIDADES (cap:terminal, cap:files.read, cap:files.write, cap:web.search, cap:web.fetch, cap:todos — o gateway decide o que roda em cada provedor), os extras de um provedor (sdk:…) e as de MCP (mcp:<servidor>/<ferramenta>) — confira com list_tools. cap:todos para quem faz trabalho de muitos passos.
- **Delegação:** agent:<id> só para quem é do mesmo projeto ou global; subagente (role subagent) é quem só é chamado por outro agente.
- **Recursos:** por padrão ele usa todas as skills e commands do escopo dele; restrinja (ids, ou nenhum) quando o papel pedir.
- **Contexto inicial:** as specs que ele carrega inteiras além das do projeto. Diga quantos tokens isso soma: pesa em toda conversa.
- **Só administradores:** quando a ferramenta alcança o servidor ou o agente lida com dado sensível.

## O prompt
\`\`\`markdown
Você é <papel> de <projeto/time>. <Uma frase do propósito>.

## Como você trabalha
1. <passo imperativo>
2. …

## Conferências antes de responder
- [ ] …

## Quando parar e perguntar
- <o que exige a pessoa>
\`\`\`

## A soul
Três a seis frases: quem é, o tom (formal, direto, didático…), o que valoriza, o que não faz. Sem regra operacional — essa é do prompt.`,
}
