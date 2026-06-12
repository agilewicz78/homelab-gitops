#!/usr/bin/env python3
"""Static regression checks for Helpdesk database optimizations."""

from pathlib import Path


APP_CONFIG = Path("applications/helpdesk/app-configmap.yaml")
DEPLOYMENT = Path("applications/helpdesk/helpdesk-deployment.yaml")
APP_MARKER = "  app.py: |\n"


def section(text: str, start: str, end: str) -> str:
    start_index = text.index(start)
    end_index = text.index(end, start_index)
    return text[start_index:end_index]


def main() -> None:
    text = APP_CONFIG.read_text(encoding="utf-8")
    deployment_text = DEPLOYMENT.read_text(encoding="utf-8")
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
        "idx_workflow_rule_executions_created",
        "idx_workflow_rule_executions_workflow_id",
        "idx_workflow_rule_executions_ticket_id",
        "idx_workflow_rule_executions_automation_id",
        "idx_workflow_rule_executions_event_type",
        "idx_workflow_automations_event",
        "idx_workflow_automation_actions_lookup",
        "idx_ticket_status_history_resolution",
        "idx_audit_log_created",
        "idx_audit_log_action_created",
        "idx_audit_log_actor_created",
        "idx_incidents_status_updated",
        "idx_incidents_severity_updated",
        "idx_incident_tickets_ticket_id",
        "idx_incident_updates_incident_id",
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

    workflow_log_api = section(
        text,
        "    def api_admin_workflow_rule_executions(user):",
        "    @app.get(\"/api/workflow-rule-executions.csv\")",
    )
    workflow_log_csv_api = section(
        text,
        "    def api_admin_workflow_rule_executions_csv(user):",
        "    @app.get(\"/api/tickets\")",
    )
    for endpoint in (workflow_log_api, workflow_log_csv_api):
        assert "CREATE TABLE IF NOT EXISTS workflow_rule_executions" not in endpoint
        assert "ALTER TABLE workflow_rule_executions" not in endpoint
        assert "COALESCE(wre.event_type, '') = %s" not in endpoint
        assert "wre.event_type = %s" in endpoint

    websocket = section(
        text,
        "    def websocket(ws):",
        "    @app.get(\"/healthz\")",
    )
    assert "live_state_condition.wait(timeout=WS_HEARTBEAT_SECONDS)" in websocket
    assert "time.sleep(1)" not in websocket
    assert "live_state_condition.notify_all()" in text

    for table in ("incidents", "incident_tickets", "incident_updates"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in text
    assert "Uzupełnia komentarze dla publicznych aktualizacji" in text
    assert "JOIN incident_tickets it ON it.incident_id = iu.incident_id" in text
    assert "COALESCE(iu.is_public, FALSE) = TRUE" in text

    required_incident_routes = [
        '@app.get("/api/incidents")',
        '@app.post("/api/incidents")',
        '@app.get("/api/incidents/<int:incident_id>")',
        '@app.put("/api/incidents/<int:incident_id>")',
        '@app.post("/api/incidents/<int:incident_id>/updates")',
        '@app.post("/api/incidents/<int:incident_id>/tickets")',
        '@app.delete("/api/incidents/<int:incident_id>/tickets/<int:ticket_id>")',
    ]
    missing_routes = [route for route in required_incident_routes if route not in text]
    assert not missing_routes, f"Missing incident routes: {missing_routes}"

    incident_update_api = section(
        text,
        "    def api_add_incident_update(user, incident_id):",
        '    @app.post("/api/incidents/<int:incident_id>/tickets")',
    )
    public_comment_branch = section(
        incident_update_api,
        "            if is_public:",
        "            add_ticket_event(",
    )
    assert incident_update_api.count("INSERT INTO comments") == 1
    assert "INSERT INTO comments" in public_comment_branch
    assert '"public"' in public_comment_branch
    assert "mark_first_response_if_needed(cur, ticket_id, user)" in public_comment_branch
    assert "UPDATE tickets SET updated_at = NOW() WHERE id = %s" in public_comment_branch
    assert "public_comments_created" in incident_update_api
    assert "UPDATE incidents SET updated_at = NOW()" in incident_update_api
    assert "ticket_ids=ticket_ids if is_public else None" in incident_update_api

    incident_link_api = section(
        text,
        "    def api_link_incident_ticket(user, incident_id):",
        '    @app.delete("/api/incidents/<int:incident_id>/tickets/<int:ticket_id>")',
    )
    assert "INSERT INTO comments" in incident_link_api
    assert "Dalsze publiczne aktualizacje operatora" in incident_link_api
    assert "latest_public_update" in incident_link_api
    assert '"public_comment_created": True' in incident_link_api

    incident_create_api = section(
        text,
        "    def api_create_incident(user):",
        '    @app.get("/api/incidents/<int:incident_id>")',
    )
    assert 'raw_ticket_ids = payload.get("ticket_ids") or []' in incident_create_api
    assert "source_ticket_id not in ticket_ids" in incident_create_api
    assert "FROM ticket_links" in incident_create_api
    assert "INSERT INTO incident_tickets" in incident_create_api
    assert "INSERT INTO comments" in incident_create_api
    assert '"linked_ticket_count": len(ticket_ids)' in incident_create_api
    assert "ticket_ids=ticket_ids or None" in incident_create_api

    ticket_detail_api = section(
        text,
        "    def api_ticket_detail(user, ticket_id):",
        '    @app.post("/api/tickets/<int:ticket_id>/close")',
    )
    assert "LEFT JOIN LATERAL" in ticket_detail_api
    assert "latest_public_update" in ticket_detail_api
    assert '"linked_at": str(incident[8])' in ticket_detail_api
    assert "AS affected_ticket_count" in ticket_detail_api
    assert '"affected_ticket_count": int(incident[11] or 0)' in ticket_detail_api
    assert "def similarity_tokens(" in text
    assert "def similarity_score(" in text
    assert "LIMIT 150" in ticket_detail_api
    assert "LIMIT 75" in ticket_detail_api
    assert "tl.ticket_id = LEAST(t.id, %s)" in ticket_detail_api
    assert "linked.ticket_id = %s" in ticket_detail_api
    assert '"suggestions": suggestions' in ticket_detail_api

    assert "async function renderIncidents(" in text
    assert "async function renderIncident(" in text
    assert "Incident Command Center" in text
    assert 'name="is_public" checked' in text
    assert "Opublikuj w powiązanych zgłoszeniach" in text
    assert "Zaktualizowano ${{publicCommentCount}} z ${{reportedTicketCount}}" in text
    assert "Twoje zgłoszenie jest obsługiwane w ramach incydentu zbiorczego" in text
    assert "const incidentRelations = (data.incidents || []).length" in text
    assert "const directTicketRelations = (data.linked_tickets || []).length" in text
    assert "const relationCount = (data.incidents || []).length + (data.linked_tickets || []).length" in text
    assert "incident-relation ${{incidentSeverityClass(i.severity)}}" in text
    assert "function incidentTicketCountLabel(count)" in text
    assert "incidentTicketCountLabel(i.affected_ticket_count)" in text
    assert "Ze względów prywatności widzisz liczbę zgłoszeń objętych incydentem" in text
    assert "affectedTicketIds.includes(Number(currentView.ticketId))" in text
    assert "Sugestie podobnych spraw" in text
    assert "Sugestia nie tworzy powiązania automatycznie" in text
    assert "async function linkSuggestedTicket(" in text
    assert "async function linkSuggestedIncident(" in text
    assert "Utwórz incydent z powiązanych zgłoszeń" in text
    assert "function openIncidentFromTicketsModal()" in text
    assert "const incidentFromTicketsForm" in text
    assert "payload.source_ticket_id = incidentCreationContext.sourceTicketId" in text
    assert "payload.ticket_ids = ticketIds" in text
    assert '"incidents": incidents' in text
    assert "helpdesk.incoprp.local/app-config-revision:" in deployment_text

    print("Helpdesk database optimization checks passed")


if __name__ == "__main__":
    main()
