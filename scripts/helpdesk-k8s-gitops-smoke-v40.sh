#!/usr/bin/env bash
set -euo pipefail

# helpdesk-k8s-gitops-smoke-v40.sh
#
# v40 — Kubernetes/GitOps smoke po wdrożeniu helpdesku.
#
# Zakres:
# - sprawdzenie aplikacji Argo CD helpdesk,
# - sprawdzenie zasobów namespace helpdesk,
# - sprawdzenie rolloutów deploymentów,
# - sprawdzenie ConfigMapa helpdesk-app i braku znanych regresji,
# - sprawdzenie Service/Ingress/PVC,
# - sprawdzenie endpointów HTTP/HTTPS,
# - opcjonalne sprawdzenie logów pod kątem tracebacków.
#
# Skrypt jest read-only z wyjątkiem tego, że może NIE wykonywać żadnych zmian.
# Nie robi restartów i nie wykonuje kubectl apply/replace.

NAMESPACE="${HELPDESK_NAMESPACE:-helpdesk}"
ARGO_NAMESPACE="${ARGO_NAMESPACE:-argocd}"
ARGO_APP="${ARGO_APP:-helpdesk}"
HOST="${HELPDESK_HOST:-helpdesk.lab.local}"
SCHEME="${HELPDESK_SCHEME:-https}"
BASE_URL="${HELPDESK_URL:-${SCHEME}://${HOST}}"
TIMEOUT="${HELPDESK_SMOKE_TIMEOUT:-120s}"
CURL_INSECURE="${HELPDESK_CURL_INSECURE:-1}"
CHECK_LOGS="${HELPDESK_SMOKE_CHECK_LOGS:-1}"

FAILED=0
WARNINGS=0

section() {
  echo
  echo "================================================================================"
  echo "== $*"
  echo "================================================================================"
}

ok() {
  echo "OK: $*"
}

warn() {
  echo "WARN: $*" >&2
  WARNINGS=$((WARNINGS + 1))
}

fail() {
  echo "FAIL: $*" >&2
  FAILED=$((FAILED + 1))
}

run_required() {
  local description="$1"
  shift
  echo
  echo ">> ${description}"
  if "$@"; then
    ok "${description}"
  else
    fail "${description}"
  fi
}

run_optional() {
  local description="$1"
  shift
  echo
  echo ">> ${description}"
  if "$@"; then
    ok "${description}"
  else
    warn "${description}"
  fi
}

curl_flags=(-sS --max-time 20)
if [[ "${CURL_INSECURE}" == "1" ]]; then
  curl_flags+=(-k)
fi

section "v40 Kubernetes/GitOps smoke dla Helpdesk"
echo "Namespace:       ${NAMESPACE}"
echo "Argo namespace:  ${ARGO_NAMESPACE}"
echo "Argo app:        ${ARGO_APP}"
echo "Base URL:        ${BASE_URL}"
echo "Timeout:         ${TIMEOUT}"

section "1. Narzędzia lokalne"
run_required "kubectl jest dostępny" command -v kubectl
run_optional "curl jest dostępny" command -v curl

section "2. Dostęp do klastra"
run_required "kubectl cluster-info" kubectl cluster-info
run_required "namespace ${NAMESPACE} istnieje" kubectl get namespace "${NAMESPACE}"

section "3. Argo CD Application"
if kubectl get crd applications.argoproj.io >/dev/null 2>&1; then
  run_required "Application ${ARGO_APP} istnieje w namespace ${ARGO_NAMESPACE}" \
    kubectl get application -n "${ARGO_NAMESPACE}" "${ARGO_APP}"

  echo
  echo ">> Status Argo CD"
  kubectl get application -n "${ARGO_NAMESPACE}" "${ARGO_APP}" \
    -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revision \
    || fail "Nie udało się pobrać statusu Argo CD"

  SYNC_STATUS="$(kubectl get application -n "${ARGO_NAMESPACE}" "${ARGO_APP}" -o jsonpath='{.status.sync.status}' 2>/dev/null || true)"
  HEALTH_STATUS="$(kubectl get application -n "${ARGO_NAMESPACE}" "${ARGO_APP}" -o jsonpath='{.status.health.status}' 2>/dev/null || true)"

  if [[ "${SYNC_STATUS}" == "Synced" ]]; then
    ok "Argo CD sync status = Synced"
  else
    fail "Argo CD sync status != Synced, aktualnie: ${SYNC_STATUS:-unknown}"
  fi

  if [[ "${HEALTH_STATUS}" == "Healthy" ]]; then
    ok "Argo CD health status = Healthy"
  else
    fail "Argo CD health status != Healthy, aktualnie: ${HEALTH_STATUS:-unknown}"
  fi
else
  warn "CRD applications.argoproj.io nie istnieje — pomijam kontrolę Argo CD"
fi

section "4. Zasoby Kubernetes w namespace helpdesk"
run_required "Lista podów w ${NAMESPACE}" kubectl get pods -n "${NAMESPACE}" -o wide
run_optional "Lista deploymentów w ${NAMESPACE}" kubectl get deployments -n "${NAMESPACE}" -o wide
run_optional "Lista service w ${NAMESPACE}" kubectl get svc -n "${NAMESPACE}" -o wide
run_optional "Lista ingress w ${NAMESPACE}" kubectl get ingress -n "${NAMESPACE}" -o wide
run_optional "Lista PVC w ${NAMESPACE}" kubectl get pvc -n "${NAMESPACE}" -o wide

section "5. Rollout deploymentów"
if kubectl get deployment -n "${NAMESPACE}" helpdesk >/dev/null 2>&1; then
  run_required "rollout deployment/helpdesk" \
    kubectl rollout status deployment -n "${NAMESPACE}" helpdesk --timeout="${TIMEOUT}"
else
  fail "Brak deployment/helpdesk"
fi

if kubectl get deployment -n "${NAMESPACE}" helpdesk-postgres >/dev/null 2>&1; then
  run_required "rollout deployment/helpdesk-postgres" \
    kubectl rollout status deployment -n "${NAMESPACE}" helpdesk-postgres --timeout="${TIMEOUT}"
else
  warn "Brak deployment/helpdesk-postgres — pomijam, jeżeli PostgreSQL jest zewnętrzny lub nazywa się inaczej"
fi

section "6. Pod readiness i restarty"
echo
echo ">> Pod summary"
kubectl get pods -n "${NAMESPACE}" \
  -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,PHASE:.status.phase,NODE:.spec.nodeName \
  || fail "Nie udało się pobrać pod summary"

NOT_RUNNING="$(kubectl get pods -n "${NAMESPACE}" --no-headers 2>/dev/null | awk '$3 != "Running" && $3 != "Completed" {print $1" "$3}' || true)"
if [[ -n "${NOT_RUNNING}" ]]; then
  fail "Nie wszystkie pody są Running/Completed: ${NOT_RUNNING}"
else
  ok "Wszystkie pody są Running/Completed"
fi

HIGH_RESTARTS="$(kubectl get pods -n "${NAMESPACE}" --no-headers 2>/dev/null | awk '{split($4,a,","); for (i in a) if (a[i]+0 >= 3) print $1" restarts="$4}' || true)"
if [[ -n "${HIGH_RESTARTS}" ]]; then
  warn "Pody z restartami >=3: ${HIGH_RESTARTS}"
else
  ok "Brak podów z wysoką liczbą restartów"
fi

section "7. ConfigMap helpdesk-app"
run_required "ConfigMap helpdesk-app istnieje" kubectl get configmap -n "${NAMESPACE}" helpdesk-app

echo
echo ">> Kontrola znanej regresji: wyciek treści notatki internal"
if kubectl get configmap -n "${NAMESPACE}" helpdesk-app -o jsonpath='{.data.app\.py}' \
  | grep -q 'Dodano notatkę wewnętrzną: {content'; then
  fail "ConfigMap nadal zawiera wyciek treści notatki internal w event_message"
else
  ok "ConfigMap nie zawiera znanego wycieku notatki internal"
fi

echo
echo ">> Kontrola endpointu download załączników"
if kubectl get configmap -n "${NAMESPACE}" helpdesk-app -o jsonpath='{.data.app\.py}' \
  | grep -q '/api/attachments.*download\|attachments/<.*download\|attachments.*download'; then
  ok "W ConfigMap widać endpoint download załączników"
else
  warn "Nie udało się jednoznacznie potwierdzić endpointu download załączników grepem"
fi

section "8. Service / Ingress / PVC"
run_required "Service helpdesk istnieje" kubectl get svc -n "${NAMESPACE}" helpdesk
run_optional "Ingress helpdesk istnieje" kubectl get ingress -n "${NAMESPACE}" helpdesk

if kubectl get pvc -n "${NAMESPACE}" >/dev/null 2>&1; then
  PENDING_PVC="$(kubectl get pvc -n "${NAMESPACE}" --no-headers 2>/dev/null | awk '$2 != "Bound" {print $1" "$2}' || true)"
  if [[ -n "${PENDING_PVC}" ]]; then
    fail "Nie wszystkie PVC są Bound: ${PENDING_PVC}"
  else
    ok "Wszystkie PVC są Bound"
  fi
fi

section "9. HTTP/HTTPS smoke"
if command -v curl >/dev/null 2>&1; then
  echo
  echo ">> HEAD ${BASE_URL}"
  if curl "${curl_flags[@]}" -I "${BASE_URL}" | head -20; then
    ok "HEAD ${BASE_URL}"
  else
    fail "HEAD ${BASE_URL}"
  fi

  echo
  echo ">> GET ${BASE_URL}/healthz"
  HEALTH_BODY="$(curl "${curl_flags[@]}" "${BASE_URL}/healthz" 2>/dev/null || true)"
  echo "${HEALTH_BODY}"

  if echo "${HEALTH_BODY}" | grep -Eiq 'ok|healthy|status'; then
    ok "GET /healthz zwraca odpowiedź zdrowia"
  else
    warn "GET /healthz nie zawiera ok/healthy/status — sprawdź, czy endpoint ma inny format"
  fi

  echo
  echo ">> GET ${BASE_URL}/api/sla-policies"
  SLA_HTTP_CODE="$(curl "${curl_flags[@]}" -o /tmp/helpdesk-v40-sla-policies.json -w '%{http_code}' "${BASE_URL}/api/sla-policies" || true)"
  echo "HTTP ${SLA_HTTP_CODE}"
  head -c 500 /tmp/helpdesk-v40-sla-policies.json 2>/dev/null || true
  echo

  if [[ "${SLA_HTTP_CODE}" =~ ^2|401|403$ ]]; then
    ok "/api/sla-policies odpowiada kontrolowanym kodem HTTP ${SLA_HTTP_CODE}"
  else
    warn "/api/sla-policies zwróciło nietypowy HTTP ${SLA_HTTP_CODE}"
  fi
else
  warn "curl niedostępny — pomijam HTTP/HTTPS smoke"
fi

section "10. Logi aplikacji"
if [[ "${CHECK_LOGS}" == "1" ]]; then
  APP_POD="$(kubectl get pods -n "${NAMESPACE}" -l app=helpdesk -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"

  if [[ -n "${APP_POD}" ]]; then
    echo ">> Ostatnie 120 linii logów z ${APP_POD}"
    kubectl logs -n "${NAMESPACE}" "${APP_POD}" --tail=120 || warn "Nie udało się pobrać logów ${APP_POD}"

    echo
    echo ">> Kontrola traceback/error"
    if kubectl logs -n "${NAMESPACE}" "${APP_POD}" --tail=300 2>/dev/null | grep -Eiq 'Traceback|SyntaxError|IndentationError|Exception'; then
      fail "W logach aplikacji znaleziono Traceback/SyntaxError/IndentationError/Exception"
    else
      ok "W ostatnich logach aplikacji nie znaleziono krytycznych błędów Pythona"
    fi
  else
    warn "Nie znaleziono poda app=helpdesk — pomijam kontrolę logów"
  fi
else
  warn "HELPDESK_SMOKE_CHECK_LOGS=0 — pomijam kontrolę logów"
fi

section "Podsumowanie"
echo "Błędy:       ${FAILED}"
echo "Ostrzeżenia: ${WARNINGS}"

if [[ "${FAILED}" -gt 0 ]]; then
  echo
  echo "WYNIK: FAIL"
  exit 1
fi

echo
echo "WYNIK: OK"
exit 0
