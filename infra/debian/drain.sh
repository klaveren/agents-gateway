#!/bin/bash
# O MODO DRENO do deploy, em funções (o `setup.sh` faz `source` daqui; os testes também).
#
# Ligar o dreno faz o gateway recusar turno NOVO (503 `draining`, `Retry-After: 30`) enquanto os em andamento acabam.
# Com a esteira rodando sem parar, "zero turnos" só acontece assim. ⛔ O reinício NUNCA corta um turno: se o teto de
# espera (`DEPLOY_WAIT_MINUTES`, opcional) acabar, o dreno é desligado e NADA é reiniciado.
#
# Precisa de `$GATEWAY_HOST` e `$GATEWAY_PORT`. `log` e `warn` vêm de quem faz o `source`.

# Liga (`on`) ou desliga (`off`) o dreno. Falha (código 1) se o gateway não aceitou — por exemplo, uma versão sem a rota.
drain_set() {
  local on=true
  [[ "$1" == off ]] && on=false
  curl -fsS --max-time 5 -X POST -H 'Content-Type: application/json' -d "{\"on\":$on}" \
    "http://$GATEWAY_HOST:$GATEWAY_PORT/v1/health/drain" >/dev/null 2>&1
}

# Quantos turnos rodam agora; vazio se o gateway não respondeu.
drain_running() {
  curl -fsS --max-time 15 "http://$GATEWAY_HOST:$GATEWAY_PORT/v1/health?turns=1" 2>/dev/null | sed -n 's/.*"running":\([0-9]*\).*/\1/p'
}

# Liga o dreno e espera `running: 0`. $1 = teto em minutos (vazio = sem teto; 0 = não espera nada).
# Volta 0 quando pode reiniciar; volta 1 (dreno desligado, `DRAIN_LEFT` = turnos que sobraram) se o teto acabou.
drain_and_wait() {
  local ceiling="${1:-}" started running
  DRAIN_LEFT=0
  # ⚖️ O dreno é OPCIONAL (`DEPLOY_DRAIN=1`): recusa turno novo com 503, e quem chama (a esteira) precisa reenviar.
  # Sem ele, a espera é a mesma, só sem recusar — com a esteira contínua, pode não chegar a zero (use o teto).
  if [[ "${DEPLOY_DRAIN:-}" != 1 ]]; then
    :
  elif drain_set on; then
    trap 'drain_set off || true; exit 130' INT TERM
  else
    warn "O gateway no ar não aceitou o dreno (versão antiga?): espero os turnos acabarem mesmo assim, sem recusar os novos."
  fi
  started=$(date +%s)
  while :; do
    running=$(drain_running)
    # ⛔ Só ZERO libera o reinício. Sem resposta (o gateway ocupado não respondeu em 5 s) NÃO é zero: antes era, e o
    # deploy de 07/11 02:04 cortou três turnos assim. Sem resposta, espera e pergunta de novo (o teto, se houver, vale).
    [[ "$running" == "0" ]] && break
    if [[ -n "$ceiling" ]] && (($(date +%s) - started >= ceiling * 60)); then
      drain_set off || true
      trap - INT TERM
      DRAIN_LEFT=$running
      return 1
    fi
    if [[ -z "$running" ]]; then
      log "O gateway não respondeu quantos turnos rodam: espero e pergunto de novo…"
    else
      log "Esperando $running turno(s) terminar antes de reiniciar…"
    fi
    sleep "${DRAIN_POLL_SECONDS:-15}"
  done
  trap - INT TERM
  return 0
}
