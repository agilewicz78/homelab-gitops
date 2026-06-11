#!/usr/bin/env python3
"""Behavior regression checks for the Helpdesk incident flow."""

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
        self.rowcount = 1
        self.comment_inserts = []
        self.incident_timestamp_updates = 0
        self.ticket_timestamp_updates = 0

    def execute(self, query, params=None):
        self.last_query = " ".join(query.split())
        self.rowcount = 1
        params = params or ()
        if "INSERT INTO comments" in self.last_query:
            self.comment_inserts.append(params)
        elif "UPDATE incidents SET updated_at = NOW()" in self.last_query:
            self.incident_timestamp_updates += 1
        elif "UPDATE tickets SET updated_at = NOW()" in self.last_query:
            self.ticket_timestamp_updates += 1

    def fetchone(self):
        if "SELECT title FROM incidents" in self.last_query:
            return ("Mail outage",)
        if "SELECT title, severity" in self.last_query:
            return ("Mail outage", "SEV1")
        if "SELECT title FROM tickets" in self.last_query:
            return ("Cannot use mail",)
        if "SELECT message, created_at" in self.last_query:
            return ("We are restoring service.", "2026-06-11 18:00:00")
        return None

    def fetchall(self):
        if "SELECT ticket_id FROM incident_tickets" in self.last_query:
            return [(101,), (102,)]
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


def load_functions(*names):
    text = APP_CONFIG.read_text(encoding="utf-8")
    _, app_block = text.split(APP_MARKER, 1)
    app_source = "".join(
        line[4:] if line.startswith("    ") else line
        for line in app_block.splitlines(keepends=True)
    )
    tree = ast.parse(app_source)
    functions = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            node.decorator_list = []
            functions.append(node)
    assert {node.name for node in functions} == set(names)
    module = ast.Module(body=functions, type_ignores=[])
    ast.fix_missing_locations(module)
    return compile(module, "incident-flow-test.py", "exec")


def main():
    connections = []
    events = []
    notifications = []
    first_responses = []

    def get_conn():
        connection = Connection()
        connections.append(connection)
        return connection

    namespace = {
        "request": Request,
        "clean": lambda value: str(value or "").strip(),
        "get_conn": get_conn,
        "jsonify": lambda value: value,
        "add_ticket_event": lambda *args, **kwargs: None,
        "create_ticket_notifications": lambda cur, ticket_id, event_type, message, actor_email=None: notifications.append(
            (ticket_id, event_type)
        ),
        "mark_first_response_if_needed": lambda cur, ticket_id, user: first_responses.append(ticket_id),
        "log_audit": lambda *args, **kwargs: None,
        "publish_event": lambda *args, **kwargs: events.append((args, kwargs)),
    }
    exec(
        load_functions("api_add_incident_update", "api_link_incident_ticket"),
        namespace,
    )
    user = {"email": "operator@example.local", "name": "Operator"}

    Request.payload = {
        "message": "Service is returning.",
        "update_type": "mitigation",
        "is_public": True,
    }
    body, status = namespace["api_add_incident_update"](user, 7)
    update_cursor = connections[-1].cursor_value
    assert status == 201
    assert body["linked_ticket_count"] == 2
    assert body["public_comments_created"] == 2
    assert len(update_cursor.comment_inserts) == 2
    assert update_cursor.incident_timestamp_updates == 1
    assert update_cursor.ticket_timestamp_updates == 2
    assert events[-1][1]["ticket_ids"] == [101, 102]

    Request.payload = {"ticket_id": 103}
    body, status = namespace["api_link_incident_ticket"](user, 7)
    link_cursor = connections[-1].cursor_value
    assert status == 201
    assert body["public_comment_created"] is True
    assert len(link_cursor.comment_inserts) == 1
    assert link_cursor.comment_inserts[0][-1] == "public"
    assert "Ostatnia publiczna aktualizacja" in link_cursor.comment_inserts[0][-2]
    assert link_cursor.ticket_timestamp_updates == 1
    assert first_responses[-1] == 103
    assert notifications[-1] == (103, "incident_linked")
    assert events[-1][0][2] == 103

    print("Helpdesk incident flow checks passed")


if __name__ == "__main__":
    main()
