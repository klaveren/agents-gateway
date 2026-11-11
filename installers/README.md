# Instaladores

Uma pasta por distribuição do gateway. Cada uma tem o seu README (como gerar, instalar e atualizar), e o que ela gera
fica na própria pasta, em `dist/` (fora do git).

| Pasta | Distribuição |
|---|---|
| [`macos/`](macos/README.md) | App para o Mac (uso pessoal): janela própria, servidor em segundo plano no login, pasta de trabalho escolhida no primeiro uso. |
| [`debian/`](debian/README.md) | Pacote `.deb` para Debian/Ubuntu (amd64, arm64): serviço do systemd, Node embutido, pasta de dados, endereço e porta perguntados na instalação. |
