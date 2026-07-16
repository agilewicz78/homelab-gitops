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
        "idx_tickets_resolution_feedback_at",
        "idx_audit_log_created",
        "idx_audit_log_action_created",
        "idx_audit_log_actor_created",
        "idx_incidents_status_updated",
        "idx_incidents_severity_updated",
        "idx_incident_tickets_ticket_id",
        "idx_incident_updates_incident_id",
        "idx_incident_tasks_incident_id",
        "idx_incident_tasks_owner_status",
        "idx_knowledge_articles_status_updated",
        "idx_knowledge_articles_category",
        "idx_knowledge_feedback_article_helpful",
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

    for table in ("incidents", "incident_tickets", "incident_updates", "incident_tasks"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in text
    assert "CREATE TABLE IF NOT EXISTS knowledge_articles" in text
    assert "CREATE TABLE IF NOT EXISTS knowledge_article_feedback" in text
    assert "ALTER TABLE knowledge_article_feedback ADD COLUMN IF NOT EXISTS reason_code TEXT" in text
    assert "ALTER TABLE knowledge_article_feedback ADD COLUMN IF NOT EXISTS reason_comment TEXT" in text
    assert "Uzupełnia komentarze dla publicznych aktualizacji" in text
    assert "JOIN incident_tickets it ON it.incident_id = iu.incident_id" in text
    assert "COALESCE(iu.is_public, FALSE) = TRUE" in text

    required_incident_routes = [
        '@app.get("/api/incidents")',
        '@app.post("/api/incidents")',
        '@app.get("/api/incidents/<int:incident_id>")',
        '@app.put("/api/incidents/<int:incident_id>")',
        '@app.post("/api/incidents/<int:incident_id>/updates")',
        '@app.post("/api/incidents/<int:incident_id>/tasks")',
        '@app.post("/api/incidents/<int:incident_id>/tasks/<int:task_id>/toggle")',
        '@app.delete("/api/incidents/<int:incident_id>/tasks/<int:task_id>")',
        '@app.post("/api/incidents/<int:incident_id>/tickets")',
        '@app.delete("/api/incidents/<int:incident_id>/tickets/<int:ticket_id>")',
    ]
    missing_routes = [route for route in required_incident_routes if route not in text]
    assert not missing_routes, f"Missing incident routes: {missing_routes}"

    required_knowledge_routes = [
        '@app.get("/api/knowledge-articles")',
        '@app.get("/api/knowledge-articles/<int:article_id>")',
        '@app.get("/api/knowledge-suggestions")',
        '@app.post("/api/knowledge-articles/<int:article_id>/feedback")',
        '@app.post("/api/knowledge-articles")',
        '@app.put("/api/knowledge-articles/<int:article_id>")',
    ]
    missing_routes = [route for route in required_knowledge_routes if route not in text]
    assert not missing_routes, f"Missing knowledge base routes: {missing_routes}"

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
    assert "incident_public_updates = {}" in ticket_detail_api
    assert "ROW_NUMBER() OVER" in ticket_detail_api
    assert "WHERE rn <= 5" in ticket_detail_api
    assert '"linked_at": str(incident[8])' in ticket_detail_api
    assert "AS affected_ticket_count" in ticket_detail_api
    assert '"affected_ticket_count": int(incident[11] or 0)' in ticket_detail_api
    assert '"public_updates": incident_public_updates.get(incident[0], [])' in ticket_detail_api
    assert "def similarity_tokens(" in text
    assert "def similarity_score(" in text
    assert "LIMIT 150" in ticket_detail_api
    assert "LIMIT 75" in ticket_detail_api
    assert "tl.ticket_id = LEAST(t.id, %s)" in ticket_detail_api
    assert "linked.ticket_id = %s" in ticket_detail_api
    assert '"suggestions": suggestions' in ticket_detail_api
    assert '"knowledge_article": knowledge_article' in ticket_detail_api
    assert '"articles": []' in ticket_detail_api
    assert "knowledge_article_row[2] != \"published\"" in ticket_detail_api
    assert "FROM knowledge_articles" in ticket_detail_api
    assert "COALESCE(t.resolution_feedback_decision, '') AS resolution_feedback_decision" in ticket_detail_api
    assert "COALESCE(t.resolution_feedback_comment, '') AS resolution_feedback_comment" in ticket_detail_api
    assert "COALESCE(t.resolution_feedback_by_email, '') AS resolution_feedback_by_email" in ticket_detail_api
    assert "COALESCE(t.resolution_feedback_by_name, '') AS resolution_feedback_by_name" in ticket_detail_api
    assert "t.resolution_feedback_at" in ticket_detail_api
    assert '"resolution_feedback_decision": row[24] or ""' in ticket_detail_api
    assert "automation_execution_rows = []" in ticket_detail_api
    assert "if is_staff(user):" in ticket_detail_api
    assert "FROM workflow_rule_executions wre" in ticket_detail_api
    assert "AND COALESCE(wre.matched, TRUE) = TRUE" in ticket_detail_api
    assert "LIMIT 20" in ticket_detail_api
    assert '"automation_executions": automation_executions' in ticket_detail_api

    assert "async function renderIncidents(" in text
    assert "async function renderIncident(" in text
    assert "Incident Command Center" in text
    assert "Centrum dowodzenia" in text
    assert "Checklist działań" in text
    assert "incidentCommandCenter" in text
    assert "incidentResolutionCheckPanel" in text
    assert "incidentUserStatusPanel" in text
    assert "incidentUserNextStep" in text
    assert "incidentUserActionHint" in text
    assert "incidentUserStatusValue" in text
    assert "incidentPublicUpdatesList" in text
    assert "incidentTaskList" in text
    assert "incidentTimelineList" in text
    assert "submitIncidentTask" in text
    assert "toggleIncidentTask" in text
    assert "deleteIncidentTask" in text
    assert '"tasks": tasks' in text
    assert '"task_summary": task_summary' in text
    assert '"timeline": timeline' in text
    assert '"resolution_check": resolution_check' in text
    assert "def incident_resolution_check(cur, incident_id):" in text
    assert "requires_resolution_override" in text
    assert "resolution_override = bool(payload.get(\"resolution_override\"))" in text
    assert "resolve_linked_tickets = bool(payload.get(\"resolve_linked_tickets\"))" in text
    assert "def resolve_incident_active_tickets(cur, incident_id, incident_title, user):" in text
    assert "def reopen_resolved_incidents_for_ticket(cur, ticket_id, ticket_title, user):" in text
    assert "ALTER TABLE incidents ADD COLUMN IF NOT EXISTS user_status_summary TEXT" in text
    assert "ALTER TABLE incidents ADD COLUMN IF NOT EXISTS user_current_action TEXT" in text
    assert "ALTER TABLE incidents ADD COLUMN IF NOT EXISTS next_update_hint TEXT" in text
    assert "user_status_summary = clean(payload.get(\"user_status_summary\"))" in text
    assert "user_current_action = clean(payload.get(\"user_current_action\"))" in text
    assert "next_update_hint = clean(payload.get(\"next_update_hint\"))" in text
    assert '"user_status_summary": row[12]' in text
    assert '"active_tickets": active_tickets' in text
    assert '"resolved_linked_ticket_count": len(resolved_linked_ticket_ids)' in text
    assert "Kontrola zamknięcia" in text
    assert "To zgłoszenie jest częścią incydentu." in text
    assert "Co dalej?" in text
    assert "Publiczne aktualizacje incydentu" in text
    assert "Ostatni komunikat Helpdesku" in text
    assert "Aktywne zgłoszenia przypisane do incydentu" in text
    assert "Oznacz aktywne zgłoszenia jako Rozwiązane" in text
    assert "Status dla użytkowników" in text
    assert "Co już wiemy" in text
    assert "Co robimy teraz" in text
    assert "Kolejna aktualizacja" in text
    assert "Czy musisz coś zrobić?" in text
    assert "Podgląd dla użytkownika" in text
    assert "linked_tickets_resolved: \"Rozwiązano powiązane zgłoszenia\"" in text
    assert "ticket_resolution_rejected: \"Odrzucono rozwiązanie zgłoszenia\"" in text
    assert "user_status: \"Status dla użytkowników\"" in text
    assert "resolution_check: \"Kontrola zamknięcia\"" in text
    assert "Zamknąć incydent mimo tych ostrzeżeń?" in text
    assert "COUNT(DISTINCT task.id) AS task_count" in text
    assert "LEFT JOIN incident_tasks task ON task.incident_id = i.id" in text
    assert 'name="is_public" checked' in text
    assert "Opublikuj w powiązanych zgłoszeniach" in text
    assert "Zaktualizowano ${{publicCommentCount}} z ${{reportedTicketCount}}" in text
    assert "To zgłoszenie jest częścią incydentu." in text
    assert "const incidentRelations = (data.incidents || []).length" in text
    assert "const directTicketRelations = (data.linked_tickets || []).length" in text
    assert "const relationCount = (data.incidents || []).length + (data.linked_tickets || []).length" in text
    assert "incident-relation ${{incidentSeverityClass(i.severity)}}" in text
    assert "function incidentTicketCountLabel(count)" in text
    assert "incidentTicketCountLabel(i.affected_ticket_count)" in text
    assert "Ze względów prywatności widzisz liczbę zgłoszeń objętych incydentem" in text
    assert "affectedTicketIds.includes(Number(currentView.ticketId))" in text
    assert "function renderTicketAssistantPanel" in text
    assert "function ticketAssistantDiagnosis" in text
    assert "function ticketAssistantPriorityHint" in text
    assert "function ticketAssistantWorkflowHint" in text
    assert "function renderTicketContextPanel" in text
    assert "function ticketContextQuickActions" in text
    assert "function ticketRecommendationButton" in text
    assert "function ticketRecommendationCard" in text
    assert "function ticketOperatorRecommendations" in text
    assert "async function assignTicketToMe" in text
    assert "function prepareRequestUserInfo" in text
    assert "function focusTicketLinkForm" in text
    assert "function focusTicketContextSection" in text
    assert "Panel kontekstu zgłoszenia" in text
    assert "Etap 3: rekomendacje operatora" in text
    assert "Sytuacja" in text
    assert "Szybkie akcje" in text
    assert "Rekomendacje operatora" in text
    assert "Prowadź komunikację przez incydent" in text
    assert "Podepnij do istniejącego incydentu" in text
    assert "Rozważ incydent zbiorczy" in text
    assert "Zareaguj priorytetowo" in text
    assert "Sprawdź artykuł bazy wiedzy" in text
    assert "Obsłuż standardowo" in text
    assert "Przypisz do mnie" in text
    assert "Poproś o informacje" in text
    assert "Dodaj powiązanie" in text
    assert "Podepnij do incydentu" in text
    assert "Utwórz artykuł KB" in text
    assert "Uzasadnienie rekomendacji" in text
    assert "ticketContextSimilarTickets" in text
    assert "ticketContextKnowledgeArticles" in text
    assert "Powiązany incydent" in text
    assert "Możliwe incydenty" in text
    assert "Powiązane zgłoszenia" in text
    assert "Brak podobnych zgłoszeń od innych użytkowników." in text
    assert "zgłaszający: " in text
    assert "lower(COALESCE(t.requester_email, '')) <> lower(COALESCE(%s, ''))" in text
    assert "source_tokens = similarity_tokens(row[1], row[2], row[6])" in text
    assert "similarity_tokens(candidate[1], candidate[2], candidate[3])" in text
    assert '"requester_name": candidate[8] or ""' in text
    assert "Krótka diagnoza" in text
    assert "Sugerowany priorytet" in text
    assert "Sugerowany workflow" in text
    assert "Artykuły bazy wiedzy" in text
    assert "async function linkSuggestedTicket(" in text
    assert "async function linkSuggestedIncident(" in text
    assert "Utwórz incydent z powiązanych zgłoszeń" in text
    assert "function openIncidentFromTicketsModal()" in text
    assert "const incidentFromTicketsForm" in text
    assert "payload.source_ticket_id = incidentCreationContext.sourceTicketId" in text
    assert "payload.ticket_ids = ticketIds" in text
    assert '"incidents": incidents' in text
    assert "async function renderKnowledgeArticles()" in text
    assert "async function renderKnowledgeArticle(articleId)" in text
    assert "const knowledgeArticleForm" in text
    assert "Utwórz artykuł z rozwiązania" in text
    assert "To starsze zgłoszenie nie ma opisu rozwiązania" in text
    assert 'source_ticket[4] != "Zamknięte"' in text
    assert 'source_ticket[4] != "Zamknięte" or not clean(source_ticket[5])' not in text
    assert "Możliwe rozwiązania przed utworzeniem zgłoszenia" in text
    assert "scheduleNewTicketKnowledgeSuggestions" in text
    assert "loadNewTicketKnowledgeSuggestions" in text
    assert "Czy ten artykuł pomógł?" in text
    assert "submitKnowledgeFeedback" in text
    assert "knowledge_article_feedback" in text
    assert "BOOL_OR(helpful) FILTER" in text
    assert "knowledgeQualityFilter" in text
    assert "Wymaga poprawy" in text
    assert "COALESCE(feedback.not_helpful_count, 0) > 0" in text
    assert '"quality_filters": ["needs_review", "unrated"]' in text
    assert "knowledgeFeedbackModal" in text
    assert "Dlaczego artykuł nie pomógł?" in text
    assert "KNOWLEDGE_FEEDBACK_REASONS" in text
    assert "reason_code = EXCLUDED.reason_code" in text
    assert "reason_comment = EXCLUDED.reason_comment" in text
    assert "function workflowAutomationRuleDiagram(rule)" in text
    assert "function workflowAutomationDiagramConditions(rule)" in text
    assert "helpdesk_workflow_automation_view" in text
    assert "Diagram techniczny" in text
    assert "Dodaj z szablonu" in text
    assert "Warunki: ORAZ" in text
    assert "preview.innerHTML = workflowAutomationRuleDiagram" in text
    assert "const automationExecutions = canWorkTickets(me)" in text
    assert "Co zrobiły automatyzacje" in text
    assert "Wykonane działania:" in text
    assert 'reason = f"{match_reason}; {execution_result}"' in text
    assert "function workflowAutomationSafetyReport(rules)" in text
    assert "function workflowAutomationConditionFingerprint(rule)" in text
    assert "Kontrola bezpieczeństwa automatyzacji" in text
    assert "Późniejsza reguła jest zasłonięta" in text
    assert "Sprzeczna zmiana statusu" in text
    assert "function duplicateWorkflowAutomationRule(idx)" in text
    assert "copy.is_active = false" in text
    assert "Pozostaw wyłączone, aby zapisać bezpieczną wersję roboczą" in text
    assert "function setWorkflowFormStage(stage, skipValidation = false)" in text
    assert "function workflowFormInvalidField(stage)" in text
    assert "invalidField.reportValidity()" in text
    assert "workflow-wizard-steps" in text
    assert 'data-workflow-stage="1"' in text
    assert 'data-workflow-stage="4"' in text
    assert "Podstawowe informacje" in text
    assert "Statusy i kolejność obsługi" in text
    assert "Zespół odpowiedzialny za workflow" in text
    assert "Diagram techniczny" in text
    assert "function setWorkflowAutomationRuleFormStage(stage, skipValidation = false)" in text
    assert "function workflowAutomationRuleInvalidField(stage)" in text
    assert 'data-rule-stage="1"' in text
    assert 'data-rule-stage="4"' in text
    assert "Kiedy dokładnie reguła ma zadziałać?" in text
    assert "Sposób dopasowania" in text
    assert "Test i aktywacja" in text
    assert "Aktywuj regułę po zapisaniu" in text
    assert "function workflowAutomationConditionDefinitions(opts)" in text
    assert "function renderWorkflowAutomationConditionBuilder()" in text
    assert "function addWorkflowAutomationCondition()" in text
    assert "function removeWorkflowAutomationCondition(key)" in text
    assert "function handleWorkflowAutomationEventChange()" in text
    assert "Reguła zadziała, jeżeli jednocześnie:" in text
    assert "Dodaj kolejny warunek" in text
    assert "function workflowAutomationScope()" in text
    assert 'const categoryField = document.getElementById("workflowCategorySelect")' in text
    assert 'const subcategoryField = document.getElementById("workflowSubcategorySelect")' in text
    assert "categoryField?.value || workflow.category" in text
    assert "subcategoryField?.value || workflow.subcategory" in text
    assert "workflowAutomationEditorWorkflow.category = e.target.value" in text
    assert "workflowAutomationEditorWorkflow.subcategory = e.target.value" in text
    assert "condition_category: rule.condition_category ||" in text
    assert "condition_subcategory: rule.condition_subcategory ||" in text
    assert "function workflowAutomationSubcategoryValues(rule, workflow, scope)" in text
    assert "scopeLocked: opts.scope.category" in text
    assert "scopeLocked: opts.scope.subcategory" in text
    assert 'def normalize_workflow_automations(payload, steps, workflow_category="*", workflow_subcategory="*")' in text
    assert "workflow_category=workflow_row[2]" in text
    assert "workflow_subcategory=workflow_row[3]" in text
    assert 'if workflow_category != "*":' in text
    assert 'if workflow_subcategory != "*":' in text
    assert "UPDATE workflow_automations wa" in text
    assert "AND wd.category <> '*'" in text
    assert "AND wd.subcategory <> '*'" in text
    assert "Zakres odziedziczony z workflow:" in text
    assert "Kategorii i podkategorii ustawionych w workflow nie trzeba wybierać ponownie." in text
    assert '"knowledge_article_changed"' in text
    assert "helpdesk.incoprp.local/app-config-revision:" in deployment_text
    assert "/automation-dashboard" in text
    assert "api_admin_workflow_automation_dashboard" in text
    assert "/change-history" in text
    assert "api_admin_workflow_change_history" in text
    assert "workflow_audit_changes" in text
    assert "workflow_audit_labels" in text
    assert "workflow_automation_audit_snapshot" in text
    assert '"automation_id": automation_id' in text
    assert '"automation_name": item.get("name")' in text
    assert "workflowChangeHistoryAutomationContext" in text
    assert '"after": after_snapshot' in text
    assert "workflow_audit_changes({}, after_snapshot, workflow_audit_labels())" in text
    assert "/api/operator-center" in text
    assert "def api_operator_center" in text
    assert "operatorCenterTicketSection" in text
    assert "function renderStart" in text
    assert "function renderAppSidebar" in text
    assert "function renderWorkspaceShell" in text
    assert "function renderWorkspaceView" in text
    assert "operator-cockpit-shell" in text
    assert "operator-board" in text
    assert 'renderWorkspaceView(me, "incidents"' in text
    assert 'renderWorkspaceView(me, "knowledge"' in text
    assert 'renderWorkspaceView(me, "reports"' in text
    assert 'renderWorkspaceView(me, "administration"' in text
    assert "${{renderAppNavigation" + '(me, "administration")}}' not in text
    assert "Moje zgłoszenia" in text
    assert "Pilne / po SLA" in text
    assert "Czekają na użytkownika" in text
    assert "Zgłoszenia bez odpowiedzi" in text
    assert "Ostatnie zdarzenia" in text
    assert "first_response_filter" in text
    assert "first_response_options" in text
    assert "@media (max-width: 1100px)" in text
    assert "@media (max-width: 560px)" in text
    assert ".page { width: 100%; max-width: none; margin: 0; padding: 42px clamp(16px, 2.2vw, 42px); }" in text
    assert ".page { padding: 30px 18px; }" in text
    assert ".page { padding: 20px 10px; }" in text
    assert "overflow-x: auto" in text
    assert "-webkit-overflow-scrolling: touch" in text
    assert ".operator-command-row button" in text
    assert ".workflow-wizard-steps { grid-template-columns: 1fr; }" in text
    assert "currentView.name === \"operator-center\"" in text
    assert "/api/user-portal" in text
    assert "def api_user_portal" in text
    assert "visible_ticket_sql" in text
    assert text.count("t.updated_at DESC,\n                  t.created_at DESC,\n                  t.id DESC") >= 2
    assert "function renderUserPortal" in text
    assert "function userPortalTicketStatusPanel" in text
    assert "function resolutionFeedbackPanel" in text
    assert "async function submitResolutionFeedback" in text
    assert "function renderTicketContextPanel" in text
    assert "function ticketContextSituationPanel" in text
    assert "function ticketContextCurrentIncidentList" in text
    assert "function ticketContextLinkedTicketList" in text
    assert "function ticketContextQuickActions" in text
    assert "function ticketOperatorRecommendations" in text
    assert "Panel kontekstu zgłoszenia" in text
    assert "Rekomendacje operatora" in text
    assert "Powiązany incydent" in text
    assert "Możliwe incydenty" in text
    assert "Powiązane zgłoszenia" in text
    assert "Uzasadnienie rekomendacji" in text
    assert "ticketContextSimilarTickets" in text
    assert "ticketContextKnowledgeArticles" in text
    assert "ticketContextPanelHtml" in text
    assert "currentIncidents: data.incidents || []" in text
    assert "linkedTickets: data.linked_tickets || []" in text
    assert "canCreateKnowledgeArticle: !!canCreateKnowledgeArticle" in text
    assert "currentUserEmail: me.email || \"\"" in text
    assert "currentUserCanBeAssigned" in text
    assert '@app.post("/api/tickets/<int:ticket_id>/resolution-feedback")' in text
    assert "def api_ticket_resolution_feedback" in text
    assert "resolution_feedback_reopen_status_for_workflow" in text
    assert "reopen_resolved_incidents_for_ticket" in text
    assert '"reopened_incident_ids": reopened_incident_ids' in text
    assert "ticket_resolution_rejected" in text
    assert "Incydent cofnięto do monitorowania" in text
    assert "user_resolution_feedback" in text
    assert "resolution_feedback_accepted" in text
    assert "resolution_feedback_rejected" in text
    assert "currentView.name === \"user-portal\"" in text
    assert "Co się teraz dzieje?" in text
    assert "loadNotifications()" in text
    assert "function renderAppNavigation" in text
    assert "function moduleCard" in text
    assert "function moduleAction" in text
    assert "async function renderAdministration" in text
    assert "module-nav" in text
    assert "Centrum administracji" in text
    assert "Widoki są pogrupowane według pracy użytkownika, operatora i administracji." in text
    assert "Konfiguracja systemu, workflow, automatyzacji, SLA i audytu jest oddzielona od codziennej obsługi zgłoszeń." in text
    assert "SERVICE_STATUSES" in text
    assert "SERVICE_CRITICALITIES" in text
    assert "DEFAULT_SERVICE_CATALOG" in text
    assert "CREATE TABLE IF NOT EXISTS service_catalog" in text
    assert "ALTER TABLE tickets" in text and "service_id INTEGER REFERENCES service_catalog" in text
    assert "service_catalog.view" in text
    assert "service_catalog.manage" in text
    assert "def seed_service_catalog(cur)" in text
    assert "def fetch_service_catalog_rows(cur" in text
    assert '@app.get("/api/services")' in text
    assert '@app.get("/api/services/<int:service_id>/context")' in text
    assert "def api_service_context(user, service_id)" in text
    assert '@app.post("/api/services/<int:service_id>/incident")' in text
    assert "def api_create_service_incident(user, service_id)" in text
    assert "def service_incident_default_severity(service, ticket_rows)" in text
    assert '@app.get("/api/admin/services")' in text
    assert '@app.post("/api/admin/services")' in text
    assert '@app.put("/api/admin/services/<int:service_id>")' in text
    assert "async function renderAdminServices" in text
    assert "async function renderAdminServiceForm" in text
    assert "function serviceCatalogMetrics" in text
    assert "function serviceContextMetric" in text
    assert "function serviceContextRecommendation" in text
    assert "function createServiceIncident" in text
    assert "async function renderServiceContext" in text
    assert "function applySelectedServiceToNewTicket" in text
    assert "let pendingNewTicketServiceId" in text
    assert "function serviceStatusMessage" in text
    assert "function isProblematicService" in text
    assert "function openNewTicketForService" in text
    assert "function userPortalServiceStatusPanel" in text
    assert "function userPortalServiceStatusCard" in text
    assert "Katalog usług IT" in text
    assert "Status usług IT" in text
    assert "Usługa IT" in text
    assert "Aktywne zgłoszenia usługi" in text
    assert "Aktywne incydenty usługi" in text
    assert "Rekomendacja operatora" in text
    assert "Utwórz incydent z usługi" in text
    assert "incident_created_from_service" in text
    assert "Kontekst" in text
    assert "new-ticket-service" in text
    assert "newTicketServiceHint" in text
    assert '"services": services' in text
    assert '"service": {' in text
    assert '"id": row[28]' in text
    assert '"name": row[29] or ""' in text
    assert '"status": row[30] or "operational"' in text
    assert '"status": row[31] or "operational"' not in text
    assert "Sprawdź status usługi IT" in text
    assert "Ta usługa ma aktualnie status" in text
    assert "Problem może być już znany helpdeskowi" in text
    assert "2026-07-16-service-incident-v1" in deployment_text

    print("Helpdesk database optimization checks passed")


if __name__ == "__main__":
    main()
