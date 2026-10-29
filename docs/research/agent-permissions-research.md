# Permissões de ferramentas para agentes de IA

> Estudo de 2026-10-28 (protocolo AKM Research). Fundamenta a futura seção **Permissões** do projeto e do agente no gateway: quais comandos do terminal, quais arquivos, quais MCPs, skills e delegações cada agente pode usar, com regras no projeto e exceções no agente.

---

### Princípios de controle de acesso aplicáveis a agentes

Um sistema de permissões para agentes que rodam comandos e mexem em arquivos é um mecanismo de controle de acesso clássico. Os princípios de Saltzer & Schroeder (1975) seguem válidos e são citados pela orientação atual de segurança de LLM.

#### Princípios
- **Padrão seguro (fail-safe defaults):** a decisão se baseia em permissão, não em exclusão. Sem regra, não há acesso.
- **Mediação completa:** todo acesso, a todo objeto, é conferido. Autorização em cache é atualizada quando a permissão muda.
- **Menor privilégio:** cada programa opera só com o privilégio que a tarefa exige.
- **Economia de mecanismo:** o mecanismo é pequeno e simples o bastante para ser inspecionado.
- **Aceitabilidade psicológica:** a interface é fácil o bastante para que as pessoas apliquem a proteção corretamente.
- **Excesso de agência (OWASP LLM06:2025):** as causas são funcionalidade, permissão ou autonomia demais. As mitigações são:
  - o mínimo de extensões e de funções;
  - preferir uma função dedicada (escrever arquivo) a um terminal genérico;
  - executar no contexto do usuário;
  - aprovação humana para ação de alto impacto;
  - autorização aplicada FORA do modelo, no sistema que executa.

#### Onde se aplica no gateway
- **Mediação completa:** é o motivo de a regra ser conferida na ferramenta que executa: o `run_bash`, as ferramentas de arquivo e o hook `PreToolUse` do Claude. Nunca no prompt.
- **Brecha que este princípio teria evitado:** o Read nativo do Claude era liberado pelo CLI sem passar pelo `canUseTool` no agente global. Foi corrigida ao ligar o hook em todo agente (#77).
- **Padrão seguro:** pede que o projeto escolha o padrão quando nada casa (negar ou perguntar), em vez de "liberar tudo".

**Fontes:**
- Saltzer, J. H.; Schroeder, M. D., 1975. *The Protection of Information in Computer Systems*. Proc. IEEE 63(9). https://www.cs.virginia.edu/~evans/cs551/saltzer/ (acesso 2026-10-28)
- OWASP, 2025. *LLM06:2025 Excessive Agency*. https://genai.owasp.org/llmrisk/llm062025-excessive-agency/ (acesso 2026-10-28)

---

### Precedência de regras e camadas

Quando várias regras casam, a linguagem de política precisa de um algoritmo de combinação. A escolha decide se uma camada de baixo (o agente) pode liberar o que a de cima (o projeto) negou.

#### Modelos canônicos
- **XACML 3.0:**
  - *deny-overrides*: qualquer Deny vence;
  - *permit-overrides*: qualquer Permit vence;
  - *first-applicable*: vale a primeira regra aplicável, na ordem;
  - *only-one-applicable*.
- **AWS IAM:** negar por padrão. Uma negação explícita em qualquer política vence qualquer permissão. Os limites de permissão (permissions boundary e SCP) só ESTREITAM, e a ação precisa ser permitida por todos.
- **Cedar:** qualquer `forbid` que casa nega; senão, qualquer `permit` permite; senão, nega.
- **OPA/Rego:** `default allow := false` dá negar por padrão. Cadeias `else` param no primeiro que casa.
- **Sobrescrita em camadas** (a de baixo libera o que a de cima negou):
  - impossível em deny-overrides, IAM e Cedar, onde a negação em qualquer camada é final;
  - possível em first-applicable, ou em "a última que casa vence" sobre regras ordenadas;
  - o custo: o resultado depende da ordem, e uma camada de baixo pode enfraquecer a de cima sem ninguém ver.
- **Os produtos de agente divergem:**

| Produto | Precedência | Padrão sem regra |
|---|---|---|
| OpenCode | a ÚLTIMA regra que casa vence; agente concatenado depois do global | `ask` no código (a documentação diz `allow` para a maioria; inconsistente) |
| Claude Code / Agent SDK | `deny` > `ask` > `allow`; especificidade não importa | modo de permissão |
| Codex (execpolicy) | a mais restritiva: `forbidden` > `prompt` > `allow` | `allow` |
| Gemini CLI (policy engine) | prioridade numérica por camada (padrão < extensão < usuário < admin); a maior vence | conforme o modo |
| Antigravity CLI | `deny` > `ask` > `allow` | comandos, MCP e URL: `ask` |

#### Onde se aplica no gateway
- **O pedido:** "bloquear tudo no projeto e ir liberando no agente" é sobrescrita em camadas, o modelo do OpenCode.
- **Os padrões canônicos:** pedem também um piso que nenhuma camada levanta, como os SCP da AWS e o `forbid` do Cedar.
- **Desenho que concilia os dois:**
  - Camada **sistema**, fixa e sem exceção: `.env`, chaves, a pasta de dados e os comandos destrutivos da trava atual. Avaliada como deny-overrides.
  - Camadas **projeto → agente**, em ordem, onde a última regra que casa vence. É compatível com o `permission` do OpenCode, o que permite importar o `opencode.json`.
  - **Padrão quando nada casa:** escolhido por projeto (permitir, perguntar ou negar).
  - **Explicação na tela:** qual regra e qual camada decidiram (aceitabilidade psicológica).

**Fontes:**
- OASIS, 2013. *XACML 3.0 Core*, §2.3 (combining algorithms). https://docs.oasis-open.org/xacml/3.0/xacml-3.0-core-spec-os-en.html (acesso 2026-10-28)
- AWS. *Policy evaluation logic*. https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html (acesso 2026-10-28)
- Cedar. *Authorization*. https://docs.cedarpolicy.com/auth/authorization.html (acesso 2026-10-28)
- OPA. *Policy language*. https://www.openpolicyagent.org/docs/policy-language (acesso 2026-10-28)
- OpenCode. *Permissions*. https://opencode.ai/docs/permissions ; código: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/permission.ts (acesso 2026-10-28)
- Anthropic. *Claude Code permissions*. https://code.claude.com/docs/en/permissions (acesso 2026-10-28)
- OpenAI. *Codex rules*. https://learn.chatgpt.com/docs/agent-configuration/rules (acesso 2026-10-28; "Rules are experimental and may change")
- Google. *Gemini CLI policy engine*. https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md (acesso 2026-10-28)

---

### Regras para comandos de terminal

Comparar o TEXTO do comando com um padrão não é fronteira de segurança: o shell interpreta a linha inteira. O mecanismo robusto analisa o comando e confere cada comando simples.

#### Mecanismo
- **OWASP:** o melhor é não chamar o shell, e sim API de biblioteca ou argv sem shell. Na sequência, lista de permissão do NOME do comando com validação dos argumentos. Escapar é defesa secundária. Os metacaracteres perigosos são `& | ; $ > < \` \ ! ' " ( )`.
- **Classes de desvio conhecidas** em listas por prefixo:
  - comandos compostos (`git status; rm -rf x` casa `git *`);
  - pipes e `$( )`;
  - expansão de chaves;
  - built-ins que mudam o ambiente (`export`, `alias`);
  - atribuição de variável antes do comando;
  - redirecionamento (`> ~/.bashrc`);
  - aspas (`g"it"`).
  - Vários CVEs de 2025–2026 em ferramentas de agente seguem esses padrões. Fontes secundárias, a conferir antes de citar como fato.
- **Como os produtos fazem:**
  - **OpenCode** analisa com `web-tree-sitter` (bash) e confere CADA comando extraído, além das pastas citadas (`external_directory`). Marca como "opaco" o que não analisa (substituição de comando, nome dinâmico, heredoc).
  - **Claude Code** separa em `&& || ; | |& &` e quebra de linha. Todo subcomando precisa ser permitido; deny/ask valem se qualquer um casar, inclusive em subshell. Ele mesmo avisa que regra de Bash não é fronteira de segurança e indica sandbox ou hook.
  - **Codex** separa com tree-sitter só cadeias simples (`&& || ; |`). Com redirecionamento, substituição, variável, curinga ou controle de fluxo, o script inteiro vira UM comando opaco.
  - **Gemini CLI** obriga a perguntar em redirecionamento (`> >> <`), salvo `allowRedirection`.

#### Onde se aplica no gateway
- **Análise:** o `run_bash` passa a analisar com `web-tree-sitter` (o mesmo do OpenCode) e conferir cada comando simples.
- **Construções opacas** (substituição, heredoc, nome dinâmico, `eval`): viram `ask`, ou `deny` sem pessoa na conversa (agendamento, hook).
- **Redirecionamento:** vira uma checagem de **escrita** no caminho alvo, pelas regras de arquivo, em vez do truque `"* > *": "deny"`.
- **Defesa em profundidade:** a trava de hoje (`Bash.Guard`) vira regras da camada sistema. O cerco do sistema operacional do agente de projeto continua sendo a fronteira real.

**Fontes:**
- OWASP. *OS Command Injection Defense Cheat Sheet*. https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html (acesso 2026-10-28)
- OpenCode, código: `packages/core/src/tool/plugin/shell.ts`, `shell/parse.ts`, `shell/scan.ts`. https://github.com/anomalyco/opencode (branch dev, acesso 2026-10-28)
- Anthropic. *Claude Code permissions* (seção de Bash). https://code.claude.com/docs/en/permissions (acesso 2026-10-28)
- OpenAI. *Codex rules*. https://learn.chatgpt.com/docs/agent-configuration/rules (acesso 2026-10-28)
- tree-sitter-bash: https://github.com/tree-sitter/tree-sitter-bash ; bashlex: https://github.com/idank/bashlex ; shell-quote: https://github.com/ljharb/shell-quote (acesso 2026-10-28)

---

### Regras para caminhos de arquivo

Regra de caminho só vale sobre o caminho canônico. Com `..`, absoluto ou link simbólico, se escapa da pasta permitida.

#### Mecanismo
- **CWE-22:** decodificar e canonicalizar UMA vez (`realpath`), antes de validar; preferir lista de permissão.
- **CWE-59:** link e atalho levam a recurso não pretendido.
- **CWE-367 (TOCTOU):** o recurso muda entre a checagem e o uso. As saídas são operação atômica, reconferência após o uso e o privilégio mínimo do sistema operacional.

#### Onde se aplica no gateway
- **Ferramentas de arquivo do gateway (#77):** já canonicalizam (`resolveInside`) e reconferem depois de criar pastas. As regras de `read`/`edit` casam sobre o caminho canônico, RELATIVO à pasta do projeto, e assim `apps/**` significa a mesma coisa em qualquer máquina.
- **Pastas fora do projeto:** hoje negadas. Viram a lista `external_directory` do projeto.

**Fontes:**
- MITRE. *CWE-22*, *CWE-59*, *CWE-367*. https://cwe.mitre.org/data/definitions/22.html ; /59.html ; /367.html (acesso 2026-10-28)

---

### Controle sobre os CLIs dos fornecedores (assinaturas)

O OpenCode bloqueia comandos mesmo usando assinatura porque é o PRÓPRIO motor: chama a API do modelo com o login e executa as ferramentas dele. O gateway roda os programas oficiais (`codex`, `agy`, Claude Code), e o controle depende do que cada um aceita do programa que o hospeda.

#### Capacidade de controle por CLI

| CLI | Bloquear comando por padrão | Desligar o terminal próprio | Ferramentas por MCP | Configuração por execução |
|---|---|---|---|---|
| Claude Code / Agent SDK | sim: regras `Bash(...)` e hook `PreToolUse` (o hook é a fronteira) | sim: `tools`/`disallowedTools` | sim | sim: opções do SDK |
| Codex CLI / SDK | sim, por PREFIXO (`prefix_rule … forbidden`); script complexo vira um comando opaco | sim: `features.shell_tool=false` (documentado; a testar) | sim: `mcp_servers`, `enabled_tools`/`disabled_tools` | sim: `config`/`configOverrides` do SDK; regras por execução só indiretamente (`CODEX_HOME`, inferência) |
| Antigravity CLI (`agy`) | sim: `deny command(...)` em `settings.json` | provável via `deny command(*)` (não confirmado) | sim: `agy mcp`, `.agents/mcp_config.json` na pasta | fraca: configuração global; há relatos de bug no modo sem interface |
| Gemini CLI | sim: policy engine TOML | sim: `run_shell_command` excluído/negado | sim | parcial |

#### Termos de uso das assinaturas fora do programa oficial
- **Anthropic (fonte primária, página de conformidade do Claude Code):**
  - o OAuth das assinaturas serve ao "uso comum do Claude Code e de outros aplicativos nativos da Anthropic";
  - quem constrói produto, inclusive com o Agent SDK, deve usar chave de API;
  - "não permite que desenvolvedores terceiros… encaminhem requisições pelas credenciais Free, Pro ou Max em nome dos seus usuários";
  - é permitido que cada usuário entre no binário SEM modificação do Claude Code com a PRÓPRIA assinatura;
  - a aplicação pode ser feita sem aviso.
- **OpenAI:** o OpenCode registra um cliente OAuth próprio com escopo de compartilhamento de token (`chatgpt.tokens.use.direct`), o que sugere um mecanismo oferecido pela OpenAI. Não há declaração pública dela endossando. Não confirmado.
- **Google:** não há texto oficial sobre uso do login do Antigravity ou do Gemini Code Assist fora do programa oficial. Há relatos de contas suspensas por isso, em fórum (não confirmados).

#### Onde se aplica no gateway
- **Caminho 1** (o programa oficial com o terminal dele desligado, recebendo o terminal e os arquivos do gateway por MCP):
  - É viável no **Codex**, com `shell_tool=false` e o MCP do gateway, ambos por execução via `config` do SDK.
  - É provável no **Antigravity**, com MCP na pasta da conversa e `deny command(*)`; precisa de prova prática por causa dos bugs relatados.
  - No **Claude**, as regras já passam pelo hook.
  - Mantém o binário oficial, que é o que os termos da Anthropic aceitam.
- **Caminho 2** (motor próprio com o login da assinatura, como o OpenCode):
  - é PROIBIDO pela Anthropic;
  - tem risco de suspensão no Google;
  - não está confirmado na OpenAI.
- **Risco já presente, independente do caminho:**
  - O gateway permite que a assinatura de quem configurou atenda conversas de OUTRAS pessoas.
  - A Anthropic diz que cada usuário final deve entrar com a própria assinatura, e que os limites de Pro e Max supõem uso individual.
  - O uso da assinatura do Claude por terceiros merece decisão explícita: restringir a quem é dono da assinatura, ou usar chave de API.

**Fontes:**
- Anthropic. *Legal and compliance — Authentication and credential use*. https://code.claude.com/docs/en/legal-and-compliance (acesso 2026-10-28)
- Anthropic. *Agent SDK permissions*. https://code.claude.com/docs/en/agent-sdk/permissions (acesso 2026-10-28)
- OpenAI. *Codex config reference*. https://learn.chatgpt.com/docs/config-file/config-reference ; *Codex TypeScript SDK*. https://github.com/openai/codex/tree/main/sdk/typescript (acesso 2026-10-28)
- Google. *Antigravity CLI permissions*. https://antigravity.google/docs/cli/permissions (somente trecho de busca); guia de terceiros: https://computingforgeeks.com/antigravity-cli-cheat-sheet/ (acesso 2026-10-28)
- OpenCode. *Providers*. https://opencode.ai/docs/providers ; `packages/core/src/plugin/provider/chatgpt.ts` (acesso 2026-10-28)

---

### Lacunas
- **Codex:** `features.shell_tool=false` está documentado, mas não foi testado com o SDK. Confirmar se as regras chegam por `CODEX_HOME` por execução.
- **Antigravity:** confirmar a precedência de `settings.json`, MCP na pasta da conversa e o comportamento sem interface (bugs #548 e #565 relatados).
- **OpenCode:** confirmar o que ele faz com comando "opaco" (pergunta ou nega) e se os comandos dentro de `$( )` têm regra própria.
- **Datas da Anthropic:** só fontes secundárias datam as mudanças nos termos (jan.–abr. 2026). A página primária não tem data.
