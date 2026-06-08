import { test, expect, APIRequestContext } from '@playwright/test';

/**
 * helpdesk-workflow-regression-v30.spec.ts
 *
 * Etap 1 — testy regresji workflow/statusów.
 *
 * Ten plik jest przygotowany jako osobny plik testowy, żeby nie nadpisywać
 * obecnego tests/e2e/helpdesk-ui.spec.ts.
 *
 * Zakres:
 * 1. Workflow blokuje zmianę statusu bez wymaganego komentarza.
 * 2. Workflow pozwala zmienić status po dodaniu komentarza.
 * 3. Workflow blokuje zmianę statusu bez wymaganego załącznika.
 * 4. Workflow pozwala zmienić status po dodaniu załącznika.
 * 5. Workflow wymaga jednocześnie komentarza i załącznika, jeżeli reguła ma obie akcje.
 *
 * Założenia zgodne z dotychczasową aplikacją helpdesk:
 * - logowanie API: POST /api/login
 * - zgłoszenia: /api/tickets
 * - zmiana statusu: POST /api/tickets/:id/status
 * - komentarze: POST /api/tickets/:id/comments
 * - załączniki: POST /api/tickets/:id/attachments
 * - workflow: /api/admin/workflows/:workflowId/automations
 *
 * Wymagane zmienne środowiskowe:
 * - HELPDESK_URL, np. https://helpdesk.lab.local
 * - HELPDESK_ADMIN_EMAIL
 * - HELPDESK_ADMIN_PASSWORD
 * - opcjonalnie HELPDESK_IGNORE_TLS=1, jeżeli certyfikat lab.local nie jest zaufany lokalnie
 */

const baseURL = process.env.HELPDESK_URL || 'https://helpdesk.lab.local';
const adminEmail = process.env.HELPDESK_ADMIN_EMAIL || '';
const adminPassword = process.env.HELPDESK_ADMIN_PASSWORD || '';

type JsonResponse = {
  res: Awaited<ReturnType<APIRequestContext['fetch']>>;
  json: any;
  text: string;
};

function requireAdminCredentials() {
  if (!adminEmail || !adminPassword) {
    throw new Error(
      'Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów E2E.'
    );
  }
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
  options: {
    data?: any;
    multipart?: any;
    headers?: Record<string, string>;
  } = {}
): Promise<JsonResponse> {
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

function ticketFromDetail(detail: any) {
  return detail.ticket || detail;
}

function uniqueStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function createTicket(
  request: APIRequestContext,
  sid: string,
  titlePrefix: string
): Promise<{ id: number; title: string; workflowId: number; workflowKey?: string; oldStatus: string; targetStatus: string }> {
  const stamp = uniqueStamp();
  const title = `${titlePrefix} ${stamp}`;

  const created = await apiJson(request, 'POST', '/api/tickets', sid, {
    data: {
      title,
      description: 'Zgłoszenie testowe utworzone automatycznie przez Playwright E2E v30.',
      category: 'Inne',
      subcategory: 'Inne',
      priority: 'Niski',
    },
  });

  expect(
    created.res.ok(),
    `Tworzenie zgłoszenia testowego zwróciło HTTP ${created.res.status()}: ${created.text}`
  ).toBeTruthy();

  const ticketId = Number(created.json.id || created.json.ticket_id || created.json.ticket?.id);
  expect(ticketId, `Brak ID zgłoszenia w odpowiedzi: ${created.text}`).toBeTruthy();

  const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);
  expect(
    detail.res.ok(),
    `Pobranie szczegółów zgłoszenia #${ticketId} zwróciło HTTP ${detail.res.status()}: ${detail.text}`
  ).toBeTruthy();

  const ticket = ticketFromDetail(detail.json);
  const oldStatus = ticket.status;
  const statuses: string[] = detail.json.meta?.statuses || [];

  const targetStatus =
    statuses.find((status) => status !== oldStatus && status !== 'Zamknięte') ||
    statuses.find((status) => status !== oldStatus) ||
    '';

  expect(
    targetStatus,
    `Nie znaleziono statusu docelowego innego niż obecny status "${oldStatus}". Dostępne statusy: ${statuses.join(', ')}`
  ).toBeTruthy();

  const workflowsResponse = await apiJson(request, 'GET', '/api/admin/workflows', sid);
  expect(
    workflowsResponse.res.ok(),
    `Pobranie listy workflow zwróciło HTTP ${workflowsResponse.res.status()}: ${workflowsResponse.text}`
  ).toBeTruthy();

  const workflows = workflowsResponse.json.workflows || [];
  const workflow =
    workflows.find((w: any) => w.workflow_key === ticket.workflow_key) ||
    workflows.find((w: any) => w.is_default) ||
    workflows[0];

  expect(workflow?.id, `Nie znaleziono workflow dla zgłoszenia #${ticketId}`).toBeTruthy();

  return {
    id: ticketId,
    title,
    workflowId: Number(workflow.id),
    workflowKey: ticket.workflow_key,
    oldStatus,
    targetStatus,
  };
}

async function createAutomation(
  request: APIRequestContext,
  sid: string,
  workflowId: number,
  targetStatus: string,
  actionTypes: Array<'require_comment' | 'require_attachment'>,
  nameSuffix: string
): Promise<number> {
  const stamp = uniqueStamp();

  const actions = actionTypes.map((actionType, index) => ({
    action_order: index + 1,
    action_type: actionType,
    action_value: null,
    is_active: true,
  }));

  const payload = {
    name: `E2E v30 ${nameSuffix} ${stamp}`,
    event_type: 'status_changed',

    /**
     * Puste condition_status oznacza dowolny status źródłowy.
     * To jest celowe, bo istniejące reguły mogą automatycznie zmienić status
     * po dodaniu komentarza albo załącznika.
     */
    condition_status: '',
    condition_to_status: targetStatus,
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
     * Zgodność wsteczna z API, które nadal może oczekiwać pojedynczego action_type.
     * Właściwa lista akcji idzie w polu actions.
     */
    action_type: actionTypes[0],
    action_status: '',
    actions,

    is_active: true,
    stop_processing: true,
    priority: 1,
  };

  const rule = await apiJson(request, 'POST', `/api/admin/workflows/${workflowId}/automations`, sid, {
    data: payload,
  });

  expect(
    rule.res.ok(),
    `Utworzenie reguły workflow ${nameSuffix} zwróciło HTTP ${rule.res.status()}: ${rule.text}`
  ).toBeTruthy();

  const automationId = Number(rule.json.id || rule.json.automation_id);
  expect(automationId, `Brak ID reguły workflow w odpowiedzi: ${rule.text}`).toBeTruthy();

  return automationId;
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

async function addComment(request: APIRequestContext, sid: string, ticketId: number, content: string) {
  const comment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/comments`, sid, {
    data: {
      content,
      visibility: 'public',
    },
  });

  expect(
    comment.res.ok(),
    `Dodanie komentarza do zgłoszenia #${ticketId} zwróciło HTTP ${comment.res.status()}: ${comment.text}`
  ).toBeTruthy();
}

async function addAttachment(request: APIRequestContext, sid: string, ticketId: number, fileName: string) {
  const attachment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/attachments`, sid, {
    multipart: {
      file: {
        name: fileName,
        mimeType: 'text/plain',
        buffer: Buffer.from('Załącznik testowy wymagany przez testy E2E v30.\n'),
      },
    },
  });

  expect(
    attachment.res.ok(),
    `Dodanie załącznika do zgłoszenia #${ticketId} zwróciło HTTP ${attachment.res.status()}: ${attachment.text}`
  ).toBeTruthy();
}

async function changeStatus(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  status: string
): Promise<JsonResponse> {
  return apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, {
    data: {
      status,
    },
  });
}

async function expectStatus(ticketId: number, request: APIRequestContext, sid: string, expectedStatus: string) {
  const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);
  expect(
    detail.res.ok(),
    `Pobranie szczegółów zgłoszenia #${ticketId} zwróciło HTTP ${detail.res.status()}: ${detail.text}`
  ).toBeTruthy();

  expect(ticketFromDetail(detail.json).status).toBe(expectedStatus);
}

test.describe('Helpdesk E2E v30 — Etap 1 regresja workflow/statusów', () => {
  test('blokuje zmianę statusu bez wymaganego komentarza i pozwala po dodaniu komentarza', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicket(request, sid, 'E2E v30 require_comment');

    let automationId: number | undefined;

    try {
      automationId = await createAutomation(
        request,
        sid,
        ticket.workflowId,
        ticket.targetStatus,
        ['require_comment'],
        'wymagaj komentarza'
      );

      const withoutComment = await changeStatus(request, sid, ticket.id, ticket.targetStatus);

      expect(
        withoutComment.res.status(),
        `Zmiana statusu bez komentarza powinna zwrócić 409, zwróciła HTTP ${withoutComment.res.status()}: ${withoutComment.text}`
      ).toBe(409);

      expect(JSON.stringify(withoutComment.json)).toMatch(/comment|komentarz/i);

      await addComment(
        request,
        sid,
        ticket.id,
        `Komentarz wymagany przez test E2E v30 ${uniqueStamp()}`
      );

      const withComment = await changeStatus(request, sid, ticket.id, ticket.targetStatus);

      expect(
        withComment.res.ok(),
        `Zmiana statusu po dodaniu komentarza powinna przejść, zwróciła HTTP ${withComment.res.status()}: ${withComment.text}`
      ).toBeTruthy();

      await expectStatus(ticket.id, request, sid, ticket.targetStatus);
    } finally {
      await deleteAutomationSafe(request, sid, ticket.workflowId, automationId);
    }
  });

  test('blokuje zmianę statusu bez wymaganego załącznika i pozwala po dodaniu załącznika', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicket(request, sid, 'E2E v30 require_attachment');

    let automationId: number | undefined;

    try {
      automationId = await createAutomation(
        request,
        sid,
        ticket.workflowId,
        ticket.targetStatus,
        ['require_attachment'],
        'wymagaj załącznika'
      );

      const withoutAttachment = await changeStatus(request, sid, ticket.id, ticket.targetStatus);

      expect(
        withoutAttachment.res.status(),
        `Zmiana statusu bez załącznika powinna zwrócić 409, zwróciła HTTP ${withoutAttachment.res.status()}: ${withoutAttachment.text}`
      ).toBe(409);

      expect(JSON.stringify(withoutAttachment.json)).toMatch(/attachment|załącznik|zalacznik/i);

      await addAttachment(
        request,
        sid,
        ticket.id,
        `helpdesk-e2e-v30-require-attachment-${Date.now()}.txt`
      );

      const withAttachment = await changeStatus(request, sid, ticket.id, ticket.targetStatus);

      expect(
        withAttachment.res.ok(),
        `Zmiana statusu po dodaniu załącznika powinna przejść, zwróciła HTTP ${withAttachment.res.status()}: ${withAttachment.text}`
      ).toBeTruthy();

      await expectStatus(ticket.id, request, sid, ticket.targetStatus);
    } finally {
      await deleteAutomationSafe(request, sid, ticket.workflowId, automationId);
    }
  });

  test('wymaga jednocześnie komentarza i załącznika, jeżeli reguła workflow ma obie akcje', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicket(request, sid, 'E2E v30 require_comment_attachment');

    let automationId: number | undefined;

    try {
      automationId = await createAutomation(
        request,
        sid,
        ticket.workflowId,
        ticket.targetStatus,
        ['require_comment', 'require_attachment'],
        'wymagaj komentarza i załącznika'
      );

      const withoutRequirements = await changeStatus(request, sid, ticket.id, ticket.targetStatus);

      expect(
        withoutRequirements.res.status(),
        `Zmiana statusu bez komentarza i załącznika powinna zwrócić 409, zwróciła HTTP ${withoutRequirements.res.status()}: ${withoutRequirements.text}`
      ).toBe(409);

      expect(JSON.stringify(withoutRequirements.json)).toMatch(/comment|komentarz/i);
      expect(JSON.stringify(withoutRequirements.json)).toMatch(/attachment|załącznik|zalacznik/i);

      await addComment(
        request,
        sid,
        ticket.id,
        `Komentarz wymagany przez test E2E v30 komentarz + załącznik ${uniqueStamp()}`
      );

      const onlyComment = await changeStatus(request, sid, ticket.id, ticket.targetStatus);

      expect(
        onlyComment.res.status(),
        `Zmiana statusu tylko z komentarzem powinna nadal zwrócić 409, zwróciła HTTP ${onlyComment.res.status()}: ${onlyComment.text}`
      ).toBe(409);

      expect(JSON.stringify(onlyComment.json)).toMatch(/attachment|załącznik|zalacznik/i);

      await addAttachment(
        request,
        sid,
        ticket.id,
        `helpdesk-e2e-v30-comment-attachment-${Date.now()}.txt`
      );

      const withBothRequirements = await changeStatus(request, sid, ticket.id, ticket.targetStatus);

      expect(
        withBothRequirements.res.ok(),
        `Zmiana statusu po dodaniu komentarza i załącznika powinna przejść, zwróciła HTTP ${withBothRequirements.res.status()}: ${withBothRequirements.text}`
      ).toBeTruthy();

      await expectStatus(ticket.id, request, sid, ticket.targetStatus);
    } finally {
      await deleteAutomationSafe(request, sid, ticket.workflowId, automationId);
    }
  });
});
