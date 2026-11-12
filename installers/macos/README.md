# Agents Gateway no Mac (uso pessoal)

O gateway instalado como app: ícone em **/Applications**, a tela numa **janela própria** (não no navegador), servidor em
**segundo plano** (sobe no login, volta se cair) e uma **pasta de trabalho** escolhida no primeiro uso — os projetos, o
banco e o cofre ficam nela. Fechar a janela não para o servidor.

Sem assinatura da Apple: é para esta máquina (o build assina ad-hoc).

## Gerar

```bash
installers/macos/build-app.sh
```

Gera `installers/macos/dist/Agents-Gateway-<versão>.dmg` do que está **commitado** (`git archive HEAD`), com o Node 24 desta
máquina dentro do app, junto com o kit do servidor — o mesmo da imagem: npm, npx, corepack, o micromamba e o Antigravity (`agy`), baixados uma vez e
conferidos pelo checksum; Claude e Codex vêm nas dependências. Precisa de `pnpm`, do Node 24 no `PATH` e das Command Line Tools (`swiftc`).

## Instalar e usar

1. Abra o `.dmg` e arraste **Agents Gateway** para **Applications**.
2. Abra o app. No primeiro uso ele pergunta a **pasta de trabalho** (uma pasta que já tem um `gateway.db` continua com os
   dados dela).
3. A janela abre a tela do gateway. No primeiro uso, a de criar o primeiro admin, com o código de instalação já preenchido.

| O quê | Onde |
|---|---|
| Configuração (pasta, porta, código de instalação) | `~/Library/Application Support/Agents Gateway/config.env` |
| Serviço (LaunchAgent) | `~/Library/LaunchAgents/com.agents-gateway.server.plist` |
| Log | `~/Library/Logs/Agents Gateway/server.log` |
| Dados | a pasta escolhida: `gateway.db`, `secrets.key`, `projects/` |

- **Trocar a pasta:** menu Agents Gateway → Trocar a pasta de trabalho…, ou abra o app segurando **⌥ Option**. O servidor
  reinicia na nova.
- **No navegador também:** `http://localhost:3210` (o servidor é o mesmo).
- **Arquivos que o agente entrega:** vão para Downloads. Links de fora abrem no navegador.
- **Outros servidores:** a mesma janela abre a tela de outro gateway, com o login dele. Cadastro: menu da conta →
  Servidores (só na tela de Este Mac). Troca: o menu do projeto, ou o menu Servidor (⌘1 é Este Mac, ⌘2 em diante os
  outros). O app guarda só o nome e o endereço. `http` só na rede local (IP privado, nome sem ponto, `.local`); fora dela,
  `https`. Na primeira vez o macOS pergunta se o app pode achar dispositivos na rede local: Permitir.
- **Trocar a porta:** mude `PORT` no `config.env` e abra o app de novo.
- **Atualizar:** gere o `.dmg` de novo e, **pelo Finder**, arraste o app para Applications substituindo o antigo; ao abrir, o
  servidor reinicia na versão nova. ⚠️ Copiar por script (`ditto`, `cp`) para dentro de Applications é bloqueado pelo
  macOS (Gerenciamento de Apps) e deixa o app pela metade: se o Finder recusar substituir, mova o antigo para o Lixo antes.
- **Estado do serviço:** `launchctl print gui/$(id -u)/com.agents-gateway.server`.
- **Desinstalar:** `installers/macos/uninstall.sh` (tira o serviço; a pasta de trabalho fica). Depois, arraste o app para o Lixo.

## Ícone

O desenho é `AppIcon.svg`; o `AppIcon.png` (1024) sai dele: `rsvg-convert -w 1024 -h 1024 AppIcon.svg -o AppIcon.png`.
