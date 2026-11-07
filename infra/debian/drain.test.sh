#!/bin/bash
# Testa o laço do dreno (`drain.sh`) sem gateway: `drain_set`/`drain_running` são trocadas por falsos.
#   bash infra/debian/drain.test.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=drain.sh
source ./drain.sh
# Os casos daqui são do dreno ligado (o padrão do deploy é sem dreno; ver `DEPLOY_DRAIN`).
export DEPLOY_DRAIN=1
log() { :; }
warn() { :; }
sleep() { CLOCK=$((CLOCK + 15)); }
date() { echo "$CLOCK"; }
fail=0
check() { # nome esperado obtido
  if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: esperado '$2', veio '$3'"; fail=1; fi
}

SETS=()
SET_RC=0
STATE="$(mktemp)"
trap 'rm -f "$STATE"' EXIT
drain_set() { SETS+=("$1"); return "$SET_RC"; }
# `drain_running` roda em subshell (dentro de $(...)): o índice da sequência vive num arquivo.
seq_running() { # valores...
  SEQ=("$@")
  echo 0 >"$STATE"
  drain_running() {
    local i
    i=$(<"$STATE")
    echo "${SEQ[$i]:-0}"
    echo $((i + 1)) >"$STATE"
  }
}

# 1. Zera depois de alguns ciclos: liga o dreno, espera, volta 0 e NÃO desliga (o restart limpa).
CLOCK=0 SETS=()
seq_running 3 2 1 0
drain_and_wait ""
check "sem teto: espera zerar" 0 "$?"
check "sem teto: ligou o dreno e só isso" "on" "${SETS[*]}"
check "sem teto: esperou 3 ciclos" 45 "$CLOCK"

# 2. Teto acabou com turnos rodando: volta 1, desliga o dreno, diz quantos sobraram.
CLOCK=0 SETS=()
drain_running() { echo 4; }
drain_and_wait 1
check "teto: não reinicia" 1 "$?"
check "teto: ligou e desligou o dreno" "on off" "${SETS[*]}"
check "teto: quantos turnos sobraram" 4 "$DRAIN_LEFT"

# 3. Teto 0 com turno rodando: não espera nada e não reinicia.
CLOCK=0 SETS=()
drain_and_wait 0
check "teto 0 com turno rodando: não reinicia" 1 "$?"

# 4. Teto 0 sem turno: reinicia já.
drain_running() { echo 0; }
drain_and_wait 0
check "teto 0 sem turno: reinicia" 0 "$?"

# 5. Gateway antigo sem a rota: segue esperando sem dreno.
CLOCK=0 SETS=() SET_RC=1
seq_running 1 0
drain_and_wait ""
check "sem rota de dreno: ainda espera zerar" 0 "$?"
SET_RC=0

# 6. ⛔ O gateway não respondeu (vazio): NÃO é zero — espera e pergunta de novo; com teto, não reinicia.
CLOCK=0 SETS=()
echo 0 >"$STATE"
drain_running() {
  local i
  i=$(<"$STATE")
  echo $((i + 1)) >"$STATE"
  ((i < 2)) && echo "" || echo 0
}
drain_and_wait ""
check "sem resposta: espera até responder zero" 0 "$?"
check "sem resposta: perguntou de novo" 3 "$(<"$STATE")"
CLOCK=0 SETS=()
drain_running() { echo ""; }
drain_and_wait 1
check "sem resposta com teto: não reinicia" 1 "$?"

exit $fail
