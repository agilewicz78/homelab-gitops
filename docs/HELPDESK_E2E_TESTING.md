# Helpdesk — testy API i UI E2E

Ten katalog zawiera testy uruchamiane lokalnie z maszyny, która widzi adres `https://helpdesk.lab.local`.
Nie zapisuj haseł w repozytorium. Dane logowania podawaj wyłącznie przez zmienne środowiskowe.

## Wymagania

```bash
sudo apt install -y python3-venv python3-pip nodejs npm
```

## Konfiguracja Python

```bash
cd ~/homelab-gitops
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install requests
```

## Zmienne środowiskowe

```bash
export HELPDESK_URL="https://helpdesk.lab.local"
export HELPDESK_ADMIN_EMAIL="admin@incoprp.local"
export HELPDESK_ADMIN_PASSWORD="TU_WPISZ_HASLO_LOKALNIE"
export HELPDESK_IGNORE_TLS=1
```

## Smoke test API

Podstawowy test API:

```bash
python scripts/helpdesk_api_smoke.py --insecure
```

Test API z utworzeniem zgłoszenia:

```bash
python scripts/helpdesk_api_smoke.py --insecure --create-ticket
```

Test API z utworzeniem zgłoszenia, dodaniem komentarza, dodaniem załącznika i ponowną weryfikacją szczegółów:

```bash
python scripts/helpdesk_api_smoke.py --insecure --exercise-ticket
```

## Testy UI Playwright

Instalacja zależności:

```bash
npm install
npx playwright install chromium
```

Uruchomienie testów UI:

```bash
npm run test:e2e
```

Uruchomienie testów UI z widoczną przeglądarką:

```bash
npm run test:e2e:headed
```

Raport HTML:

```bash
npm run report
```

## Zakres testów UI

Testy UI sprawdzają obecnie:

- logowanie i start aplikacji,
- ładowanie listy zgłoszeń,
- podstawowe moduły administracyjne bez błędów JavaScript i HTTP 5xx,
- utworzenie zgłoszenia przez UI,
- dodanie komentarza do zgłoszenia przez UI,
- dodanie załącznika do zgłoszenia przez UI.

## Gdy test się nie powiedzie

Zbierz wyniki Playwrighta:

```bash
tar -czf helpdesk-ui-test-results.tar.gz playwright-report test-results
```

Zbierz logi aplikacji:

```bash
kubectl logs -n helpdesk deploy/helpdesk-app --tail=300 > helpdesk-app.log
kubectl get pods -n helpdesk -o wide > helpdesk-pods.txt
```

Prześlij do analizy:

```text
helpdesk-ui-test-results.tar.gz
helpdesk-app.log
helpdesk-pods.txt
```


## v5

Poprawiono helpery UI `clickFirstVisible` i `fillFirstVisible`, żeby czekały na asynchroniczne wyrenderowanie widoków po logowaniu.
