# Agents Gateway no Mac (uso pessoal)

O gateway instalado como app: ícone em **/Applications**, servidor em **segundo plano** (sobe no login, volta se cair) e
uma **pasta de trabalho** escolhida no primeiro uso — os projetos, o banco e o cofre ficam nela.

Sem assinatura da Apple: é para esta máquina (o build assina ad-hoc).

## Gerar

```bash
infra/macos/build-app.sh
```

Gera `dist-mac/Agents-Gateway-<versão>.dmg` do que está **commitado** (`git archive HEAD`), com o Node 24 desta
máquina dentro do app. Precisa de `pnpm` e do Node 24 no `PATH`.

## Instalar e usar

1. Abra o `.dmg` e arraste **Agents Gateway** para **Applications**.
2. Abra o app. No primeiro uso ele pergunta a **pasta de trabalho** (uma pasta que já tem um `gateway.db` continua com os
   dados dela).
3. O navegador abre em `http://localhost:3210`. No primeiro uso, a tela de criar o primeiro admin.

| O quê | Onde |
|---|---|
| Configuração (pasta, porta) | `~/Library/Application Support/Agents Gateway/config.env` |
| Serviço (LaunchAgent) | `~/Library/LaunchAgents/com.agents-gateway.server.plist` |
| Log | `~/Library/Logs/Agents Gateway/server.log` |
| Dados | a pasta escolhida: `gateway.db`, `secrets.key`, `projects/` |

- **Trocar a pasta:** abra o app segurando **⌥ Option**. O servidor reinicia na nova.
- **Trocar a porta:** mude `PORT` no `config.env` e abra o app de novo.
- **Atualizar:** gere o `.dmg` de novo e substitua o app em Applications; ao abrir, o servidor reinicia na versão nova.
- **Estado do serviço:** `launchctl print gui/$(id -u)/com.agents-gateway.server`.
- **Desinstalar:** `infra/macos/uninstall.sh` (tira o serviço; a pasta de trabalho fica). Depois, arraste o app para o Lixo.

## Ícone

O desenho é `AppIcon.svg`; o `AppIcon.png` (1024) sai dele: `rsvg-convert -w 1024 -h 1024 AppIcon.svg -o AppIcon.png`.
