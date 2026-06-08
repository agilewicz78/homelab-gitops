#!/usr/bin/env python3
"""
Helpdesk API smoke tests.

Uruchamiaj lokalnie w sieci, która widzi helpdesk.lab.local.
Dane logowania pobierane są wyłącznie ze zmiennych środowiskowych.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import requests


class SmokeFailure(Exception):
    pass


class HelpdeskClient:
    def __init__(self, base_url: str, verify_tls: bool = True, timeout: int = 15):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.verify = verify_tls
        self.session.headers.update({"Accept": "application/json"})

    def request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        url = f"{self.base_url}{path}"
        response = self.session.request(method, url, timeout=self.timeout, **kwargs)
        return response

    def json_request(self, method: str, path: str, expected: tuple[int, ...] = (200,), **kwargs: Any) -> Dict[str, Any]:
        response = self.request(method, path, **kwargs)
        if response.status_code not in expected:
            raise SmokeFailure(f"{method} {path} -> HTTP {response.status_code}: {response.text[:800]}")
        try:
            return response.json()
        except Exception as exc:
            raise SmokeFailure(f"{method} {path} did not return JSON: {exc}; body={response.text[:800]}") from exc


def print_ok(message: str) -> None:
    print(f"[OK] {message}")


def print_step(message: str) -> None:
    print(f"\n== {message} ==")


def try_login(client: HelpdeskClient, email: str, password: str) -> None:
    """Try common login payloads used by simple Flask apps."""
    candidates = [
        {"email": email, "password": password},
        {"username": email, "password": password},
        {"login": email, "password": password},
    ]
    last_error: Optional[str] = None
    for payload in candidates:
        response = client.request("POST", "/api/login", json=payload)
        if response.status_code in (200, 204):
            # Helpdesk nie używa ciasteczka sesji. Endpoint /api/login zwraca sid,
            # który frontend zapisuje w sessionStorage i wysyła w nagłówku
            # X-Helpdesk-Session. Smoke test musi zrobić to samo.
            sid = None
            try:
                data = response.json() if response.text else {}
                sid = data.get("sid")
            except Exception:
                data = {}
            if not sid:
                raise SmokeFailure(f"Logowanie zwróciło HTTP {response.status_code}, ale brak pola sid w odpowiedzi: {response.text[:500]}")
            client.session.headers.update({"X-Helpdesk-Session": sid})
            print_ok("Logowanie API działa; ustawiono X-Helpdesk-Session")
            return
        last_error = f"HTTP {response.status_code}: {response.text[:500]}"
    raise SmokeFailure(f"Nie udało się zalogować przez /api/login. Ostatni błąd: {last_error}")


def ensure_api_me(client: HelpdeskClient) -> Dict[str, Any]:
    me = client.json_request("GET", "/api/me")
    if not isinstance(me, dict):
        raise SmokeFailure("/api/me nie zwróciło obiektu JSON")
    if not (me.get("email") or me.get("user", {}).get("email")):
        raise SmokeFailure("/api/me nie zawiera email użytkownika")
    print_ok(f"/api/me działa: {me.get('email') or me.get('user', {}).get('email')}")
    return me


def get_tickets(client: HelpdeskClient) -> Dict[str, Any]:
    data = client.json_request("GET", "/api/tickets?page=1&page_size=5")
    if not isinstance(data, dict):
        raise SmokeFailure("/api/tickets nie zwróciło obiektu JSON")
    print_ok("Lista zgłoszeń API działa")
    return data


def create_ticket_if_enabled(client: HelpdeskClient, enabled: bool) -> Optional[int]:
    if not enabled:
        print("[SKIP] Tworzenie zgłoszenia pominięte; użyj --create-ticket aby włączyć")
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    payloads = [
        {
            "title": f"E2E smoke test {stamp}",
            "description": "Automatyczne zgłoszenie testowe utworzone przez smoke test.",
            "priority": "Normalny",
            "category": "Inne",
            "subcategory": "Inne",
            "requester_name": "Smoke Test",
            "requester_email": "smoke.test@example.local",
        },
        {
            "subject": f"E2E smoke test {stamp}",
            "description": "Automatyczne zgłoszenie testowe utworzone przez smoke test.",
            "priority": "Normalny",
        },
    ]
    last_error = None
    for payload in payloads:
        response = client.request("POST", "/api/tickets", json=payload)
        if response.status_code in (200, 201):
            data = response.json()
            ticket_id = data.get("id") or data.get("ticket_id") or data.get("ticket", {}).get("id")
            if ticket_id is None:
                raise SmokeFailure(f"Utworzono zgłoszenie, ale nie znaleziono ID w odpowiedzi: {data}")
            print_ok(f"Utworzono zgłoszenie testowe #{ticket_id}")
            return int(ticket_id)
        last_error = f"HTTP {response.status_code}: {response.text[:500]}"
    raise SmokeFailure(f"Nie udało się utworzyć zgłoszenia testowego. Ostatni błąd: {last_error}")



def exercise_ticket_if_enabled(client: HelpdeskClient, ticket_id: Optional[int], enabled: bool) -> None:
    """Opcjonalny test funkcjonalny API: komentarz, załącznik i ponowny odczyt zgłoszenia."""
    if not enabled:
        print("[SKIP] Ćwiczenie zgłoszenia pominięte; użyj --exercise-ticket aby włączyć")
        return
    if ticket_id is None:
        ticket_id = create_ticket_if_enabled(client, True)
    if ticket_id is None:
        raise SmokeFailure("Nie udało się ustalić ID zgłoszenia do testu funkcjonalnego")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    comment = f"Komentarz smoke API {stamp}"
    response = client.request("POST", f"/api/tickets/{ticket_id}/comments", json={"content": comment, "visibility": "public"})
    if response.status_code not in (200, 201):
        raise SmokeFailure(f"Dodanie komentarza do #{ticket_id} -> HTTP {response.status_code}: {response.text[:500]}")
    print_ok(f"Dodano komentarz do zgłoszenia #{ticket_id}")

    filename = f"smoke-api-{stamp}.txt"
    file_bytes = b"Zalacznik testowy smoke API.\n"
    response = client.request(
        "POST",
        f"/api/tickets/{ticket_id}/attachments",
        files={"file": (filename, file_bytes, "text/plain")},
    )
    if response.status_code not in (200, 201):
        raise SmokeFailure(f"Dodanie załącznika do #{ticket_id} -> HTTP {response.status_code}: {response.text[:500]}")
    print_ok(f"Dodano załącznik do zgłoszenia #{ticket_id}")

    detail = client.json_request("GET", f"/api/tickets/{ticket_id}")
    comments = detail.get("comments", [])
    attachments = detail.get("attachments", [])
    if not any(comment in str(c.get("content", "")) for c in comments):
        raise SmokeFailure(f"Po dodaniu komentarza nie znaleziono go w szczegółach zgłoszenia #{ticket_id}")
    if not any(filename == a.get("original_filename") for a in attachments):
        raise SmokeFailure(f"Po dodaniu załącznika nie znaleziono pliku {filename} w szczegółach zgłoszenia #{ticket_id}")
    print_ok(f"Szczegóły zgłoszenia #{ticket_id} zawierają dodany komentarz i załącznik")


def check_optional_endpoints(client: HelpdeskClient) -> None:
    endpoints = [
        ("GET", "/api/reports"),
        ("GET", "/api/notifications"),
        ("GET", "/api/permissions/me"),
        ("GET", "/api/admin/permissions"),
        ("GET", "/api/admin/workflow-rule-executions"),
    ]
    for method, path in endpoints:
        response = client.request(method, path)
        if response.status_code in (200, 204, 403):
            print_ok(f"{method} {path} odpowiada HTTP {response.status_code}")
        else:
            raise SmokeFailure(f"{method} {path} -> HTTP {response.status_code}: {response.text[:500]}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Helpdesk API smoke test")
    parser.add_argument("--url", default=os.environ.get("HELPDESK_URL"), help="Adres helpdesku, np. https://helpdesk.lab.local")
    parser.add_argument("--email", default=os.environ.get("HELPDESK_ADMIN_EMAIL"), help="Email konta testowego/admina")
    parser.add_argument("--password", default=os.environ.get("HELPDESK_ADMIN_PASSWORD"), help="Hasło konta testowego/admina")
    parser.add_argument("--insecure", action="store_true", help="Wyłącz weryfikację TLS, przydatne dla labowego CA")
    parser.add_argument("--create-ticket", action="store_true", help="Utwórz testowe zgłoszenie")
    parser.add_argument("--exercise-ticket", action="store_true", help="Utwórz lub użyj zgłoszenia testowego, dodaj komentarz i załącznik, a potem zweryfikuj szczegóły")
    args = parser.parse_args()

    if not args.url or not args.email or not args.password:
        print("Brakuje HELPDESK_URL / HELPDESK_ADMIN_EMAIL / HELPDESK_ADMIN_PASSWORD albo argumentów CLI", file=sys.stderr)
        return 2

    client = HelpdeskClient(args.url, verify_tls=not args.insecure)
    try:
        print_step("Logowanie")
        try_login(client, args.email, args.password)
        print_step("Użytkownik i uprawnienia")
        ensure_api_me(client)
        print_step("Lista zgłoszeń")
        get_tickets(client)
        print_step("Opcjonalne endpointy")
        check_optional_endpoints(client)
        print_step("Tworzenie zgłoszenia testowego")
        ticket_id = create_ticket_if_enabled(client, args.create_ticket)
        print_step("Komentarz i załącznik API")
        exercise_ticket_if_enabled(client, ticket_id, args.exercise_ticket)
    except SmokeFailure as exc:
        print(f"\n[FAIL] {exc}", file=sys.stderr)
        return 1

    print("\n[SUCCESS] Smoke test API zakończony powodzeniem")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
