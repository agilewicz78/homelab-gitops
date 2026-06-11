#!/usr/bin/env python3
"""Static regression checks for Helpdesk database optimizations."""

from pathlib import Path


APP_CONFIG = Path("applications/helpdesk/app-configmap.yaml")
APP_MARKER = "  app.py: |\n"


def section(text: str, start: str, end: str) -> str:
    start_index = text.index(start)
    end_index = text.index(end, start_index)
    return text[start_index:end_index]


def main() -> None:
    text = APP_CONFIG.read_text(encoding="utf-8")
    _, app_block = text.split(APP_MARKER, 1)
    app_lines = app_block.splitlines(keepends=True)
    invalid_lines = [
        line_number
        for line_number, line in enumerate(app_lines, start=1)
        if line.strip() and not line.startswith("    ")
    ]
    assert not invalid_lines, (
        f"Embedded app.py escaped the YAML block at lines: {invalid_lines[:5]}"
    )
    app_source = "".join(
        line[4:] if line.startswith("    ") else line
        for line in app_lines
    )
    compile(app_source, "embedded-app.py", "exec")

    permission_loader = section(
        text,
        "    def role_permission_codes_by_role():",
        "    def role_direct_permission_codes(role_key):",
    )
    assert "ensure_role_permissions_schema" not in permission_loader
    assert "ROLE_PERMISSION_CACHE_TTL_SECONDS" in text
    assert 'permissions = user.get("permissions")' in text
    assert "last_seen < NOW() - INTERVAL '60 seconds'" in text

    required_indexes = [
        "idx_tickets_created_at",
        "idx_tickets_updated_at",
        "idx_tickets_status",
        "idx_tickets_sla_due_at",
        "idx_comments_ticket_id_id",
        "idx_ticket_events_ticket_id_id",
        "idx_ticket_status_history_ticket_id_id",
        "idx_attachments_ticket_id_id",
        "idx_ticket_watchers_ticket_email_lower",
        "idx_notifications_user_created",
    ]
    missing_indexes = [name for name in required_indexes if name not in text]
    assert not missing_indexes, f"Missing Helpdesk indexes: {missing_indexes}"

    ticket_list = section(
        text,
        "    def api_tickets(user):",
        "    # Dane dashboardu",
    )
    assert "t.created_at::date" not in ticket_list
    assert "t.updated_at::date" not in ticket_list
    assert "t.created_at >= %s::date" in ticket_list
    assert "t.created_at < (%s::date + INTERVAL '1 day')" in ticket_list

    print("Helpdesk database optimization checks passed")


if __name__ == "__main__":
    main()
