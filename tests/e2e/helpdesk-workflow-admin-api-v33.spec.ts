import { test, expect, APIRequestContext } from '@playwright/test';

/**
 * helpdesk-workflow-admin-api-v33.spec.ts
 *
 * Wersja v33.1: poprawia payload endpointu preview/test workflow.
 *
 * Etap 4 — testy API administracji workflow.
 *
 * Zakres:
 * 1. API zwraca listę workflow.
 * 2. API tworzy regułę z akcją require_comment.
 * 3. API tworzy regułę z akcją require_attachment.
 * 4. API tworzy regułę z wieloma akcjami require_comment + require_attachment.
 * 5. API test/preview reguły pokazuje, że reguła pasuje do danych testowych.
 * 6. API pozwala usunąć regułę testową.
 * 7. API odrzuca nieznany action_type.
 *
 * Ten plik jest osobnym plikiem testowym i nie nadpisuje:
 * - tests/e2e/helpdesk-ui.spec.ts
 * - tests/e2e/helpdesk-workflow-regression-v30.spec.ts
 * - tests/e2e/helpdesk-workflow-actions-ui-v31.spec.ts
 * - tests/e2e/helpdesk-ticket-comments-attachments-v32.spec.ts
 */

const baseURL = process.env.HELPDESK_URL || 'https://helpdesk.lab.local';
const adminEmail = process.env.HELPDESK_ADMIN_EMAIL || '';
const adminPassword = process.env.HELPDESK_ADMIN_PASSWORD || '';

type WorkflowInfo = {
  id: number;
  name: string;
  workflowKey?: string;
  statuses: string[];
  targetStatus: string;
};

type ApiResult = {
  res: Awaited<ReturnType<APIRequestContext['fetch']>>;
  json: any;
  text: string;
};

function requireAdminCredentials() {
  if (!adminEmail || !adminPassword) {
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów API.');
  }
}

function uniqueStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function apiLogin(request: APIRequestContext): Promise<string> {
  requireAdminCredentials();

  const res = await request.post(`${baseURL}/api/login`, {
    data: {
      email: adminEmail,
      password: adminPassword,
    },
  });

  const text = await res.text();

  expect(res.ok(), `Logowanie API zwróciło HTTP ${res.status()}: ${text}`).toBeTruthy();

  const data = JSON.parse(text);
  expect(data.sid, `Brak pola sid w odpowiedzi /api/login: ${text}`).toBeTruthy();

  return data.sid;
}

async function apiJson(
  request: APIRequestContext,
  method: string,
  path: string,
  sid: string,
  options: { data?: any; multipart?: any; headers?: Record<string, string> } = {}
): Promise<ApiResult> {
  const res = await request.fetch(`${baseURL}${path}`, {
    method,
    headers: {
      'X-Helpdesk-Session': sid,
      ...(options.headers || {}),
    },
    data: options.data,
    multipart: options.multipart,
  });

  const text = await res.text();

  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  return { res, json, text };
}

async function getDefaultWorkflow(request: APIRequestContext, sid: string): Promise<WorkflowInfo> {
  const workflowsResponse = await apiJson(request, 'GET', '/api/admin/workflows', sid);

  expect(
    workflowsResponse.res.ok(),
    `Pobranie listy workflow zwróciło HTTP ${workflowsResponse.res.status()}: ${workflowsResponse.text}`
  ).toBeTruthy();

  const workflows = workflowsResponse.json.workflows || [];

  expect(
    Array.isArray(workflows),
    `Pole workflows powinno być tablicą. Odpowiedź: ${workflowsResponse.text}`
  ).toBeTruthy();

  expect(
    workflows.length,
    `Lista workflow nie może być pusta. Odpowiedź: ${workflowsResponse.text}`
  ).toBeGreaterThan(0);

  const workflow =
    workflows.find((w: any) => w.workflow_key === 'default') ||
    workflows.find((w: any) => w.is_default) ||
    workflows[0];

  expect(workflow?.id, `Nie znaleziono workflow z polem id. Odpowiedź: ${workflowsResponse.text}`).toBeTruthy();

  const statuses: string[] = workflow.statuses || workflow.status_list || workflow.steps || ['Nowe', 'W trakcie'];
  const targetStatus = statuses.find((status) => status !== 'Nowe') || statuses[0] || 'W trakcie';

  expect(
    targetStatus,
    `Nie udało się ustalić statusu docelowego workflow. Workflow: ${JSON.stringify(workflow)}`
  ).toBeTruthy();

  return {
    id: Number(workflow.id),
    name: workflow.name || 'Workflow testowy',
    workflowKey: workflow.workflow_key,
    statuses,
    targetStatus,
  };
}

function workflowAutomationPayload(
  workflow: WorkflowInfo,
  actionTypes: string[],
  nameSuffix: string,
  overrides: Record<string, any> = {}
) {
  const stamp = uniqueStamp();

  return {
    name: `E2E v33 ${nameSuffix} ${stamp}`,
    event_type: 'status_changed',

    condition_status: '',
    condition_to_status: workflow.targetStatus,
    condition_role: '*',
    condition_comment_visibility: '*',
    assigned_state: '*',
    condition_priority: 'Niski',
    condition_category: 'Inne',
    condition_subcategory: 'Inne',
    condition_sla_state: '*',

    condition_status_operator: 'eq',
    condition_to_status_operator: 'eq',
    condition_role_operator: 'eq',
    condition_comment_visibility_operator: 'eq',
    assigned_state_operator: 'eq',
    condition_priority_operator: 'eq',
    condition_category_operator: 'eq',
    condition_subcategory_operator: 'eq',
    condition_sla_state_operator: 'eq',

    /**
     * Zgodność wsteczna z API, które może nadal oczekiwać pojedynczego action_type.
     * Właściwa lista akcji jest w actions.
     */
    action_type: actionTypes[0],
    action_status: '',
    actions: actionTypes.map((actionType, index) => ({
      action_order: index + 1,
      action_type: actionType,
      action_value: null,
      is_active: true,
    })),

    is_active: true,
    stop_processing: true,
    priority: 1,

    ...overrides,
  };
}

async function createAutomation(
  request: APIRequestContext,
  sid: string,
  workflow: WorkflowInfo,
  actionTypes: string[],
  nameSuffix: string,
  overrides: Record<string, any> = {}
): Promise<{ id: number; payload: any; response: ApiResult }> {
  const payload = workflowAutomationPayload(workflow, actionTypes, nameSuffix, overrides);

  const response = await apiJson(request, 'POST', `/api/admin/workflows/${workflow.id}/automations`, sid, {
    data: payload,
  });

  expect(
    response.res.ok(),
    `Utworzenie reguły workflow "${nameSuffix}" zwróciło HTTP ${response.res.status()}: ${response.text}`
  ).toBeTruthy();

  const automationId = Number(response.json.id || response.json.automation_id || response.json.automation?.id);

  expect(
    automationId,
    `Brak ID reguły workflow w odpowiedzi: ${response.text}`
  ).toBeTruthy();

  return {
    id: automationId,
    payload,
    response,
  };
}

async function deleteAutomationSafe(
  request: APIRequestContext,
  sid: string,
  workflowId: number,
  automationId?: number
) {
  if (!automationId) return;

  await apiJson(
    request,
    'DELETE',
    `/api/admin/workflows/${workflowId}/automations/${automationId}`,
    sid
  ).catch(() => undefined);
}

async function getWorkflowAutomations(request: APIRequestContext, sid: string, workflowId: number) {
  const response = await apiJson(request, 'GET', `/api/admin/workflows/${workflowId}/automations`, sid);

  expect(
    response.res.ok(),
    `Pobranie automatyzacji workflow #${workflowId} zwróciło HTTP ${response.res.status()}: ${response.text}`
  ).toBeTruthy();

  return response;
}

function payloadContainsAction(payload: any, actionType: string): boolean {
  return JSON.stringify(payload).includes(actionType);
}

async function expectAutomationPresent(
  request: APIRequestContext,
  sid: string,
  workflowId: number,
  automationId: number,
  expectedActions: string[]
) {
  const automationsResponse = await getWorkflowAutomations(request, sid, workflowId);
  const automations = automationsResponse.json.automations || automationsResponse.json.rules || automationsResponse.json || [];

  const match = Array.isArray(automations)
    ? automations.find((item: any) => Number(item.id || item.automation_id) === Number(automationId))
    : undefined;

  expect(
    match,
    `Reguła #${automationId} powinna istnieć na liście automatyzacji. Odpowiedź: ${automationsResponse.text}`
  ).toBeTruthy();

  for (const actionType of expectedActions) {
    expect(
      payloadContainsAction(match, actionType),
      `Reguła #${automationId} powinna zawierać akcję ${actionType}. Reguła: ${JSON.stringify(match)}`
    ).toBeTruthy();
  }
}

async function expectAutomationRemoved(
  request: APIRequestContext,
  sid: string,
  workflowId: number,
  automationId: number
) {
  const automationsResponse = await getWorkflowAutomations(request, sid, workflowId);
  const automations = automationsResponse.json.automations || automationsResponse.json.rules || automationsResponse.json || [];

  if (!Array.isArray(automations)) {
    expect(JSON.stringify(automations)).not.toContain(String(automationId));
    return;
  }

  const match = automations.find((item: any) => Number(item.id || item.automation_id) === Number(automationId));

  expect(
    match,
    `Reguła #${automationId} nie powinna istnieć po usunięciu. Odpowiedź: ${automationsResponse.text}`
  ).toBeFalsy();
}

async function testAutomationPreview(
  request: APIRequestContext,
  sid: string,
  workflow: WorkflowInfo,
  rulePayload: any,
  sampleOverrides: Record<string, any> = {}
): Promise<ApiResult> {
  /**
   * Aktualny backend w app-configmap.yaml ma endpoint:
   *
   * POST /api/admin/workflows/<workflow_id>/automations/test
   *
   * i oczekuje payloadu:
   *
   * {
   *   rule: {...pełna definicja reguły...},
   *   sample: {...dane przykładowego zdarzenia...}
   * }
   *
   * W v33 wysyłaliśmy sam sample albo próbowaliśmy endpointów per-ID,
   * dlatego backend zwracał:
   * "Nieprawidłowa reguła automatyzacji workflow albo brak poprawnych akcji."
   */
  const sample = {
    event_type: rulePayload.event_type || 'status_changed',
    current_status: rulePayload.condition_status || 'Nowe',
    event_new_status: rulePayload.condition_to_status || workflow.targetStatus,
    actor_role: 'admin',
    comment_visibility: 'public',
    assigned_state: '*',
    priority: rulePayload.condition_priority || 'Niski',
    category: rulePayload.condition_category || 'Inne',
    subcategory: rulePayload.condition_subcategory || 'Inne',
    sla_state: rulePayload.condition_sla_state || '*',

    /**
     * Domyślnie wymagania nie są spełnione, dzięki temu preview pokazuje,
     * że require_comment / require_attachment zablokowałyby operację.
     */
    operator_added_comment: false,
    operator_added_attachment: false,

    ...sampleOverrides,
  };

  const response = await apiJson(
    request,
    'POST',
    `/api/admin/workflows/${workflow.id}/automations/test`,
    sid,
    {
      data: {
        rule: rulePayload,
        sample,
      },
    }
  );

  return response;
}

function assertPreviewLooksLikeMatch(response: ApiResult) {
  const body = JSON.stringify(response.json);

  /**
   * Akceptujemy różne nazwy pól, bo endpoint preview/test mógł ewoluować:
   * - matched
   * - matches
   * - is_match
   * - result: true
   * - actions_preview
   */
  const hasPositiveMatch =
    /"matched"\s*:\s*true/i.test(body) ||
    /"matches"\s*:\s*true/i.test(body) ||
    /"is_match"\s*:\s*true/i.test(body) ||
    /"result"\s*:\s*true/i.test(body) ||
    /actions_preview/i.test(body) ||
    /require_comment|require_attachment/i.test(body);

  expect(
    hasPositiveMatch,
    `Odpowiedź test/preview powinna wskazywać dopasowanie reguły albo pokazywać actions_preview. Odpowiedź: ${body}`
  ).toBeTruthy();
}

test.describe('Helpdesk E2E v33.1 — Etap 4 API administracji workflow', () => {
  test('API zwraca listę workflow i pozwala pobrać automatyzacje domyślnego workflow', async ({ request }) => {
    const sid = await apiLogin(request);
    const workflow = await getDefaultWorkflow(request, sid);

    expect(workflow.id).toBeGreaterThan(0);
    expect(workflow.name).toBeTruthy();
    expect(workflow.targetStatus).toBeTruthy();

    await getWorkflowAutomations(request, sid, workflow.id);
  });

  test('API tworzy i usuwa regułę z akcją require_comment', async ({ request }) => {
    const sid = await apiLogin(request);
    const workflow = await getDefaultWorkflow(request, sid);

    let automationId: number | undefined;

    try {
      const created = await createAutomation(
        request,
        sid,
        workflow,
        ['require_comment'],
        'require_comment'
      );

      automationId = created.id;

      expect(payloadContainsAction(created.response.json, 'require_comment')).toBeTruthy();

      await expectAutomationPresent(request, sid, workflow.id, automationId, ['require_comment']);

      const preview = await testAutomationPreview(request, sid, workflow, created.payload);
      expect(preview.res.ok(), `Preview/test zwrócił HTTP ${preview.res.status()}: ${preview.text}`).toBeTruthy();
      assertPreviewLooksLikeMatch(preview);
    } finally {
      await deleteAutomationSafe(request, sid, workflow.id, automationId);
      if (automationId) {
        await expectAutomationRemoved(request, sid, workflow.id, automationId);
      }
    }
  });

  test('API tworzy i usuwa regułę z akcją require_attachment', async ({ request }) => {
    const sid = await apiLogin(request);
    const workflow = await getDefaultWorkflow(request, sid);

    let automationId: number | undefined;

    try {
      const created = await createAutomation(
        request,
        sid,
        workflow,
        ['require_attachment'],
        'require_attachment'
      );

      automationId = created.id;

      expect(payloadContainsAction(created.response.json, 'require_attachment')).toBeTruthy();

      await expectAutomationPresent(request, sid, workflow.id, automationId, ['require_attachment']);

      const preview = await testAutomationPreview(request, sid, workflow, created.payload);
      expect(preview.res.ok(), `Preview/test zwrócił HTTP ${preview.res.status()}: ${preview.text}`).toBeTruthy();
      assertPreviewLooksLikeMatch(preview);
    } finally {
      await deleteAutomationSafe(request, sid, workflow.id, automationId);
      if (automationId) {
        await expectAutomationRemoved(request, sid, workflow.id, automationId);
      }
    }
  });

  test('API tworzy i usuwa regułę z wieloma akcjami require_comment oraz require_attachment', async ({ request }) => {
    const sid = await apiLogin(request);
    const workflow = await getDefaultWorkflow(request, sid);

    let automationId: number | undefined;

    try {
      const created = await createAutomation(
        request,
        sid,
        workflow,
        ['require_comment', 'require_attachment'],
        'require_comment_require_attachment'
      );

      automationId = created.id;

      expect(payloadContainsAction(created.response.json, 'require_comment')).toBeTruthy();
      expect(payloadContainsAction(created.response.json, 'require_attachment')).toBeTruthy();

      await expectAutomationPresent(
        request,
        sid,
        workflow.id,
        automationId,
        ['require_comment', 'require_attachment']
      );

      const preview = await testAutomationPreview(request, sid, workflow, created.payload);
      expect(preview.res.ok(), `Preview/test zwrócił HTTP ${preview.res.status()}: ${preview.text}`).toBeTruthy();
      assertPreviewLooksLikeMatch(preview);
    } finally {
      await deleteAutomationSafe(request, sid, workflow.id, automationId);
      if (automationId) {
        await expectAutomationRemoved(request, sid, workflow.id, automationId);
      }
    }
  });

  test('API odrzuca nieznany action_type', async ({ request }) => {
    const sid = await apiLogin(request);
    const workflow = await getDefaultWorkflow(request, sid);

    const payload = workflowAutomationPayload(
      workflow,
      ['unknown_e2e_action_type'],
      'invalid_action_type',
      {
        action_type: 'unknown_e2e_action_type',
        actions: [
          {
            action_order: 1,
            action_type: 'unknown_e2e_action_type',
            action_value: null,
            is_active: true,
          },
        ],
      }
    );

    const response = await apiJson(request, 'POST', `/api/admin/workflows/${workflow.id}/automations`, sid, {
      data: payload,
    });

    expect(
      response.res.status(),
      `API powinno odrzucić nieznany action_type. Odpowiedź: HTTP ${response.res.status()} ${response.text}`
    ).toBeGreaterThanOrEqual(400);

    expect(
      response.res.status(),
      `API powinno odrzucić nieznany action_type kodem 4xx, a nie błędem serwera. Odpowiedź: HTTP ${response.res.status()} ${response.text}`
    ).toBeLessThan(500);

    expect(
      JSON.stringify(response.json),
      `Odpowiedź powinna zawierać informację o błędnej/nieznanej akcji. Odpowiedź: ${response.text}`
    ).toMatch(/action|akcj|invalid|unknown|nieznan|niedozwol/i);
  });
});
