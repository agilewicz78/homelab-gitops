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
  "Szablony automatyzacji",
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
  "Wyłączona reguła jest wersją roboczą",
];
for (const fragment of requiredWorkflowSafety) {
  if (!text.includes(fragment)) {
    throw new Error(`Missing workflow safety fragment: ${fragment}`);
  }
}

console.log("Helpdesk frontend syntax check passed");
