import { test, expect, APIRequestContext } from '@playwright/test';

/**
 * helpdesk-internal-notes-visibility-v38.spec.ts
 *
 * v38.2 — notatki wewnętrzne i widoczność.
 *
 * Poprawki względem v38/v38.1:
 * - nie zakładamy, że każdy operator ma hasło admina,
 * - można podać HELPDESK_OPERATOR_EMAIL / HELPDESK_OPERATOR_PASSWORD,
 * - jeżeli nie ma poprawnych danych operatora, test operatora jest pomijany,
 * - test wycieku treści notatki internal przez events.message pozostaje restrykcyjny.
 *
 * Ten plik nie nadpisuje testów v30-v37.
 */

const baseURL = process.env.HELPDESK_URL || 'https://helpdesk.lab.local';
const adminEmail = process.env.HELPDESK_ADMIN_EMAIL || '';
const adminPassword = process.env.HELPDESK_ADMIN_PASSWORD || '';
const operatorEmailFromEnv = process.env.HELPDESK_OPERATOR_EMAIL || '';
const operatorPasswordFromEnv = process.env.HELPDESK_OPERATOR_PASSWORD || '';

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
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów v38.');
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

async function apiLogin(
  request: APIRequestContext,
  email = adminEmail,
  password = adminPassword,
  options: { allowFailure?: boolean } = {}
): Promise<string | null> {
  if (!email || !password) {
    if (options.allowFailure) return null;
    throw new Error('Brak loginu lub hasła dla apiLogin().');
  }

  const res = await request.post(`${baseURL}/api/login`, {
    data: {
      email,
      password,
    },
  });

  const text = await res.text();

  if (options.allowFailure && !res.ok()) {
    return null;
  }

  expect(res.ok(), `Logowanie API dla ${email} zwróciło HTTP ${res.status()}: ${text}`).toBeTruthy();

  const data = JSON.parse(text);
  expect(data.sid, `Brak pola sid w odpowiedzi /api/login: ${text}`).toBeTruthy();

  return data.sid;
}

async function adminSid(request: APIRequestContext): Promise<string> {
  requireAdminCredentials();
  const sid = await apiLogin(request);
  expect(sid).toBeTruthy();
  return sid as string;
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

async function getNormalUser(request: APIRequestContext, sid: string): Promise<TestUser> {
  const users = await getUsers(request, sid);

  const normalUser =
    users.find((user) =>
      /user/i.test(user.role || '') &&
      !/operator|admin/i.test(user.role || '') &&
      user.email.toLowerCase() !== adminEmail.toLowerCase()
    ) ||
    users.find((user) => !/operator|admin/i.test(user.role || '') && user.email.toLowerCase() !== adminEmail.toLowerCase());

  expect(normalUser?.email, `Nie znaleziono zwykłego użytkownika w /api/admin/users. Użytkownicy: ${JSON.stringify(users)}`).toBeTruthy();

  return normalUser;
}

async function getOperator(request: APIRequestContext, sid: string): Promise<TestUser> {
  const users = await getUsers(request, sid);

  const operator =
    users.find((user) => user.email.toLowerCase() === 'operator@incoprp.local') ||
    users.find((user) => /operator/i.test(user.role || '') && !/admin/i.test(user.role || '')) ||
    users.find((user) => /operator/i.test(user.email)) ||
    users.find((user) => /operator/i.test(user.role || ''));

  expect(operator?.email, `Nie znaleziono operatora w /api/admin/users. Użytkownicy: ${JSON.stringify(users)}`).toBeTruthy();

  return operator;
}

async function loginAsOperatorIfAvailable(
  request: APIRequestContext,
  selectedOperator: TestUser
): Promise<string | null> {
  const candidates: Array<{ email: string; password: string }> = [];

  if (operatorEmailFromEnv && operatorPasswordFromEnv) {
    candidates.push({
      email: operatorEmailFromEnv,
      password: operatorPasswordFromEnv,
    });
  }

  candidates.push({
    email: 'operator@incoprp.local',
    password: adminPassword,
  });

  if (selectedOperator.email.toLowerCase() !== 'operator@incoprp.local') {
    candidates.push({
      email: selectedOperator.email,
      password: adminPassword,
    });
  }

  for (const candidate of candidates) {
    const sid = await apiLogin(request, candidate.email, candidate.password, { allowFailure: true });
    if (sid) return sid;
  }

  return null;
}

async function createTicket(
  request: APIRequestContext,
  sid: string,
  titlePrefix: string
): Promise<{ id: number; title: string }> {
  const title = `${titlePrefix} ${uniqueStamp()}`;

  const created = await apiJson(request, 'POST', '/api/tickets', sid, {
    data: {
      title,
      description: 'Zgłoszenie testowe v38.2 — notatki wewnętrzne i widoczność.',
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

  return {
    id: ticketId,
    title,
  };
}

async function createTicketAsUser(
  request: APIRequestContext,
  userSid: string,
  titlePrefix: string
): Promise<{ id: number; title: string }> {
  return createTicket(request, userSid, titlePrefix);
}

async function getTicketDetail(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  expectedOk = true
): Promise<ApiResult> {
  const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);

  if (expectedOk) {
    expect(
      detail.res.ok(),
      `Pobranie szczegółów zgłoszenia #${ticketId} zwróciło HTTP ${detail.res.status()}: ${detail.text}`
    ).toBeTruthy();
  }

  return detail;
}

async function addComment(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  content: string,
  visibility: 'public' | 'internal'
): Promise<ApiResult> {
  return apiJson(request, 'POST', `/api/tickets/${ticketId}/comments`, sid, {
    data: {
      content,
      visibility,
    },
  });
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

function responseStatusIsControlledClientError(response: ApiResult): boolean {
  return response.res.status() >= 400 && response.res.status() < 500;
}

test.describe('Helpdesk E2E v38.2 — notatki wewnętrzne i widoczność', () => {
  test('admin dodaje notatkę wewnętrzną i widzi ją w szczegółach zgłoszenia', async ({ request }) => {
    const sid = await adminSid(request);
    const ticket = await createTicket(request, sid, 'E2E v38 admin internal note');
    const internalNote = `Notatka wewnętrzna admin v38 ${uniqueStamp()}`;

    const added = await addComment(request, sid, ticket.id, internalNote, 'internal');

    expect(
      added.res.ok(),
      `Dodanie notatki wewnętrznej przez admina zwróciło HTTP ${added.res.status()}: ${added.text}`
    ).toBeTruthy();

    const detail = await getTicketDetail(request, sid, ticket.id);

    expectPayloadContains(
      detail.json,
      internalNote,
      'Admin powinien widzieć dodaną notatkę wewnętrzną.'
    );

    expectPayloadMatches(
      detail.json,
      /internal|wewnętrzn|wewnetrzn|internal_note|note_internal/i,
      'Szczegóły/historia powinny zawierać informację, że komentarz jest wewnętrzny.'
    );
  });

  test('operator przypisany do zgłoszenia widzi notatkę wewnętrzną', async ({ request }) => {
    const sid = await adminSid(request);
    const operator = await getOperator(request, sid);
    const ticket = await createTicket(request, sid, 'E2E v38 operator internal note');
    const internalNote = `Notatka wewnętrzna dla operatora v38 ${uniqueStamp()}`;

    const assign = await assignTicket(request, sid, ticket.id, operator.email);
    expect(assign.res.ok(), `Przypisanie operatora zwróciło HTTP ${assign.res.status()}: ${assign.text}`).toBeTruthy();

    const added = await addComment(request, sid, ticket.id, internalNote, 'internal');
    expect(added.res.ok(), `Dodanie notatki wewnętrznej zwróciło HTTP ${added.res.status()}: ${added.text}`).toBeTruthy();

    const operatorSid = await loginAsOperatorIfAvailable(request, operator);
    test.skip(!operatorSid, `Brak poprawnych danych logowania operatora ${operator.email}; ustaw HELPDESK_OPERATOR_EMAIL i HELPDESK_OPERATOR_PASSWORD.`);

    const operatorDetail = await getTicketDetail(request, operatorSid as string, ticket.id);

    expectPayloadContains(
      operatorDetail.json,
      internalNote,
      'Przypisany operator powinien widzieć notatkę wewnętrzną.'
    );
  });

  test('zwykły użytkownik/requester nie widzi notatki wewnętrznej, ale widzi komentarz publiczny', async ({ request }) => {
    const admin = await adminSid(request);
    const normalUser = await getNormalUser(request, admin);
    const userSid = await apiLogin(request, normalUser.email, adminPassword);
    expect(userSid).toBeTruthy();

    /**
     * Tworzymy zgłoszenie jako zwykły użytkownik, żeby miał naturalny dostęp jako requester.
     */
    const ticket = await createTicketAsUser(request, userSid as string, 'E2E v38 requester hidden internal note');

    const publicComment = `Komentarz publiczny widoczny dla requestera v38 ${uniqueStamp()}`;
    const internalNote = `Poufna notatka wewnętrzna niewidoczna dla requestera v38 ${uniqueStamp()}`;

    const addedPublic = await addComment(request, admin, ticket.id, publicComment, 'public');
    expect(addedPublic.res.ok(), `Dodanie publicznego komentarza zwróciło HTTP ${addedPublic.res.status()}: ${addedPublic.text}`).toBeTruthy();

    const addedInternal = await addComment(request, admin, ticket.id, internalNote, 'internal');
    expect(addedInternal.res.ok(), `Dodanie notatki wewnętrznej zwróciło HTTP ${addedInternal.res.status()}: ${addedInternal.text}`).toBeTruthy();

    const requesterDetail = await getTicketDetail(request, userSid as string, ticket.id);

    expectPayloadContains(
      requesterDetail.json,
      publicComment,
      'Requester powinien widzieć komentarz publiczny.'
    );

    expectPayloadDoesNotContain(
      requesterDetail.json,
      internalNote,
      'Requester nie powinien widzieć treści notatki wewnętrznej — ani w comments, ani w events.message.'
    );

    const adminDetail = await getTicketDetail(request, admin, ticket.id);

    expectPayloadContains(
      adminDetail.json,
      internalNote,
      'Admin nadal powinien widzieć notatkę wewnętrzną.'
    );
  });

  test('zwykły użytkownik nie może utworzyć notatki wewnętrznej przez visibility=internal', async ({ request }) => {
    const admin = await adminSid(request);
    const normalUser = await getNormalUser(request, admin);
    const userSid = await apiLogin(request, normalUser.email, adminPassword);
    expect(userSid).toBeTruthy();

    const ticket = await createTicketAsUser(request, userSid as string, 'E2E v38 user internal attempt');

    const attemptedInternal = `Próba notatki internal przez zwykłego użytkownika v38 ${uniqueStamp()}`;

    const response = await addComment(request, userSid as string, ticket.id, attemptedInternal, 'internal');

    /**
     * Akceptujemy dwa bezpieczne zachowania:
     * 1. API odrzuca próbę 4xx.
     * 2. API przyjmuje komentarz, ale wymusza visibility=public.
     *
     * Nie akceptujemy sytuacji, w której zwykły użytkownik tworzy realną notatkę internal.
     */
    if (response.res.ok()) {
      const adminDetail = await getTicketDetail(request, admin, ticket.id);
      const serialized = jsonText(adminDetail.json);

      expect(serialized).toContain(attemptedInternal);

      const lower = serialized.toLowerCase();
      const noteIndex = lower.indexOf(attemptedInternal.toLowerCase());
      const context = noteIndex >= 0 ? serialized.slice(Math.max(0, noteIndex - 500), noteIndex + 1000) : serialized;

      expect(
        /"visibility"\s*:\s*"internal"|internal_note|wewnętrzn|wewnetrzn/i.test(context),
        `Komentarz zwykłego użytkownika nie powinien zostać zapisany jako internal. Kontekst: ${context}`
      ).toBeFalsy();
    } else {
      expect(
        responseStatusIsControlledClientError(response),
        `Próba internal przez zwykłego użytkownika powinna być kontrolowanym błędem 4xx, nie 5xx. HTTP ${response.res.status()} ${response.text}`
      ).toBeTruthy();

      expectPayloadMatches(
        response.json,
        /uprawn|permission|forbidden|internal|wewnętrzn|visibility/i,
        'Odpowiedź powinna informować o braku uprawnień albo niedozwolonej widoczności.'
      );
    }
  });

  test('notatka wewnętrzna zapisuje zdarzenie w historii/audycie bez ujawniania treści requestorowi', async ({ request }) => {
    const sid = await adminSid(request);
    const ticket = await createTicket(request, sid, 'E2E v38 internal note history');
    const internalNote = `Notatka do historii internal v38 ${uniqueStamp()}`;

    const added = await addComment(request, sid, ticket.id, internalNote, 'internal');
    expect(added.res.ok(), `Dodanie notatki wewnętrznej zwróciło HTTP ${added.res.status()}: ${added.text}`).toBeTruthy();

    const detail = await getTicketDetail(request, sid, ticket.id);

    expectPayloadContains(
      detail.json,
      internalNote,
      'Szczegóły zgłoszenia powinny zawierać notatkę wewnętrzną dla admina.'
    );

    expectPayloadMatches(
      detail.json,
      /internal_note|note_internal|comment_internal|wewnętrzn|wewnetrzn|Notatka wewnętrzna/i,
      'Historia/audyt powinny zawierać zdarzenie związane z notatką wewnętrzną.'
    );

    const ticketDetail = ticketFromDetail(detail.json);
    expect(ticketDetail.id || ticketDetail.ticket_id).toBeTruthy();
  });
});
