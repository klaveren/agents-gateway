import { ICoreProtocol } from '@domain/models/Protocol.Model'

/** O protocolo do core para construir um AGENTE. ⚠️ Mudou o texto, sobe a versão. */
export const AGENT_PROTOCOL: ICoreProtocol = {
  kind: 'agent',
  version: '1.2.0',
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
7. **Limite é regra, não só texto.** O que o agente nunca faz e o território dele (o que lê, grava, roda; em quais repositórios, MCPs e agentes) viram as REGRAS DE PERMISSÃO dele — sem regra, negado; Negar vence. O prompt traz só uma seção curta "Limites", com o porquê de cada um, para ele nem tentar. Texto sozinho é racionalizável; a regra o gateway impõe.
8. **Prompt × trigger.** O que vale em TODA conversa fica no prompt. O procedimento de UMA situação ("quando pedirem X") vira um trigger do agente: o "quando" é a condição de disparo, e o procedimento só entra quando ela acontece. Prompt que cresce com casos especiais é trigger mal colocado.
9. **Um papel.** Líder decide e delega, não executa; especialista executa uma fatia e não orquestra. A fronteira fica explícita: "faço" e "não faço", de 1 a 3 itens cada.

## O checklist de nascimento
- **Projeto:** o da conversa (o agente só trabalha na pasta dele e só os membros o veem). Global só se ele servir a todos os projetos.
- **Providers e modelos:** só os ATIVADOS (list_providers, list_models). O primeiro provider e o primeiro modelo são o padrão; ofereça um segundo provider quando fizer sentido trocar no meio da conversa.
- **Lanes:** agent quando ele trabalha em vários passos ou usa o que o provedor tem de nativo; chat para conversa pura. Assinatura só roda agent.
- **Raciocínio:** os níveis que o trabalho pede (low, medium, high).
- **Ferramentas:** as CAPACIDADES (cap:terminal, cap:files.read, cap:files.write, cap:web.search, cap:web.fetch, cap:todos — o gateway decide o que roda em cada provedor), os extras de um provedor (sdk:…) e as de MCP (mcp:<servidor>/<ferramenta>) — confira com list_tools. cap:todos para quem faz trabalho de muitos passos.
- **Delegação:** agent:<id> só para quem é do mesmo projeto ou global; subagente (role subagent) é quem só é chamado por outro agente.
- **Recursos:** por padrão ele usa todas as skills e commands do escopo dele; restrinja (ids, ou nenhum) quando o papel pedir.
- **Contexto inicial:** as specs que ele carrega inteiras além das do projeto. Diga quantos tokens isso soma: pesa em toda conversa.
- **Permissões:** os limites e o território como regras (terminal, leitura, escrita, rede, MCP, skill, delegação, conta, repositório, trigger). Só o que o papel pede.
- **Triggers:** um por situação; o id diz o trabalho; o "quando" é uma linha com a condição de disparo.
- **Alcance:** um agente novo ninguém alcança por delegação até outro ganhar agent:<id> e a regra de delegação para ele. Diga quem deve chamá-lo.
- **Só administradores:** quando a ferramenta alcança o servidor ou o agente lida com dado sensível.

## O prompt
\`\`\`markdown
Você é <papel> de <projeto/time>. <Uma frase do propósito>.

## Fronteira
- Faço: <1 a 3 itens>
- Não faço: <1 a 3 itens — e quem faz>

## Limites
- <o que você nunca faz> — <por quê, em meia frase>

## Como você trabalha
1. <passo imperativo>
2. …

## Quando delegar
- <situação> → agent:<id>, com contexto, tarefa, saída esperada e fronteira (o que ele não deve tocar). Peça o resultado, não a receita.

## Conferências antes de responder
- [ ] …

## Quando parar e perguntar
- <o que exige a pessoa>
\`\`\`

## Os triggers
Um trigger é o procedimento de uma situação, carregado sob demanda. O corpo:
\`\`\`markdown
**Condição de disparo:** <quando — a mesma linha do "quando">

## Procedimento
1. <passo imperativo>

## Saída
- <o que entregar, e em que formato>

## Quando parar
- <o que exige a pessoa ou outro agente>
\`\`\`

## A soul
Três a seis frases: quem é, o tom (formal, direto, didático…), o que valoriza, o que não faz. Sem regra operacional — essa é do prompt.`,
}
