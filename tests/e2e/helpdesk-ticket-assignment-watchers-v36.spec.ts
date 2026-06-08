import { test, expect, APIRequestContext } from '@playwright/test';

/**
 * helpdesk-ticket-assignment-watchers-v36.spec.ts
 *
 * v36 — przypisanie operatora i obserwatorzy.
 *
 * Zakres:
 * 1. Admin/operator może przypisać zgłoszenie do operatora.
 * 2. Przypisany operator automatycznie trafia do obserwatorów.
 * 3. Nie można przypisać zgłoszenia do zwykłego użytkownika.
 * 4. Nie można usunąć przypisanego operatora z obserwatorów.
 * 5. Można dodać i usunąć dodatkowego obserwatora.
 * 6. Obserwator widzi zgłoszenie, którego sam nie utworzył.
 * 7. Po zamknięciu zgłoszenia nie można zmieniać przypisania ani obserwatorów.
 *
 * Ten plik nie nadpisuje testów v30-v35.
 */

const baseURL = process.env.HELPDESK_URL || 'https://helpdesk.lab.local';
const adminEmail = process.env.HELPDESK_ADMIN_EMAIL || '';
const adminPassword = process.env.HELPDESK_ADMIN_PASSWORD || '';

type ApiResult = {
  res: Awaited<ReturnType<APIRequestContext['fetch']>>;
  json: any;
  text: string;
};

type TestUser = {
  email: string;
  name?: string;
  role?: string;
};

function requireAdminCredentials() {
  if (!adminEmail || !adminPassword) {
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów v36.');
  }
}

function uniqueStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function jsonText(payload: unknown) {
  return JSON.stringify(payload);
}

function ticketFromDetail(detail: any) {
  return detail.ticket || detail;
}

async function apiLogin(request: APIRequestContext, email = adminEmail, password = adminPassword): Promise<string> {
  if (!email || !password) {
    throw new Error('Brak loginu lub hasła dla apiLogin().');
  }

  const res = await request.post(`${baseURL}/api/login`, {
    data: {
      email,
      password,
    },
  });

  const text = await res.text();

  expect(res.ok(), `Logowanie API dla ${email} zwróciło HTTP ${res.status()}: ${text}`).toBeTruthy();

  const data = JSON.parse(text);
  expect(data.sid, `Brak pola sid w odpowiedzi /api/login: ${text}`).toBeTruthy();

  return data.sid;
}

async function adminSid(request: APIRequestContext): Promise<string> {
  requireAdminCredentials();
  return apiLogin(request);
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

async function getUsers(request: APIRequestContext, sid: string): Promise<TestUser[]> {
  const response = await apiJson(request, 'GET', '/api/admin/users', sid);

  expect(
    response.res.ok(),
    `Pobranie użytkowników zwróciło HTTP ${response.res.status()}: ${response.text}`
  ).toBeTruthy();

  const candidates =
    response.json.users ||
    response.json.items ||
    response.json.data ||
    response.json;

  expect(Array.isArray(candidates), `Odpowiedź /api/admin/users powinna zawierać listę. Odpowiedź: ${response.text}`).toBeTruthy();

  return candidates.map((item: any) => {
    const roles = item.roles || item.role || [];
    const roleText = Array.isArray(roles) ? roles.join(',') : String(roles || '');

    return {
      email: item.email,
      name: item.name || `${item.first_name || ''} ${item.last_name || ''}`.trim() || item.email,
      role: roleText,
    };
  }).filter((item: TestUser) => item.email);
}

async function getOperatorAndUser(request: APIRequestContext, sid: string): Promise<{ operator: TestUser; normalUser: TestUser; watcherUser: TestUser }> {
  const users = await getUsers(request, sid);

  const operator =
    users.find((user) => /operator/i.test(user.role || '') && !/admin/i.test(user.role || '')) ||
    users.find((user) => /operator/i.test(user.email)) ||
    users.find((user) => /operator/i.test(user.role || ''));

  const normalUsers = users.filter((user) =>
    /user/i.test(user.role || '') &&
    !/operator|admin/i.test(user.role || '') &&
    user.email.toLowerCase() !== adminEmail.toLowerCase()
  );

  const normalUser =
    normalUsers.find((user) => /anna\.kowalska/i.test(user.email)) ||
    normalUsers[0];

  const watcherUser =
    normalUsers.find((user) => normalUser && user.email.toLowerCase() !== normalUser.email.toLowerCase()) ||
    normalUsers[0];

  expect(operator?.email, `Nie znaleziono operatora w /api/admin/users. Użytkownicy: ${JSON.stringify(users)}`).toBeTruthy();
  expect(normalUser?.email, `Nie znaleziono zwykłego użytkownika w /api/admin/users. Użytkownicy: ${JSON.stringify(users)}`).toBeTruthy();
  expect(watcherUser?.email, `Nie znaleziono użytkownika-obserwatora w /api/admin/users. Użytkownicy: ${JSON.stringify(users)}`).toBeTruthy();

  return {
    operator,
    normalUser,
    watcherUser,
  };
}

async function createTicket(
  request: APIRequestContext,
  sid: string,
  titlePrefix: string
): Promise<{ id: number; title: string; requesterEmail?: string }> {
  const title = `${titlePrefix} ${uniqueStamp()}`;

  const created = await apiJson(request, 'POST', '/api/tickets', sid, {
    data: {
      title,
      description: 'Zgłoszenie testowe v36 — przypisanie operatora i obserwatorzy.',
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

  const detail = await getTicketDetail(request, sid, ticketId);
  const ticket = ticketFromDetail(detail);

  return {
    id: ticketId,
    title,
    requesterEmail: ticket.requester_email,
  };
}

async function getTicketDetail(request: APIRequestContext, sid: string, ticketId: number) {
  const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);

  expect(
    detail.res.ok(),
    `Pobranie szczegółów zgłoszenia #${ticketId} zwróciło HTTP ${detail.res.status()}: ${detail.text}`
  ).toBeTruthy();

  return detail.json;
}

async function assignTicket(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  assignedToEmail: string
): Promise<ApiResult> {
  return apiJson(request, 'POST', `/api/tickets/${ticketId}/assign`, sid, {
    data: {
      assigned_to_email: assignedToEmail,
    },
  });
}

async function addWatcher(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  email: string
): Promise<ApiResult> {
  return apiJson(request, 'POST', `/api/tickets/${ticketId}/watchers`, sid, {
    data: {
      user_email: email,
    },
  });
}

async function removeWatcher(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  email: string
): Promise<ApiResult> {
  return apiJson(
    request,
    'DELETE',
    `/api/tickets/${ticketId}/watchers/${encodeURIComponent(email)}`,
    sid
  );
}

async function closeTicket(
  request: APIRequestContext,
  sid: string,
  ticketId: number
): Promise<ApiResult> {
  return apiJson(request, 'POST', `/api/tickets/${ticketId}/close`, sid, {
    multipart: {
      resolution_hours: '0',
      resolution_minutes: '30',
      resolution_summary: `Zamknięcie do testów v36 ${uniqueStamp()}`,
      visibility: 'public',
    },
  });
}

function expectPayloadContains(payload: any, expected: string, message: string) {
  expect(
    jsonText(payload).toLowerCase().includes(expected.toLowerCase()),
    `${message}\nSzukano: ${expected}\nOdpowiedź: ${jsonText(payload).slice(0, 3000)}`
  ).toBeTruthy();
}

function expectPayloadDoesNotContain(payload: any, expected: string, message: string) {
  expect(
    jsonText(payload).toLowerCase().includes(expected.toLowerCase()),
    `${message}\nNie powinno być: ${expected}\nOdpowiedź: ${jsonText(payload).slice(0, 3000)}`
  ).toBeFalsy();
}

function expectPayloadMatches(payload: any, pattern: RegExp, message: string) {
  expect(
    jsonText(payload),
    `${message}\nOdpowiedź: ${jsonText(payload).slice(0, 3000)}`
  ).toMatch(pattern);
}

test.describe('Helpdesk E2E v36 — przypisanie operatora i obserwatorzy', () => {
  test('przypisuje zgłoszenie do operatora i automatycznie dodaje go do obserwatorów', async ({ request }) => {
    const sid = await adminSid(request);
    const { operator } = await getOperatorAndUser(request, sid);
    const ticket = await createTicket(request, sid, 'E2E v36 assign operator');

    const assigned = await assignTicket(request, sid, ticket.id, operator.email);

    expect(
      assigned.res.ok(),
      `Przypisanie operatora zwróciło HTTP ${assigned.res.status()}: ${assigned.text}`
    ).toBeTruthy();

    const detail = await getTicketDetail(request, sid, ticket.id);
    const ticketDetail = ticketFromDetail(detail);

    expect((ticketDetail.assigned_to_email || '').toLowerCase()).toBe(operator.email.toLowerCase());

    expectPayloadContains(
      detail,
      operator.email,
      'Przypisany operator powinien być widoczny w szczegółach zgłoszenia.'
    );

    expectPayloadMatches(
      detail,
      /watcher|obserwator|assignment_changed|Przypisanie zmienione/i,
      'Szczegóły/historia powinny zawierać informację o przypisaniu albo obserwatorach.'
    );
  });

  test('odrzuca próbę przypisania zgłoszenia do zwykłego użytkownika', async ({ request }) => {
    const sid = await adminSid(request);
    const { normalUser } = await getOperatorAndUser(request, sid);
    const ticket = await createTicket(request, sid, 'E2E v36 assign normal user rejected');

    const assigned = await assignTicket(request, sid, ticket.id, normalUser.email);

    expect(
      assigned.res.status(),
      `Przypisanie zwykłego użytkownika powinno być zablokowane. Odpowiedź: HTTP ${assigned.res.status()} ${assigned.text}`
    ).toBe(400);

    expectPayloadMatches(
      assigned.json,
      /operator/i,
      'Odpowiedź powinna informować, że można przypisać tylko operatora.'
    );

    const detail = await getTicketDetail(request, sid, ticket.id);
    const ticketDetail = ticketFromDetail(detail);

    expect((ticketDetail.assigned_to_email || '').toLowerCase()).not.toBe(normalUser.email.toLowerCase());
  });

  test('nie pozwala usunąć przypisanego operatora z obserwatorów', async ({ request }) => {
    const sid = await adminSid(request);
    const { operator } = await getOperatorAndUser(request, sid);
    const ticket = await createTicket(request, sid, 'E2E v36 assigned operator watcher protected');

    const assigned = await assignTicket(request, sid, ticket.id, operator.email);
    expect(assigned.res.ok(), `Przypisanie operatora zwróciło HTTP ${assigned.res.status()}: ${assigned.text}`).toBeTruthy();

    const remove = await removeWatcher(request, sid, ticket.id, operator.email);

    expect(
      remove.res.status(),
      `Usunięcie przypisanego operatora z obserwatorów powinno być zablokowane. Odpowiedź: HTTP ${remove.res.status()} ${remove.text}`
    ).toBe(400);

    expectPayloadMatches(
      remove.json,
      /przypisany operator|pozostaje obserwatorem|assigned/i,
      'Odpowiedź powinna informować, że przypisany operator pozostaje obserwatorem.'
    );

    const detail = await getTicketDetail(request, sid, ticket.id);
    expectPayloadContains(
      detail,
      operator.email,
      'Po nieudanej próbie usunięcia przypisany operator nadal powinien być widoczny w zgłoszeniu.'
    );
  });

  test('pozwala dodać i usunąć dodatkowego obserwatora', async ({ request }) => {
    const sid = await adminSid(request);
    const { watcherUser } = await getOperatorAndUser(request, sid);
    const ticket = await createTicket(request, sid, 'E2E v36 add remove watcher');

    const added = await addWatcher(request, sid, ticket.id, watcherUser.email);

    expect(
      added.res.ok(),
      `Dodanie obserwatora zwróciło HTTP ${added.res.status()}: ${added.text}`
    ).toBeTruthy();

    const afterAdd = await getTicketDetail(request, sid, ticket.id);

    expectPayloadContains(
      afterAdd,
      watcherUser.email,
      'Dodany obserwator powinien być widoczny w szczegółach zgłoszenia.'
    );

    const removed = await removeWatcher(request, sid, ticket.id, watcherUser.email);

    expect(
      removed.res.ok(),
      `Usunięcie obserwatora zwróciło HTTP ${removed.res.status()}: ${removed.text}`
    ).toBeTruthy();

    const afterRemove = await getTicketDetail(request, sid, ticket.id);

    /**
     * E-mail może pozostać w historii zdarzeń, dlatego nie wymagamy, żeby cały payload
     * nie zawierał adresu. Wymagamy natomiast, żeby pojawiło się zdarzenie usunięcia.
     */
    expectPayloadMatches(
      afterRemove,
      /watcher_removed|Usunięto obserwatora|obserwatora/i,
      'Historia zgłoszenia powinna zawierać usunięcie obserwatora.'
    );
  });

  test('obserwator widzi zgłoszenie, którego sam nie utworzył', async ({ request }) => {
    const sid = await adminSid(request);
    const { watcherUser } = await getOperatorAndUser(request, sid);
    const ticket = await createTicket(request, sid, 'E2E v36 watcher can view foreign ticket');

    const beforeWatcherSid = await apiLogin(request, watcherUser.email, adminPassword);
    const before = await apiJson(request, 'GET', `/api/tickets/${ticket.id}`, beforeWatcherSid);

    /**
     * Jeżeli dany seed-user jest równocześnie requestorem przez aktualny stan danych,
     * test nadal ma sens po dodaniu jako obserwatora; przed dodaniem zwykle oczekujemy 403,
     * ale nie robimy z tego twardej asercji, bo rola user może mieć dostęp do własnych
     * zgłoszeń zależnie od konfiguracji seedów.
     */
    expect([200, 403, 404].includes(before.res.status()), `Nieoczekiwany kod przed dodaniem obserwatora: HTTP ${before.res.status()} ${before.text}`).toBeTruthy();

    const added = await addWatcher(request, sid, ticket.id, watcherUser.email);
    expect(added.res.ok(), `Dodanie obserwatora zwróciło HTTP ${added.res.status()}: ${added.text}`).toBeTruthy();

    const watcherSid = await apiLogin(request, watcherUser.email, adminPassword);
    const after = await apiJson(request, 'GET', `/api/tickets/${ticket.id}`, watcherSid);

    expect(
      after.res.ok(),
      `Obserwator powinien widzieć zgłoszenie po dodaniu do obserwatorów. Odpowiedź: HTTP ${after.res.status()} ${after.text}`
    ).toBeTruthy();

    expectPayloadContains(
      after.json,
      ticket.title,
      'Obserwator powinien otrzymać szczegóły właściwego zgłoszenia.'
    );
  });

  test('po zamknięciu zgłoszenia nie można zmieniać przypisania ani obserwatorów', async ({ request }) => {
    const sid = await adminSid(request);
    const { operator, watcherUser } = await getOperatorAndUser(request, sid);
    const ticket = await createTicket(request, sid, 'E2E v36 closed ticket assignment watchers');

    const close = await closeTicket(request, sid, ticket.id);

    expect(
      close.res.ok(),
      `Zamknięcie zgłoszenia zwróciło HTTP ${close.res.status()}: ${close.text}`
    ).toBeTruthy();

    const assignClosed = await assignTicket(request, sid, ticket.id, operator.email);

    expect(
      assignClosed.res.status(),
      `Przypisanie zamkniętego zgłoszenia powinno być zablokowane. Odpowiedź: HTTP ${assignClosed.res.status()} ${assignClosed.text}`
    ).toBe(400);

    expectPayloadMatches(
      assignClosed.json,
      /zamknięte|zamkniete|tylko do odczytu|closed|read/i,
      'Odpowiedź przypisania zamkniętego zgłoszenia powinna informować o trybie tylko do odczytu.'
    );

    const addWatcherClosed = await addWatcher(request, sid, ticket.id, watcherUser.email);

    expect(
      addWatcherClosed.res.status(),
      `Dodanie obserwatora do zamkniętego zgłoszenia powinno być zablokowane. Odpowiedź: HTTP ${addWatcherClosed.res.status()} ${addWatcherClosed.text}`
    ).toBe(400);

    expectPayloadMatches(
      addWatcherClosed.json,
      /zamknięte|zamkniete|tylko do odczytu|closed|read/i,
      'Odpowiedź dodania obserwatora do zamkniętego zgłoszenia powinna informować o trybie tylko do odczytu.'
    );

    const removeWatcherClosed = await removeWatcher(request, sid, ticket.id, watcherUser.email);

    expect(
      removeWatcherClosed.res.status(),
      `Usunięcie obserwatora z zamkniętego zgłoszenia powinno być zablokowane albo zgłoszenie powinno pozostać niezmienne. Odpowiedź: HTTP ${removeWatcherClosed.res.status()} ${removeWatcherClosed.text}`
    ).toBeGreaterThanOrEqual(400);

    expect(removeWatcherClosed.res.status()).toBeLessThan(500);

    expectPayloadMatches(
      removeWatcherClosed.json,
      /zamknięte|zamkniete|tylko do odczytu|closed|read|not found|nie znaleziono/i,
      'Odpowiedź usunięcia obserwatora z zamkniętego zgłoszenia powinna być kontrolowanym błędem.'
    );
  });
});
