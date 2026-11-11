# Agents Gateway no Debian/Ubuntu

Um pacote `.deb` que instala o gateway como **serviço do systemd**, com o Node 24 dentro: não precisa clonar o
repositório nem compilar na máquina. Na instalação ele pergunta a **pasta de dados** (projetos, banco, cofre), o
**endereço** e a **porta**.

> O deploy da nossa VM (`infra/debian`) é outra coisa: ferramenta nossa, do código-fonte. Este é o instalador para
> distribuir.

## Gerar

```bash
installers/debian/build-deb.sh            # amd64 e arm64
installers/debian/build-deb.sh arm64      # só uma arquitetura
```

Gera `installers/debian/dist/agents-gateway_<versão>_<arch>.deb` do que está **commitado** (`git archive HEAD`),
compilado num contêiner Debian da arquitetura certa. Precisa do Docker; a arquitetura que não é a desta máquina roda
emulada (mais lenta).

## Instalar

```bash
sudo apt install ./agents-gateway_<versão>_amd64.deb
```

- As perguntas aparecem na instalação. Sem terminal (`DEBIAN_FRONTEND=noninteractive`), valem os padrões:
  `/var/lib/agents-gateway`, `127.0.0.1`, porta `3000`.
- O fim da instalação mostra o endereço e o **código de instalação** do primeiro admin.
- O `chromium` (o navegador do agente) entra como recomendado. Com `--no-install-recommends`, fica de fora.

| O quê | Onde |
|---|---|
| Programa (Node + app) | `/opt/agents-gateway` |
| Serviço | `agents-gateway.service` (usuário `agents-gateway`) |
| Respostas da instalação | `/etc/agents-gateway/settings.env` |
| Segredos e código de instalação | `/etc/agents-gateway/gateway.env` (0600, criado uma vez) |
| Dados | a pasta escolhida: `gateway.db`, `secrets.key`, `projects/` |

## Usar

```bash
agents-gateway status        # o serviço
agents-gateway logs          # o log ao vivo
sudo agents-gateway codigo   # o código de instalação
agents-gateway url           # o endereço da tela
agents-gateway configurar    # muda a pasta, o endereço e a porta (dpkg-reconfigure)
```

- **Atualizar:** `sudo apt install ./agents-gateway_<versão nova>_<arch>.deb`. Os segredos e os dados ficam; o serviço reinicia.
- **Remover:** `sudo apt remove agents-gateway` para o serviço e mantém a configuração; `sudo apt purge agents-gateway` apaga
  também a configuração e o usuário. **A pasta de dados fica sempre**: apagar é à mão.
- **Terminal dos agentes:** o cerco usa o bubblewrap. No Ubuntu com AppArmor restringindo user namespaces, a instalação avisa;
  libere o bwrap (perfil `bwrap-userns-restrict`) ou `kernel.apparmor_restrict_unprivileged_userns=0`.
- **Opcional:** o CLI do Antigravity e o micromamba (Python dos agentes) não vêm no pacote; o `infra/debian/setup.sh` mostra
  como instalá-los.
