#!/usr/bin/env python3
"""Behavior regression checks for the Helpdesk knowledge base."""

import ast
from pathlib import Path


APP_CONFIG = Path("applications/helpdesk/app-configmap.yaml")
APP_MARKER = "  app.py: |\n"


class Request:
    payload = {}
    args = {}

    @classmethod
    def get_json(cls, silent=True):
        return cls.payload


class Cursor:
    def __init__(self):
        self.last_query = ""
        self.last_params = ()
        self.ticket_events = []
        self.audit_events = []
        self.feedback_upserts = []

    def execute(self, query, params=None):
        self.last_query = " ".join(query.split())
        self.last_params = params or ()
        if "INSERT INTO knowledge_article_feedback" in self.last_query:
            self.feedback_upserts.append(self.last_params)

    def fetchone(self):
        if "SELECT status, source_ticket_id FROM knowledge_articles" in self.last_query:
            return ("published", 101)
        if "COUNT(*) FILTER (WHERE helpful = TRUE)" in self.last_query:
            return (3, 1)
        if "FROM tickets" in self.last_query:
            return (
                "Poczta nie działa",
                "Outlook nie wysyła wiadomości.",
                "Oprogramowanie",
                "Poczta",
                "Zamknięte",
                "",
            )
        if "SELECT id FROM knowledge_articles" in self.last_query:
            return None
        if "INSERT INTO knowledge_articles" in self.last_query:
            return (42,)
        return None

    def fetchall(self):
        if "FROM knowledge_articles ka" in self.last_query:
            return [
                (
                    7,
                    "Naprawa wysyłania poczty w Outlooku",
                    "Outlook nie wysyła wiadomości.",
                    "Wyczyść profil Outlooka i uruchom aplikację ponownie.",
                    "Oprogramowanie",
                    "Poczta",
                    "published",
                    101,
                    "Operator",
                    "2026-06-13 12:00:00",
                    "2026-06-12 20:00:00",
                    2,
                    3,
                ),
            ]
        if "WHERE status = 'published'" in self.last_query:
            return [
                (
                    7,
                    "Naprawa wysyłania poczty w Outlooku",
                    "Outlook nie wysyła wiadomości.",
                    "Wyczyść profil Outlooka i uruchom aplikację ponownie.",
                    "Oprogramowanie",
                    "Poczta",
                    "2026-06-12 20:00:00",
                ),
                (
                    8,
                    "Wymiana rolki drukarki",
                    "Drukarka zacina papier.",
                    "Wymień rolkę podajnika.",
                    "Sprzęt",
                    "Drukarki",
                    "2026-06-11 20:00:00",
                ),
            ]
        return []

    def close(self):
        pass


class Connection:
    def __init__(self):
        self.cursor_value = Cursor()
        self.committed = False

    def cursor(self):
        return self.cursor_value

    def commit(self):
        self.committed = True

    def close(self):
        pass


def load_function(name):
    text = APP_CONFIG.read_text(encoding="utf-8")
    _, app_block = text.split(APP_MARKER, 1)
    app_source = "".join(
        line[4:] if line.startswith("    ") else line
        for line in app_block.splitlines(keepends=True)
    )
    tree = ast.parse(app_source)
    selected = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            node.decorator_list = []
            selected.append(node)
    assert len(selected) == 1
    module = ast.Module(body=selected, type_ignores=[])
    ast.fix_missing_locations(module)
    return compile(module, "knowledge-base-test.py", "exec")


def main():
    connections = []
    ticket_events = []
    audit_events = []
    live_events = []

    def get_conn():
        connection = Connection()
        connections.append(connection)
        return connection

    namespace = {
        "request": Request,
        "clean": lambda value: str(value or "").strip(),
        "get_conn": get_conn,
        "jsonify": lambda value: value,
        "CATEGORIES": ["Oprogramowanie"],
        "SUBCATEGORIES": {"Oprogramowanie": ["Poczta", "Inne"]},
        "KNOWLEDGE_STATUSES": ["draft", "published", "archived"],
        "is_staff": lambda user: user.get("role") in ("Operator", "Administrator"),
        "add_ticket_event": lambda *args, **kwargs: ticket_events.append((args, kwargs)),
        "log_audit": lambda *args, **kwargs: audit_events.append((args, kwargs)),
        "publish_event": lambda *args, **kwargs: live_events.append((args, kwargs)),
        "similarity_tokens": lambda *values: {
            token.lower().strip(".,")
            for value in values
            for token in str(value or "").split()
            if len(token.strip(".,")) >= 4
        },
        "similarity_score": lambda source, candidate, same_category=False, same_subcategory=False: (
            (80, ["Wspólne słowa", "Ta sama kategoria", "Ta sama podkategoria"])
            if source & candidate and same_category and same_subcategory
            else (0, [])
        ),
    }
    exec(load_function("api_create_knowledge_article"), namespace)
    exec(load_function("api_knowledge_articles"), namespace)
    exec(load_function("api_knowledge_suggestions"), namespace)
    exec(load_function("api_knowledge_article_feedback"), namespace)

    Request.payload = {
        "source_ticket_id": 101,
        "title": "Naprawa wysyłania poczty w Outlooku",
        "problem": "Outlook nie wysyła wiadomości.",
        "solution": "Wyczyść profil Outlooka i uruchom aplikację ponownie.",
        "category": "Oprogramowanie",
        "subcategory": "Poczta",
        "status": "published",
    }
    user = {"email": "operator@example.local", "name": "Operator"}
    body, status = namespace["api_create_knowledge_article"](user)

    assert status == 201
    assert body == {"id": 42, "status": "published"}
    assert connections[-1].committed is True
    assert ticket_events[-1][0][1] == 101
    assert ticket_events[-1][0][3] == "knowledge_article_created"
    assert audit_events[-1][0][2] == "knowledge_article_created"
    assert live_events[-1][0][1] == "knowledge_article_changed"
    assert live_events[-1][1]["staff_only"] is False

    Request.args = {"quality": "needs_review"}
    list_body = namespace["api_knowledge_articles"]({
        "email": "operator@example.local",
        "name": "Operator",
        "role": "Operator",
    })
    list_connection = connections[-1]
    assert list_body["filter"]["quality"] == "needs_review"
    assert list_body["articles"][0]["helpful_count"] == 2
    assert list_body["articles"][0]["not_helpful_count"] == 3
    assert "COALESCE(feedback.not_helpful_count, 0) > 0" in list_connection.cursor_value.last_query
    assert "GROUP BY article_id" in list_connection.cursor_value.last_query

    Request.args = {
        "title": "Outlook nie wysyła poczty",
        "description": "Wiadomości pozostają w skrzynce nadawczej.",
        "category": "Oprogramowanie",
        "subcategory": "Poczta",
    }
    suggestion_body = namespace["api_knowledge_suggestions"](user)
    assert len(suggestion_body["suggestions"]) == 1
    assert suggestion_body["suggestions"][0]["id"] == 7
    assert suggestion_body["suggestions"][0]["score"] == 80
    assert suggestion_body["suggestions"][0]["solution"].startswith("Wyczyść profil")

    connection_count = len(connections)
    Request.args = {"title": "Błąd", "description": ""}
    assert namespace["api_knowledge_suggestions"](user) == {"suggestions": []}
    assert len(connections) == connection_count

    Request.payload = {"helpful": True}
    feedback_body = namespace["api_knowledge_article_feedback"](
        {"email": "user@example.local", "name": "User"},
        7,
    )
    feedback_connection = connections[-1]
    assert feedback_body == {
        "helpful": 3,
        "not_helpful": 1,
        "my_feedback": True,
    }
    assert feedback_connection.committed is True
    assert feedback_connection.cursor_value.feedback_upserts == [
        (7, "user@example.local", True),
    ]
    assert audit_events[-1][0][2] == "knowledge_article_feedback"
    assert live_events[-1][0][1] == "knowledge_article_changed"

    print("Helpdesk knowledge base checks passed")


if __name__ == "__main__":
    main()
