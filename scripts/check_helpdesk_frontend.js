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

console.log("Helpdesk frontend syntax check passed");
