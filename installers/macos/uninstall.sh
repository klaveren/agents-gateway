#!/bin/zsh
# Tira o servidor em segundo plano do Agents Gateway. A pasta de trabalho (projetos, banco, cofre) e o app ficam:
# apagar o app é arrastá-lo para o Lixo; os dados, apagar a pasta escolhida.
set -u
LABEL=com.agents-gateway.server
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "serviço parado" || echo "o serviço não estava carregado"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "LaunchAgent removido. A configuração fica em ~/Library/Application Support/Agents Gateway (apague para começar do zero)."
