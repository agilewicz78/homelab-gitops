# Helpdesk E2E Testing

Ten katalog zawiera lokalne testy API i UI dla aplikacji Helpdesk uruchamianej w labie.
Testy uruchamiaj na maszynie, która widzi `https://helpdesk.lab.local`, np. na Ubuntu Desktop.

## Zmienne środowiskowe

Wymagane dla podstawowych testów:

```bash
export HELPDESK_URL="https://helpdesk.lab.local"
export HELPDESK_ADMIN_EMAIL="admin@incoprp.local"
export HELPDESK_ADMIN_PASSWORD="TU_WPISZ_HASLO_LOKALNIE"
export HELPDESK_IGNORE_TLS=1
```

Opcjonalne dla testu dynamicznego menu operatora:

```bash
export HELPDESK_OPERATOR_EMAIL="operator-test@example.local"
export HELPDESK_OPERATOR_PASSWORD="TU_WPISZ_HASLO_OPERATORA_LOKALNIE"
```

Hasła wpisuj tylko lokalnie. Nie commituj pliku `.env`.

## Test API

```bash
source .venv/bin/activate
python scripts/helpdesk_api_smoke.py --insecure
python scripts/helpdesk_api_smoke.py --insecure --exercise-ticket
```

## Test UI

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

Tryb z widoczną przeglądarką:

```bash
npm run test:e2e:headed
```

Raport:

```bash
npm run report
```

## Zakres testów

Testy UI sprawdzają:

- logowanie i stronę główną,
- ładowanie listy zgłoszeń,
- podstawowe moduły administracyjne bez błędów JS i HTTP 5xx,
- utworzenie zgłoszenia przez UI,
- dodanie komentarza przez UI,
- dodanie załącznika przez UI,
- proces workflow: blokada zmiany statusu bez nowego komentarza i załącznika operatora,
- dynamiczne menu: ukrycie Kalendarza SLA po odebraniu uprawnienia operatorowi.

Test dynamicznego menu jest pomijany, jeśli nie ustawisz `HELPDESK_OPERATOR_EMAIL` i `HELPDESK_OPERATOR_PASSWORD`.

## Uwaga o testach modyfikujących dane

Test workflow tworzy tymczasową regułę automatyzacji ograniczoną do zgłoszeń testowych o priorytecie `Niski` i usuwa ją w bloku `finally`.
Test uprawnień tymczasowo odbiera operatorowi `sla.view`/`sla.manage`, sprawdza menu i przywraca oryginalne uprawnienia w bloku `finally`.

## Zbieranie wyników po błędzie

```bash
tar -czf helpdesk-ui-test-results.tar.gz playwright-report test-results
kubectl logs -n helpdesk deploy/helpdesk-app --tail=300 > helpdesk-app.log
kubectl get pods -n helpdesk -o wide > helpdesk-pods.txt
```
