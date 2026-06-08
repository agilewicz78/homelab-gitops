# Helpdesk — testy API i UI E2E

Ten pakiet służy do testowania helpdesku w Twoim labie. Testy UI wymagają dostępu do adresu aplikacji, np. `https://helpdesk.lab.local`, dlatego uruchamiaj je na komputerze, który widzi Twoją sieć labową i ma rozwiązywanie DNS/hosts dla `helpdesk.lab.local`.

## 1. Wymagania

Na komputerze testującym zainstaluj:

- Python 3.10+
- Node.js 20+
- npm
- dostęp sieciowy do `https://helpdesk.lab.local`

Sprawdź połączenie:

```bash
curl -k -I https://helpdesk.lab.local
```

## 2. Rozpakowanie paczki

Z katalogu repo:

```bash
unzip helpdesk-e2e-tests.zip -d .
```

## 3. Test API smoke

Ustaw dane testowe tylko lokalnie w terminalu:

```bash
export HELPDESK_URL="https://helpdesk.lab.local"
export HELPDESK_ADMIN_EMAIL="admin@example.local"
export HELPDESK_ADMIN_PASSWORD="TU_WPISZ_HASLO_LOKALNIE"
```

Uruchom:

```bash
python3 -m pip install requests
python3 scripts/helpdesk_api_smoke.py --insecure
```

Opcjonalnie, aby test utworzył testowe zgłoszenie:

```bash
python3 scripts/helpdesk_api_smoke.py --insecure --create-ticket
```

## 4. Testy UI Playwright

Instalacja:

```bash
npm install
npx playwright install chromium
```

Uruchomienie w trybie headless:

```bash
export HELPDESK_URL="https://helpdesk.lab.local"
export HELPDESK_ADMIN_EMAIL="admin@example.local"
export HELPDESK_ADMIN_PASSWORD="TU_WPISZ_HASLO_LOKALNIE"
export HELPDESK_IGNORE_TLS=1
npm run test:e2e
```

Uruchomienie z widoczną przeglądarką:

```bash
npm run test:e2e:headed
```

Raport:

```bash
npm run report
```

## 5. Co przesłać do analizy

Po nieudanym teście spakuj i prześlij:

```bash
tar -czf helpdesk-test-results.tar.gz playwright-report test-results
kubectl logs -n helpdesk deploy/helpdesk-app --tail=300 > helpdesk-app.log
kubectl get pods -n helpdesk -o wide > helpdesk-pods.txt
kubectl describe pod -n helpdesk -l app=helpdesk-app > helpdesk-pod-describe.txt
```

Prześlij:

- `helpdesk-test-results.tar.gz`
- `helpdesk-app.log`
- `helpdesk-pods.txt`
- `helpdesk-pod-describe.txt`

Nie przesyłaj haseł, tokenów, sekretów ani plików `.env`.

## 6. Opcja GitHub Actions

Publiczny runner GitHub nie widzi `helpdesk.lab.local`. Testy E2E w GitHub Actions mają sens dopiero po dodaniu self-hosted runnera w Twojej sieci labowej. Bez tego GitHub Actions może uruchamiać tylko testy statyczne.

## Uwaga do testu UI v3

Wersja v3 nie traktuje samego komunikatu przeglądarki `Failed to load resource ... 401/403` jako błędu JavaScript. Takie wpisy mogą pojawić się przy sprawdzaniu modułów zależnych od uprawnień. Test nadal wykrywa realne błędy runtime, np. `ReferenceError`, `is not defined`, błędy logu automatyzacji oraz odpowiedzi HTTP 5xx.
