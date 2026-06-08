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
- dynamiczne menu: ukrycie Kalendarza SLA po odebraniu uprawnienia operatorowi,
- API raportów oraz eksport CSV raportów,
- API kalendarza SLA i ręczne sprawdzenie SLA,
- API audytu oraz eksport CSV audytu,
- UI modułów Raporty, Kalendarz SLA i Audyt bez błędów krytycznych.

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


## Testy SLA, raportów i audytu

Nowe testy regresji sprawdzają:

- `GET /api/reports` i `GET /api/reports.csv`,
- `GET /api/sla-calendar` i `POST /api/sla/check`,
- `GET /api/audit` i `GET /api/audit.csv`,
- otwarcie ekranów **Raporty**, **Kalendarz SLA** i **Audyt** w UI bez błędów JavaScript oraz bez odpowiedzi HTTP 5xx.

Te testy wymagają konta z uprawnieniami administracyjnymi albo operacyjnymi do raportów, SLA i audytu.

## Pakiet v11 — testy negatywne API i uprawnień

Dodane testy sprawdzają:

- `401` dla API bez sesji oraz z błędnym `X-Helpdesk-Session`,
- kontrolowane błędy `4xx` dla pustego zgłoszenia, nieistniejącego zgłoszenia i załącznika bez pliku,
- brak dostępu operatora do macierzy uprawnień, jeśli nie ma `permissions.view`,
- brak dostępu zwykłego użytkownika do endpointów administracyjnych,
- audyt odmowy dostępu jako `permission_denied`.

Dodatkowe testy ról są uruchamiane tylko wtedy, gdy ustawisz zmienne:

```bash
export HELPDESK_OPERATOR_EMAIL="operator-test@example.local"
export HELPDESK_OPERATOR_PASSWORD="..."
export HELPDESK_USER_EMAIL="user-test@example.local"
export HELPDESK_USER_PASSWORD="..."
```

Jeżeli te zmienne nie są ustawione, testy zależne od operatora lub zwykłego użytkownika zostaną pominięte.

## v12 — rozszerzone walidacje workflow

Dodano scenariusze regresyjne dla najważniejszych założeń workflow:

- stary komentarz dodany przed wejściem zgłoszenia w aktualny status nie spełnia wymogu komentarza,
- stary załącznik dodany przed wejściem zgłoszenia w aktualny status nie spełnia wymogu załącznika,
- komentarz dodany przez innego operatora nie spełnia wymogu dla operatora, który zmienia status.

Ostatni test wymaga ustawienia konta operatora testowego:

```bash
export HELPDESK_OPERATOR_EMAIL="operator-test@example.local"
export HELPDESK_OPERATOR_PASSWORD="HASLO_OPERATORA_LOKALNIE"
```

## v13 — role użytkowników i widoczność modułów

Dodane testy sprawdzają profile użytkowników:

- menu administratora jest zgodne z realnymi uprawnieniami z `/api/permissions/me`,
- menu operatora jest zgodne z realnymi uprawnieniami,
- menu zwykłego użytkownika jest zgodne z realnymi uprawnieniami,
- backend administracyjny zwraca `403` dla operatora/użytkownika bez wymaganych uprawnień,
- endpointy administracyjne działają tylko wtedy, gdy profil ma odpowiednie kody uprawnień.

Testy operatora i zwykłego użytkownika wymagają zmiennych:

```bash
export HELPDESK_OPERATOR_EMAIL="operator-test@example.local"
export HELPDESK_OPERATOR_PASSWORD="..."
export HELPDESK_USER_EMAIL="user-test@example.local"
export HELPDESK_USER_PASSWORD="..."
```

Jeżeli konta nie są ustawione, testy zależne od tych profili zostaną pominięte.

## v14 — raporty i audyt: walidacja danych

Dodane testy sprawdzają nie tylko dostępność endpointów, ale również sens danych:

- raport dzienny po utworzeniu zgłoszenia zwiększa licznik utworzonych zgłoszeń,
- zgłoszenie o priorytecie `Niski` zwiększa agregację `by_priority`,
- zgłoszenie w kategorii `Inne` zwiększa agregację `by_category`,
- trend dzienny `by_day` pokazuje wzrost dla bieżącej daty,
- eksport CSV raportów zawiera sekcje: podsumowanie, priorytety, kategorie i trend dzienny,
- audyt zawiera wpis po utworzeniu zgłoszenia testowego,
- eksport CSV audytu respektuje filtr po ID zgłoszenia,
- eksport macierzy uprawnień zawiera role `user`, `operator`, `admin`.

## Pakiet v15 — filtrowanie i wyszukiwanie zgłoszeń

Dodano testy regresji dla głównej listy zgłoszeń:

- wyszukiwanie po unikalnym tytule,
- wyszukiwanie po numerze `#ID`,
- filtrowanie po priorytecie,
- filtrowanie po kategorii i podkategorii,
- filtrowanie po statusie,
- filtrowanie po dacie utworzenia,
- podstawowy test UI pola wyszukiwania oraz czyszczenia filtrów,
- kontrola braku błędów JavaScript i HTTP 5xx podczas używania filtrów.

Te testy zabezpieczają regresję, która wcześniej powodowała pustą pierwszą stronę po zmianach w filtrach zgłoszeń.

## Pakiet v17 — głębsza walidacja SLA

Dodano testy, które sprawdzają nie tylko dostępność endpointów SLA, ale również dane biznesowe:

- nowe zgłoszenie dostaje terminy `first_response_due_at` i `sla_due_at` zgodne z polityką SLA priorytetu,
- komentarz operatora rejestruje pierwszą reakcję SLA (`first_response_at`),
- nowe otwarte zgłoszenie pojawia się w kalendarzu SLA,
- ekran Kalendarza SLA pokazuje strukturę oraz nowe zgłoszenie bez błędów JS i HTTP 5xx.

Uruchomienie:

```bash
npm run test:e2e
```
