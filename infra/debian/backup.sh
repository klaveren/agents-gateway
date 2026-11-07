#!/bin/bash
# Backup do dado do gateway. Roda como o USUÁRIO DO SERVIÇO (não root), pelo timer do systemd ou na mão:
#
#   infra/debian/backup.sh
#
# Variáveis:
#   GATEWAY_DATA=/var/lib/agents-gateway   a pasta dos dados (gateway.db, secrets.key, projects/)
#   CONVERSATIONS_DB=                      se definido, a pasta dos dados é a do banco (igual ao serviço)
#   SECRETS_KEY_FILE=                      onde está a chave do cofre (padrão: <dados>/secrets.key)
#   BACKUP_DIR=<dados>/backups             destino (fica NO servidor; levar para fora é decisão do dono)
#   BACKUP_KEEP_DAILY=7  BACKUP_KEEP_WEEKLY=4
#   NODE_BIN=node                          node ≥ 22.13 (node:sqlite — não depende do binário sqlite3)
#
# Gera, com o mesmo carimbo <AAAAMMDD-HHMMSS>:
#   gateway-<carimbo>.db           cópia CONSISTENTE do banco (VACUUM INTO, vale com o serviço no ar, WAL)
#   projects-<carimbo>.tar.gz      projects/ SEM os repositórios (clones git, voltam do remoto), .cache e .tmp
#   keys/gateway-<carimbo>.key     a chave do cofre, SEPARADA (0600): sem ela o banco não decifra
# ⛔ O conteúdo da chave nunca é impresso nem vai para log.
set -euo pipefail
umask 077

DB="${CONVERSATIONS_DB:-}"
if [[ -n "$DB" && "$DB" != ":memory:" && "$DB" != "off" ]]; then
  DATA="$(dirname "$DB")"
else
  DATA="${GATEWAY_DATA:-/var/lib/agents-gateway}"
  DB="$DATA/gateway.db"
fi
KEY_FILE="${SECRETS_KEY_FILE:-$DATA/secrets.key}"
DEST="${BACKUP_DIR:-$DATA/backups}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
NODE="${NODE_BIN:-node}"

log() { printf '[backup] %s\n' "$*"; }
die() {
  printf '[backup] ERRO: %s\n' "$*" >&2
  exit 1
}

[[ -f "$DB" ]] || die "banco não encontrado: $DB"
command -v "$NODE" >/dev/null 2>&1 || die "node não encontrado ($NODE)"

mkdir -p "$DEST/keys"
chmod 700 "$DEST" "$DEST/keys"

# Espaço: precisa de 2× o tamanho do banco (+ WAL) livre no destino.
db_bytes=$(cat "$DB" "$DB-wal" 2>/dev/null | wc -c | tr -d ' ' || true)
free_kb=$(df -Pk "$DEST" | awk 'NR==2{print $4}')
need_kb=$(((db_bytes * 2 + 1023) / 1024))
((free_kb >= need_kb)) || die "sem espaço em $DEST: livre ${free_kb} KB, preciso de ${need_kb} KB (2× o banco)"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DB="$DEST/gateway-$STAMP.db"
OUT_TAR="$DEST/projects-$STAMP.tar.gz"
OUT_KEY="$DEST/keys/gateway-$STAMP.key"
# Falhou no meio: não deixa um conjunto pela metade (a retenção o contaria como backup bom).
trap 'rc=$?; [[ $rc -eq 0 ]] || rm -f "$OUT_DB" "$OUT_TAR" "$OUT_KEY"' EXIT

# 1. Banco: VACUUM INTO é uma leitura consistente, mesmo com o serviço escrevendo.
"$NODE" -e '
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(process.argv[1], { readOnly: true })
  db.exec("PRAGMA busy_timeout = 30000")
  db.prepare("VACUUM INTO ?").run(process.argv[2])
  db.close()
' "$DB" "$OUT_DB"
chmod 600 "$OUT_DB"
log "banco -> $OUT_DB"

# 2. Chave do cofre, separada. Arquivo secrets.key; ou SECRETS_KEY do ambiente (a unit lê o gateway.env, que é root).
if [[ -f "$KEY_FILE" ]]; then
  cp "$KEY_FILE" "$OUT_KEY"
elif [[ -n "${SECRETS_KEY:-}" ]]; then
  printf 'SECRETS_KEY=%s\n' "$SECRETS_KEY" >"$OUT_KEY"
else
  die "sem chave do cofre: nem $KEY_FILE nem SECRETS_KEY no ambiente (sem ela o backup não decifra)"
fi
chmod 600 "$OUT_KEY"
log "chave -> $OUT_KEY (conteúdo não exibido)"

# 3. Projetos, sem repositórios (clones git), .cache e .tmp.
if [[ -d "$DATA/projects" ]]; then
  tar -C "$DATA" -czf "$OUT_TAR" \
    --exclude='projects/*/repositories' --exclude='.cache' --exclude='.tmp' projects
  chmod 600 "$OUT_TAR"
  log "projetos -> $OUT_TAR"
fi

# 4. Retenção: o mais novo de cada um dos últimos KEEP_DAILY dias + o mais novo de cada uma das últimas KEEP_WEEKLY
#    semanas ISO. O resto (banco, projetos e chave do mesmo carimbo) sai.
"$NODE" -e '
  const fs = require("node:fs"), path = require("node:path")
  const [dir, daily, weekly] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3])]
  const stamps = [...new Set(fs.readdirSync(dir).map((f) => /^gateway-(\d{8}-\d{6})\.db$/.exec(f)?.[1]).filter(Boolean))].sort().reverse()
  const isoWeek = (s) => {
    const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)))
    d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)) // a quinta-feira da semana decide o ano
    const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1)
    return d.getUTCFullYear() + "-" + Math.floor((d.getTime() - jan1) / 864e5 / 7)
  }
  const keep = new Set(), days = new Set(), weeks = new Set()
  for (const s of stamps) {
    const day = s.slice(0, 8), wk = isoWeek(s)
    if (!days.has(day) && days.size < daily) { days.add(day); keep.add(s) }
    if (!weeks.has(wk) && weeks.size < weekly) { weeks.add(wk); keep.add(s) }
  }
  for (const s of stamps) {
    if (keep.has(s)) continue
    for (const f of [`gateway-${s}.db`, `projects-${s}.tar.gz`, `keys/gateway-${s}.key`]) fs.rmSync(path.join(dir, f), { force: true })
    console.log("[backup] removido (retenção): " + s)
  }
' "$DEST" "$KEEP_DAILY" "$KEEP_WEEKLY"

log "ok ($STAMP)"
