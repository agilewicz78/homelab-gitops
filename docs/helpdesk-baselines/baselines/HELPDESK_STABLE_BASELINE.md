# Helpdesk — stabilny punkt kontrolny

Ten zestaw plików stanowi bezpieczną bazę do dalszego rozwoju aplikacji Helpdesk.

## Pliki

- `app-configmap-stable-2026-06-08.yaml` — stabilny ConfigMap aplikacji Helpdesk.
- `HELPDESK_STABLE_BASELINE.md` — instrukcja wdrożenia, testów i rollbacku.

## Co obejmuje wersja bazowa

Wersja bazowa zawiera potwierdzone funkcjonalności:

- obsługa zgłoszeń,
- komentarze,
- załączniki,
- workflow i reguły automatyzacji,
- walidacje wymagające komentarza i załącznika,
- panel wymagań przed zmianą statusu,
- historia statusów,
- log automatyzacji workflow,
- testowanie reguł workflow,
- dodatkowe akcje i warunki workflow,
- operatory warunków workflow,
- szablony reguł workflow,
- centrum powiadomień,
- SLA,
- raporty i eksport CSV,
- audyt i eksport CSV,
- role i uprawnienia,
- dynamiczne menu zależne od uprawnień,
- eksport macierzy uprawnień do CSV.

## Wdrożenie stabilnej wersji

```bash
kubectl apply -f app-configmap-stable-2026-06-08.yaml
kubectl rollout restart deployment -n helpdesk helpdesk
kubectl rollout status deployment -n helpdesk helpdesk
kubectl get pods -n helpdesk -o wide
kubectl logs -n helpdesk deploy/helpdesk --tail=200
```

Po wdrożeniu wykonaj w przeglądarce twarde odświeżenie:

```text
Ctrl + F5
```

## Testy po wdrożeniu

Na stacji Ubuntu Desktop, w katalogu repo:

```bash
cd ~/homelab-gitops
npm run test:e2e
```

Dodatkowo test API:

```bash
source .venv/bin/activate
python scripts/helpdesk_api_smoke.py --insecure --exercise-ticket
```

## Rollback do tej wersji

Jeśli kolejna zmiana uszkodzi aplikację, wróć do tej wersji:

```bash
kubectl apply -f app-configmap-stable-2026-06-08.yaml
kubectl rollout restart deployment -n helpdesk helpdesk
kubectl rollout status deployment -n helpdesk helpdesk
kubectl logs -n helpdesk deploy/helpdesk --tail=200
```

Jeżeli aplikacja nadal nie startuje, sprawdź:

```bash
kubectl get pods -n helpdesk -o wide
kubectl describe pod -n helpdesk -l app=helpdesk
kubectl logs -n helpdesk deploy/helpdesk --tail=300
```

## Zalecenie pracy nad kolejnymi zmianami

Przy kolejnych zmianach używaj schematu:

1. zmiana w osobnym pliku/commicie,
2. wdrożenie do k3s,
3. `npm run test:e2e`,
4. `python scripts/helpdesk_api_smoke.py --insecure --exercise-ticket`,
5. commit i push dopiero po zielonych testach.

Nie wracaj od razu do dużych zmian typu tagi lub szablony odpowiedzi bez podziału na małe etapy.
