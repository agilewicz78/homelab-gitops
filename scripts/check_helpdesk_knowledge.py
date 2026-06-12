#!/usr/bin/env python3
"""Behavior regression checks for the Helpdesk knowledge base."""

import ast
from pathlib import Path


APP_CONFIG = Path("applications/helpdesk/app-configmap.yaml")
APP_MARKER = "  app.py: |\n"


class Request:
    payload = {}

    @classmethod
    def get_json(cls, silent=True):
        return cls.payload


class Cursor:
    def __init__(self):
        self.last_query = ""
        self.ticket_events = []
        self.audit_events = []

    def execute(self, query, params=None):
        self.last_query = " ".join(query.split())

    def fetchone(self):
        if "FROM tickets" in self.last_query:
            return (
                "Poczta nie działa",
                "Outlook nie wysyła wiadomości.",
                "Oprogramowanie",
                "Poczta",
                "Zamknięte",
                "Wyczyść profil Outlooka i uruchom aplikację ponownie.",
            )
        if "SELECT id FROM knowledge_articles" in self.last_query:
            return None
        if "INSERT INTO knowledge_articles" in self.last_query:
            return (42,)
        return None

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
        "add_ticket_event": lambda *args, **kwargs: ticket_events.append((args, kwargs)),
        "log_audit": lambda *args, **kwargs: audit_events.append((args, kwargs)),
        "publish_event": lambda *args, **kwargs: live_events.append((args, kwargs)),
    }
    exec(load_function("api_create_knowledge_article"), namespace)

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

    print("Helpdesk knowledge base checks passed")


if __name__ == "__main__":
    main()
