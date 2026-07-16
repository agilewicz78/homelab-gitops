#!/usr/bin/env node
"use strict";

const fs = require("fs");
const vm = require("vm");

const file = "applications/helpdesk/app-configmap.yaml";
const text = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const spaStart = text.indexOf("    SPA_HTML");
if (spaStart < 0) {
  throw new Error("SPA_HTML was not found");
}

const scriptMarker = "      <script>\n";
const scriptStart = text.indexOf(scriptMarker, spaStart);
const scriptEnd = text.indexOf("      </script>", scriptStart);
if (scriptStart < 0 || scriptEnd < 0) {
  throw new Error("Helpdesk SPA script block was not found");
}

const script = text
  .slice(scriptStart + scriptMarker.length, scriptEnd)
  .replaceAll("{{", "{")
  .replaceAll("}}", "}");

new vm.Script(script, { filename: "helpdesk-spa.js" });

const requiredFeedbackFlow = [
  'id="knowledgeFeedbackModal"',
  'id="knowledgeFeedbackForm"',
  'name="reason_code"',
  'name="reason_comment"',
  "openKnowledgeFeedbackModal()",
  "closeKnowledgeFeedbackModal()",
  "payload.reason_code",
  "payload.reason_comment",
];
for (const fragment of requiredFeedbackFlow) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing knowledge feedback UI fragment: ${fragment}`);
  }
}

const requiredWorkflowDiagram = [
  "workflowAutomationRuleDiagram(rule)",
  "workflowAutomationDiagramConditions(rule)",
  "workflowAutomationRuleDiagramCard(rule, idx)",
  "helpdesk_workflow_automation_view",
  "workflowAutomationListViewButton",
  "workflowAutomationDiagramViewButton",
  "Warunki: ORAZ",
  "Dodaj z szablonu",
  "preview.innerHTML = workflowAutomationRuleDiagram",
];
for (const fragment of requiredWorkflowDiagram) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing workflow diagram fragment: ${fragment}`);
  }
}

const requiredAutomationExplanation = [
  "const automationExecutions = canWorkTickets(me)",
  "Co zrobiły automatyzacje",
  "Panel pokazuje tylko reguły, które dopasowały się",
  "workflowRuleExecutionActionSummary(execution.actions_executed)",
  "workflowRuleExecutionActionDetails(execution.actions_executed)",
  "Dlaczego:",
  "Wykonane działania:",
];
for (const fragment of requiredAutomationExplanation) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing ticket automation explanation fragment: ${fragment}`);
  }
}

const requiredWorkflowSafety = [
  "workflowAutomationSafetyReport(rules)",
  "workflowAutomationConditionFingerprint(rule)",
  "workflowAutomationSafetyPanel(rules)",
  'id="workflowAutomationSafety"',
  "Kontrola bezpieczeństwa automatyzacji",
  "Utwórz kopię roboczą",
  "duplicateWorkflowAutomationRule(idx)",
  "copy.is_active = false",
  "Pozostaw wyłączone, aby zapisać bezpieczną wersję roboczą",
];
for (const fragment of requiredWorkflowSafety) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing workflow safety fragment: ${fragment}`);
  }
}

const requiredWorkflowWizard = [
  "workflow-wizard-steps",
  "workflowFormStageButton(1",
  "setWorkflowFormStage(stage, skipValidation = false)",
  "workflowFormInvalidField(stage)",
  "invalidField.reportValidity()",
  'id="workflowForm" novalidate',
  'data-workflow-stage="1"',
  'data-workflow-stage="2"',
  'data-workflow-stage="3"',
  'data-workflow-stage="4"',
  "Podstawowe informacje",
  "Statusy i kolejność obsługi",
  "Zespół odpowiedzialny za workflow",
  "Ustawienia zaawansowane",
  "Prosta lista",
  "Diagram techniczny",
  'id="workflowStageBack"',
  'id="workflowStageNext"',
  'id="workflowSaveButton"',
];
for (const fragment of requiredWorkflowWizard) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing workflow wizard fragment: ${fragment}`);
  }
}

const requiredAutomationRuleWizard = [
  "workflowAutomationRuleFormStage",
  "workflowAutomationRuleInvalidField(stage)",
  "setWorkflowAutomationRuleFormStage(stage, skipValidation = false)",
  "setWorkflowAutomationRuleFormStage(3, true)",
  "workflowAutomationRuleStageButton(1",
  'data-rule-stage="1"',
  'data-rule-stage="2"',
  'data-rule-stage="3"',
  'data-rule-stage="4"',
  "Nazwa i zdarzenie",
  "Kiedy dokładnie reguła ma zadziałać?",
  "Dodaj kolejny warunek",
  "Sposób dopasowania",
  "Test i aktywacja",
  "Aktywuj regułę po zapisaniu",
  'id="workflowRuleStageBack"',
  'id="workflowRuleStageNext"',
  'id="workflowRuleSaveButton"',
];
for (const fragment of requiredAutomationRuleWizard) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing automation rule wizard fragment: ${fragment}`);
  }
}

const requiredFriendlyConditionBuilder = [
  "workflowAutomationConditionDefinitions(opts)",
  "workflowAutomationActiveConditionKeys",
  "workflowAutomationConditionRow(definition, rule)",
  "renderWorkflowAutomationConditionBuilder()",
  "addWorkflowAutomationCondition()",
  "removeWorkflowAutomationCondition(key)",
  "handleWorkflowAutomationEventChange()",
  'id="workflowConditionAddSelect"',
  'id="workflowConditionSentencePreview"',
  "Dodaj kolejny warunek",
  "Reguła zadziała, jeżeli jednocześnie:",
  "Lista dostępnych warunków dopasowuje się automatycznie",
  "workflowAutomationScope()",
  'document.getElementById("workflowCategorySelect")',
  'document.getElementById("workflowSubcategorySelect")',
  "workflowAutomationScopeText()",
  "workflowAutomationSubcategoryValues(rule, workflow, scope)",
  "resetWorkflowAutomationInheritedCondition(form, definition)",
  "syncWorkflowAutomationSubcategoryOptions(form, opts)",
  "testCategoryOptions:",
  "testSubcategoryOptions:",
  "Zakres odziedziczony z workflow:",
  "Kategorii i podkategorii ustawionych w workflow nie trzeba wybierać ponownie.",
];
for (const fragment of requiredFriendlyConditionBuilder) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing friendly condition builder fragment: ${fragment}`);
  }
}

const requiredGroupedNavigation = [
  "function moduleAction",
  "function moduleCard",
  "function renderAppNavigation",
  "async function renderAdministration",
  "Moja praca",
  "Zgłoszenia",
  "Incydenty",
  "Baza wiedzy",
  "Raporty",
  "Administracja",
  "Centrum administracji",
  "Widoki są pogrupowane według pracy użytkownika, operatora i administracji.",
  "Konfiguracja systemu, workflow, automatyzacji, SLA i audytu jest oddzielona od codziennej obsługi zgłoszeń.",
];
for (const fragment of requiredGroupedNavigation) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing grouped navigation fragment: ${fragment}`);
  }
}

const requiredServiceCatalog = [
  "SERVICE_STATUSES",
  "SERVICE_CRITICALITIES",
  "DEFAULT_SERVICE_CATALOG",
  "CREATE TABLE IF NOT EXISTS service_catalog",
  "service_catalog.view",
  "service_catalog.manage",
  "seed_service_catalog(cur)",
  "fetch_service_catalog_rows",
  "/api/services",
  "/api/services/<int:service_id>/context",
  "/api/services/<int:service_id>/incident",
  "/api/admin/services",
  "async function renderAdminServices",
  "async function renderAdminServiceForm",
  "serviceCatalogMetrics",
  "serviceContextMetric",
  "serviceQualityPanel",
  "serviceQualityTrendBars",
  "serviceQualitySignal",
  "serviceContextRecommendation",
  "function createServiceIncident",
  "function serviceIncidentActionButton",
  "async function renderServiceContext",
  "serviceStatusBadge",
  "serviceCriticalityBadge",
  "Katalog usług IT",
  "Usługi IT",
  "Usługa IT",
  "Aktywne zgłoszenia usługi",
  "Aktywne incydenty usługi",
  "Rekomendacja operatora",
  "Historia i jakość usługi",
  "Trend zgłoszeń 14 dni",
  "Najczęstsze objawy",
  "Najbardziej dotknięte działy",
  "Utwórz incydent z usługi",
  "Do utworzenia incydentu potrzebne jest aktywne zgłoszenie tej usługi.",
  "Kontekst",
  "new-ticket-service",
  "newTicketServiceHint",
  "applySelectedServiceToNewTicket",
  "let pendingNewTicketServiceId",
  "function serviceStatusMessage",
  "function isProblematicService",
  "function openNewTicketForService",
  "function userPortalServiceStatusPanel",
  "function userPortalServiceStatusCard",
  "Status usług IT",
  "Ta usługa ma aktualnie status",
  "Problem może być już znany helpdeskowi",
  "service_id: formData.get(\"service_id\")",
  "Sprawdź status usługi IT",
];
for (const fragment of requiredServiceCatalog) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing service catalog fragment: ${fragment}`);
  }
}

const requiredAutomationCenter = [
  "/automation-center",
  "renderWorkflowAutomationCenter",
  "workflowAutomationCenterSampleValues",
  "workflowAutomationCenterRiskBadge",
  "workflowAutomationCenterStatusOptions",
  "workflowAutomationCenterSampleForm(data)",
  "workflowAutomationCenterDraftRule",
  "createWorkflowAutomationRuleFromCenterSample",
  "workflowAutomationCenterSummary(data)",
  "workflowAutomationCenterRuleCard(rule, idx)",
  "workflowAutomationCenterRecentExecutions(data)",
  'id="wacEventType"',
  'id="wacOperatorAddedComment"',
  'id="wacOperatorAddedAttachment"',
  "Centrum automatyzacji",
  "Utwórz regułę z tej symulacji",
  "Podsumowanie Centrum automatyzacji",
  "Co zrobi?",
];
for (const fragment of requiredAutomationCenter) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing automation center fragment: ${fragment}`);
  }
}

const requiredWorkflowHub = [
  "renderWorkflowManagement",
  "workflowAutomationCountSummary",
  "workflowManagementMetric",
  "workflowManagementCard",
  "Zarządzanie procesem",
  "Szybki przegląd",
  "Edytuj automatyzacje",
  "Otwórz Centrum",
  "Strefa ostrożna",
  "renderWorkflowManagement(${{w.id}})",
];
for (const fragment of requiredWorkflowHub) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing workflow hub fragment: ${fragment}`);
  }
}

const requiredAutomationStarterPacks = [
  "workflowAutomationStarterPacks",
  "workflowAutomationStarterPackCard",
  "applyWorkflowAutomationTemplatePack",
  "workflowAutomationStarterPackActivationPanel",
  "dismissWorkflowAutomationStarterPackActivation",
  "workflowAutomationLastStarterPack",
  "workflowAutomationCloneTemplateRule",
  "workflowAutomationUniqueRuleName",
  "Pakiety startowe",
  "Dodaj cały pakiet",
  "Bezpieczna aktywacja pakietu",
  "Testuj i aktywuj",
  "Przetestuj je przed aktywacją",
  "Codzienna obsługa zgłoszeń",
  "Kontrola jakości przed zmianą statusu",
  "Szybka ścieżka dla krytycznych zgłoszeń",
  "reguł dodanych jako wersje robocze",
];
for (const fragment of requiredAutomationStarterPacks) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing automation starter pack fragment: ${fragment}`);
  }
}

const requiredAutomationDashboard = [
  "renderWorkflowAutomationDashboard",
  "workflowAutomationDashboardMetric",
  "workflowAutomationDashboardRuleList",
  "workflowAutomationDashboardRecentList",
  "/automation-dashboard",
  "Dashboard automatyzacji",
  "Puls z ostatnich 7 dni",
  "Najaktywniejsze reguły",
  "Reguły bez aktywności",
  "Otwórz dashboard",
];
for (const fragment of requiredAutomationDashboard) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing automation dashboard fragment: ${fragment}`);
  }
}

const requiredOperatorCenter = [
  "renderStart",
  "renderAppSidebar",
  "renderWorkspaceShell",
  "renderWorkspaceView",
  "renderOperatorCenter",
  "operatorCenterMetric",
  "operatorCenterTicketSection",
  "operatorCenterIncidentList",
  "operatorCenterSuggestionList",
  "operatorCenterNotificationList",
  "operatorCenterOpenSuggestion",
  "/api/operator-center",
  "Centrum pracy operatora",
  "Centrum operatora",
  "operator-cockpit-shell",
  "operator-sidebar",
  "operator-board",
  'renderWorkspaceView(me, "incidents"',
  'renderWorkspaceView(me, "knowledge"',
  'renderWorkspaceView(me, "reports"',
  'renderWorkspaceView(me, "administration"',
  "Moje zgłoszenia",
  "Wraca do operatora",
  "Nowe nieprzypisane",
  "Pilne / po SLA",
  "Czekają na użytkownika",
  "Zgłoszenia bez odpowiedzi",
  "Ostatnie zdarzenia",
  "first_response",
  "workflow_rule_notification",
];
for (const fragment of requiredOperatorCenter) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing operator center fragment: ${fragment}`);
  }
}

const requiredResponsiveLayout = [
  "@media (max-width: 1100px)",
  "@media (max-width: 980px)",
  "@media (max-width: 860px)",
  "@media (max-width: 720px)",
  "@media (max-width: 560px)",
  ".page { width: 100%; max-width: none; margin: 0; padding: 42px clamp(16px, 2.2vw, 42px); }",
  ".page { padding: 30px 18px; }",
  ".page { padding: 20px 10px; }",
  "overflow-x: hidden",
  "overflow-x: auto",
  "-webkit-overflow-scrolling: touch",
  ".notification-panel {",
  "position: fixed",
  "operator-sidebar { grid-template-columns: 1fr; }",
  ".operator-command-row button",
  ".workflow-wizard-steps { grid-template-columns: 1fr; }",
];
for (const fragment of requiredResponsiveLayout) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing responsive layout fragment: ${fragment}`);
  }
}

const requiredUserPortal = [
  "renderUserPortal",
  "userPortalMetric",
  "userPortalTicketCard",
  "userPortalTicketStatusPanel",
  "userPortalNextStep",
  "resolutionFeedbackPanel",
  "submitResolutionFeedback",
  "/api/user-portal",
  "/resolution-feedback",
  "Portal użytkownika",
  "Co się teraz dzieje?",
  "Czy problem został rozwiązany?",
  "Tak, działa",
  "Nie, nadal mam problem",
  "Moje aktywne zgłoszenia",
  "Czekają na moją odpowiedź",
  "Polecane artykuły",
  "resolution_feedback_accepted",
  "resolution_feedback_rejected",
  "renderUserPortal(true)",
  "Widok odświeża się przez WebSocket",
];
for (const fragment of requiredUserPortal) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing user portal fragment: ${fragment}`);
  }
}

const requiredTicketAssistant = [
  "renderTicketContextPanel",
  "renderTicketAssistantPanel",
  "ticketContextSituationPanel",
  "ticketContextCurrentIncidentList",
  "ticketContextLinkedTicketList",
  "ticketContextQuickActions",
  "assignTicketToMe",
  "prepareRequestUserInfo",
  "focusTicketLinkForm",
  "focusTicketContextSection",
  "ticketRecommendationButton",
  "ticketRecommendationCard",
  "ticketOperatorRecommendations",
  "ticketAssistantDiagnosis",
  "ticketAssistantPriorityHint",
  "ticketAssistantWorkflowHint",
  "ticketAssistantArticleList",
  "ticketAssistantIncidentList",
  "ticketAssistantSimilarTicketList",
  "ticketContextPanelHtml",
  "Panel kontekstu zgłoszenia",
  "Etap 3: rekomendacje operatora, sytuacja, powiązania, podobne zgłoszenia i pasujące artykuły",
  "Sytuacja",
  "Szybkie akcje",
  "Rekomendacje operatora",
  "Prowadź komunikację przez incydent",
  "Podepnij do istniejącego incydentu",
  "Rozważ incydent zbiorczy",
  "Zareaguj priorytetowo",
  "Sprawdź artykuł bazy wiedzy",
  "Obsłuż standardowo",
  "Przypisz do mnie",
  "Poproś o informacje",
  "Dodaj powiązanie",
  "Podepnij do incydentu",
  "Utwórz artykuł KB",
  "Powiązany incydent",
  "Możliwe incydenty",
  "Powiązane zgłoszenia",
  "Krótka diagnoza",
  "Uzasadnienie rekomendacji",
  "Sugerowany priorytet",
  "Sugerowany workflow",
  "Podobne zgłoszenia",
  "ticketContextSimilarTickets",
  "ticketContextKnowledgeArticles",
  "Brak podobnych zgłoszeń od innych użytkowników.",
  "zgłaszający: ",
  "Artykuły bazy wiedzy",
  "currentIncidents: data.incidents || []",
  "linkedTickets: data.linked_tickets || []",
  "canCreateKnowledgeArticle: !!canCreateKnowledgeArticle",
  "currentUserEmail: me.email || \"\"",
  "currentUserCanBeAssigned",
];
for (const fragment of requiredTicketAssistant) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing ticket assistant fragment: ${fragment}`);
  }
}

const requiredIncidentCenterV2 = [
  "incidentCommandCenter",
  "incidentCommandMetric",
  "incidentTaskStatusLabel",
  "incidentTimelineTypeLabel",
  "incidentResolutionCheckPanel",
  "incidentUserStatusPanel",
  "incidentUserNextStep",
  "incidentUserActionHint",
  "incidentUserStatusValue",
  "incidentPublicUpdatesList",
  "incidentTaskList",
  "incidentTimelineList",
  "submitIncidentTask",
  "toggleIncidentTask",
  "deleteIncidentTask",
  "resolve_linked_tickets",
  "ticket_resolution_rejected",
  "user_status",
  "user_status_summary",
  "user_current_action",
  "next_update_hint",
  "resolved_linked_ticket_count",
  "/api/incidents/${{incidentId}}/tasks",
  "/api/incidents/${{incidentId}}/tasks/${{taskId}}/toggle",
  "Centrum dowodzenia",
  "Checklist działań",
  "Oś czasu incydentu",
  "Kontrola zamknięcia",
  "To zgłoszenie jest częścią incydentu.",
  "Co już wiemy",
  "Co robimy teraz",
  "Kolejna aktualizacja",
  "Czy musisz coś zrobić?",
  "Podgląd dla użytkownika",
  "Co dalej?",
  "Publiczne aktualizacje incydentu",
  "Ostatni komunikat Helpdesku",
  "Aktywne zgłoszenia przypisane do incydentu",
  "Oznacz aktywne zgłoszenia jako Rozwiązane",
  "requires_resolution_override",
  "resolution_override",
  "Zamknąć incydent mimo tych ostrzeżeń?",
  "Publiczne komunikaty",
  "Zadania:",
];
for (const fragment of requiredIncidentCenterV2) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing incident center v2 fragment: ${fragment}`);
  }
}

const requiredWorkflowChangeHistory = [
  "renderWorkflowChangeHistory",
  "workflowChangeHistoryLabel",
  "workflowChangeHistoryAutomationContext",
  "workflowChangeHistoryValue",
  "workflowChangeHistoryDetails",
  "/change-history",
  "Historia zmian workflow",
  "Historia zmian",
  "Co ustawiono",
  "Wartość początkowa",
  "Reguły automatyzacji",
  "Reguła automatyzacji:",
  "ID reguły:",
  "Poprzednia nazwa:",
  "Otwórz historię",
  "Kto, kiedy i co zmienił",
  "Utworzono regułę automatyzacji",
  "Zmieniono regułę automatyzacji",
  "Usunięto regułę automatyzacji",
];
for (const fragment of requiredWorkflowChangeHistory) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing workflow change history fragment: ${fragment}`);
  }
}

console.log("Helpdesk frontend syntax check passed");
