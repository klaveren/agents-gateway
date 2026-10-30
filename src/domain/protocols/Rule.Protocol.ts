import { ICoreProtocol } from '@domain/models/Protocol.Model'

/** O protocolo do core para construir uma RULE. ⚠️ Mudou o texto, sobe a versão. */
export const RULE_PROTOCOL: ICoreProtocol = {
  kind: 'rule',
  version: '1.1.0',
  title: 'Protocolo de construção de rule',
  body: `# Protocolo de construção de rule

Uma rule é uma REGRA DO AMBIENTE: entra no prompt de TODA conversa nova (as globais em todos os projetos; as do projeto, só nele) e vale em toda resposta e em toda ferramenta. Por isso cada rule custa tokens em toda conversa, para sempre — só entra o que é inegociável.

## Princípios
1. **Uma regra por registro.** Duas regras numa rule viram uma que ninguém consegue ligar ou desligar pela metade.
2. **Título curto, corpo imperativo.** O título nomeia a regra ("Dados de cliente"); o corpo diz o que fazer ou não fazer, em uma a três frases ("Nunca altere ou apague dado de cliente sem backup e sem a confirmação da pessoa.").
3. **Lei positiva, no presente.** A regra diz o que vale — nunca a história de como se chegou nela ("depois do incidente de março…"). Histórico pesa em toda conversa e reforça o que se queria evitar.
4. **Só o inegociável.** Preferência, estilo e passo a passo não são rule: são spec (o padrão) ou skill (o modo de fazer). Se precisa de exemplo ou de mais de duas frases, é spec.
5. **Não duplica.** Se uma spec já diz isso, a rule não repete: ou a spec entra no contexto inicial do projeto, ou a rule só aponta o que é inviolável.
6. **Verificável.** Quem lê a resposta sabe dizer se a regra foi cumprida. "Seja cuidadoso" não é verificável; "Confirme com a pessoa antes de apagar" é.
7. **Nenhum segredo.** A rule vai para todo agente e fica gravada nas conversas.
8. **Norma, fronteira e a frase que fecha a brecha.** A regra diz o que obriga ou proíbe, a exceção exata, e fecha a desculpa óbvia ("vale também por script"). Curta demais vira slogan que se contorna: nenhuma das três partes sai. O incidente que a motivou vai numa ADR.
9. **Quem executa?** Antes de escrever: se TODO agente cumpre, é rule. Se só um grupo, é spec no contexto inicial desse grupo (o projeto ou os agentes). Se só um papel, é o prompt daquele agente. Se ninguém precisa saber porque uma permissão ou um script impede, é a trava (regra de permissão), não texto.
10. **Verdade única.** Regra mudou: reescreva como vale agora. Nada de "substitui a anterior" — a regra antiga não é citada, para ninguém aplicá-la por engano.

## Escopo
- Global: vale em todos os projetos. Do projeto: só nas conversas dele, depois das globais. Na dúvida, do projeto.
- Em conflito com um pedido, a rule vence — o agente diz qual regra impede.`,
}
