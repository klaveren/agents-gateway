# Backup e restauração (Debian, `infra/debian/`)

O `setup.sh` instala o `agents-gateway-backup.timer`: todo dia às 03:30 (e na próxima subida, se a máquina estava
desligada), o `infra/debian/backup.sh` roda como o usuário do serviço e grava em `/var/lib/agents-gateway/backups/`
(0700), sempre no servidor:

| Arquivo                         | O quê                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `gateway-<carimbo>.db`          | banco consistente (`VACUUM INTO`, sem parar o serviço)                          |
| `keys/gateway-<carimbo>.key`    | a chave do cofre, separada (0600). Sem ela o banco não decifra                  |
| `projects-<carimbo>.tar.gz`     | `projects/` sem `repositories/` (clones git), `.cache` e `.tmp`                 |

Retenção: o mais novo de cada um dos últimos 7 dias e de cada uma das últimas 4 semanas; o resto é apagado.
Falta de espaço (menos de 2× o banco livre) faz o script sair com erro (`systemctl status agents-gateway-backup`).

⛔ Levar os backups para fora do servidor é decisão do dono. Guarde a pasta `keys/` em lugar diferente do banco:
quem tem os dois lê todos os segredos.

Rodar na mão: `sudo systemctl start agents-gateway-backup` (log: `journalctl -u agents-gateway-backup`).

## Restaurar

Ajuste `D=/var/lib/agents-gateway`, `U=infoccus` (o usuário do serviço) e `S=<carimbo>` (ex. `20261106-033000`).

```bash
D=/var/lib/agents-gateway; U=infoccus; S=20261106-033000; B=$D/backups

# 1. Parar o serviço (e guardar o estado atual, por garantia)
sudo systemctl stop agents-gateway
sudo mkdir -p $D/antes-restauro && sudo mv $D/gateway.db* $D/projects $D/antes-restauro/ 2>/dev/null

# 2. Banco (os -wal/-shm antigos já saíram no passo anterior)
sudo cp $B/gateway-$S.db $D/gateway.db

# 3. Chave do cofre — uma das duas, conforme o arquivo salvo
sudo grep -q '^SECRETS_KEY=' $B/keys/gateway-$S.key && echo "vem do env" || echo "é o secrets.key"   # nunca imprima a chave
#   a) "é o secrets.key":
sudo cp $B/keys/gateway-$S.key $D/secrets.key
#   b) "vem do env" -> a chave vive no /etc/agents-gateway/gateway.env: confira que a linha SECRETS_KEY de lá
#      é a mesma (sudoedit /etc/agents-gateway/gateway.env); não copie para $D/secrets.key.

# 4. Projetos (sem repositórios: eles voltam do remoto no primeiro uso do projeto)
sudo tar -xzf $B/projects-$S.tar.gz -C $D

# 5. Dono e permissões
sudo chown -R $U:$U $D/gateway.db $D/secrets.key $D/projects 2>/dev/null
sudo chmod 600 $D/gateway.db $D/secrets.key 2>/dev/null

# 6. Subir e conferir
sudo systemctl start agents-gateway
curl -fsS http://127.0.0.1:3000/v1/health
journalctl -u agents-gateway -n 40 --no-pager -o cat
```

Conferência: a tela abre, o login funciona, um projeto lista suas contas/segredos sem erro de decifragem (erro de
"decrypt"/"auth tag" = chave errada para esse banco) e um agente roda um turno. Deu certo: apague
`$D/antes-restauro`.
