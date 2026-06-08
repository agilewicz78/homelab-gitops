import { test, expect, APIRequestContext } from '@playwright/test';

/**
 * helpdesk-sla-reports-v39.spec.ts
 *
 * v39 — SLA + raporty CSV.
 *
 * Zakres:
 * 1. Raport JSON /api/reports zwraca summary i grupy raportowe.
 * 2. Eksport CSV /api/reports.csv zwraca text/csv oraz nagłówek "Raport helpdesk".
 * 3. Zwykły użytkownik nie ma dostępu do raportów/eksportu CSV.
 * 4. Kalendarz SLA /api/sla-calendar zwraca sekcje overdue/today/tomorrow/next_7_days/next_30_days.
 * 5. Polityki SLA /api/sla-policies zwracają priorytety i wartości godzin.
 * 6. Admin może wykonać idempotentny update polityk SLA przez /api/admin/sla-policies.
 * 7. Zwykły użytkownik nie może zmienić polityk SLA.
 * 8. Staff/admin może uruchomić /api/sla/check i otrzymać liczniki powiadomień.
 * 9. Zwykły użytkownik nie może uruchomić /api/sla/check.
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
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów v39.');
  }
}

function jsonText(payload: unknown) {
  return JSON.stringify(payload);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function apiLogin(
  request: APIRequestContext,
  email = adminEmail,
  password = adminPassword
): Promise<string> {
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
  options: { data?: any; headers?: Record<string, string> } = {}
): Promise<ApiResult> {
  const res = await request.fetch(`${baseURL}${path}`, {
    method,
    headers: {
      'X-Helpdesk-Session': sid,
      ...(options.headers || {}),
    },
    data: options.data,
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

async function apiText(
  request: APIRequestContext,
  method: string,
  path: string,
  sid: string
): Promise<{ res: Awaited<ReturnType<APIRequestContext['fetch']>>; text: string }> {
  const res = await request.fetch(`${baseURL}${path}`, {
    method,
    headers: {
      'X-Helpdesk-Session': sid,
    },
  });

  return {
    res,
    text: await res.text(),
  };
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

async function normalUserSid(request: APIRequestContext): Promise<string> {
  const sid = await adminSid(request);
  const normalUser = await getNormalUser(request, sid);
  return apiLogin(request, normalUser.email, adminPassword);
}

function expectControlledForbidden(response: ApiResult | { res: any; text: string }, message: string) {
  const status = response.res.status();
  const text = 'text' in response ? response.text : '';

  expect(
    [401, 403].includes(status),
    `${message}. Oczekiwano 401/403. Odpowiedź: HTTP ${status} ${text}`
  ).toBeTruthy();
}

function expectPayloadHasKeys(payload: any, keys: string[], message: string) {
  for (const key of keys) {
    expect(
      Object.prototype.hasOwnProperty.call(payload, key),
      `${message}. Brakuje klucza: ${key}. Odpowiedź: ${jsonText(payload).slice(0, 3000)}`
    ).toBeTruthy();
  }
}

function expectArray(value: any, message: string) {
  expect(Array.isArray(value), `${message}. Otrzymano: ${jsonText(value).slice(0, 1000)}`).toBeTruthy();
}

function expectNumberLike(value: any, message: string) {
  expect(
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))),
    `${message}. Otrzymano: ${jsonText(value)}`
  ).toBeTruthy();
}

test.describe('Helpdesk E2E v39 — SLA + raporty CSV', () => {
  test('raport JSON /api/reports zwraca summary i grupy raportowe', async ({ request }) => {
    const sid = await adminSid(request);
    const from = daysAgoIso(30);
    const to = todayIso();

    const response = await apiJson(request, 'GET', `/api/reports?from=${from}&to=${to}`, sid);

    expect(
      response.res.ok(),
      `GET /api/reports zwrócił HTTP ${response.res.status()}: ${response.text}`
    ).toBeTruthy();

    expectPayloadHasKeys(response.json, ['date_from', 'date_to', 'summary', 'by_priority', 'by_category', 'by_status', 'by_operator', 'by_day'], 'Raport JSON powinien mieć stabilną strukturę');

    expectPayloadHasKeys(
      response.json.summary,
      ['total_now', 'created', 'resolved', 'open_now', 'overdue_sla_now'],
      'summary raportu powinien mieć liczniki'
    );

    expectArray(response.json.by_priority, 'by_priority powinno być tablicą');
    expectArray(response.json.by_category, 'by_category powinno być tablicą');
    expectArray(response.json.by_status, 'by_status powinno być tablicą');
    expectArray(response.json.by_operator, 'by_operator powinno być tablicą');
    expectArray(response.json.by_day, 'by_day powinno być tablicą');
  });

  test('eksport CSV /api/reports.csv zwraca CSV z nagłówkiem Raport helpdesk', async ({ request }) => {
    const sid = await adminSid(request);
    const from = daysAgoIso(30);
    const to = todayIso();

    const response = await apiText(request, 'GET', `/api/reports.csv?from=${from}&to=${to}`, sid);

    expect(
      response.res.ok(),
      `GET /api/reports.csv zwrócił HTTP ${response.res.status()}: ${response.text.slice(0, 1000)}`
    ).toBeTruthy();

    const contentType = response.res.headers()['content-type'] || '';
    const contentDisposition = response.res.headers()['content-disposition'] || '';

    expect(contentType.toLowerCase()).toContain('text/csv');
    expect(contentDisposition.toLowerCase()).toContain('attachment');
    expect(contentDisposition.toLowerCase()).toContain('helpdesk-raport');
    expect(response.text).toContain('Raport helpdesk');
    expect(response.text).toContain('Podsumowanie');
    expect(response.text).toContain('Trend dzienny');
  });

  test('zwykły użytkownik nie ma dostępu do raportów i eksportu CSV', async ({ request }) => {
    const sid = await normalUserSid(request);

    const report = await apiJson(request, 'GET', '/api/reports', sid);
    expectControlledForbidden(report, 'Zwykły użytkownik nie powinien mieć dostępu do /api/reports');

    const csv = await apiText(request, 'GET', '/api/reports.csv', sid);
    expectControlledForbidden(csv, 'Zwykły użytkownik nie powinien mieć dostępu do /api/reports.csv');
  });

  test('kalendarz SLA /api/sla-calendar zwraca sekcje i liczniki SLA', async ({ request }) => {
    const sid = await adminSid(request);

    const response = await apiJson(request, 'GET', '/api/sla-calendar', sid);

    expect(
      response.res.ok(),
      `GET /api/sla-calendar zwrócił HTTP ${response.res.status()}: ${response.text}`
    ).toBeTruthy();

    expectPayloadHasKeys(
      response.json,
      ['scope', 'overdue', 'today', 'tomorrow', 'next_7_days', 'next_30_days', 'counts', 'policies'],
      'Kalendarz SLA powinien mieć stabilną strukturę'
    );

    for (const key of ['overdue', 'today', 'tomorrow', 'next_7_days', 'next_30_days']) {
      expectArray(response.json[key], `${key} powinno być tablicą`);
    }

    expectPayloadHasKeys(response.json.counts, ['overdue', 'today', 'tomorrow', 'next_7_days', 'next_30_days'], 'counts SLA powinny mieć liczniki sekcji');

    for (const key of ['overdue', 'today', 'tomorrow', 'next_7_days', 'next_30_days']) {
      expectNumberLike(response.json.counts[key], `counts.${key} powinno być liczbą`);
    }

    expectArray(response.json.policies, 'policies powinno być tablicą');
  });

  test('polityki SLA /api/sla-policies zwracają priorytety i wartości godzin', async ({ request }) => {
    const sid = await adminSid(request);

    const response = await apiJson(request, 'GET', '/api/sla-policies', sid);

    expect(
      response.res.ok(),
      `GET /api/sla-policies zwrócił HTTP ${response.res.status()}: ${response.text}`
    ).toBeTruthy();

    expectArray(response.json.policies, 'policies powinno być tablicą');
    expect(response.json.policies.length, `Lista polityk SLA nie powinna być pusta. Odpowiedź: ${response.text}`).toBeGreaterThan(0);

    const priorities = response.json.policies.map((p: any) => p.priority);

    for (const expected of ['Krytyczny', 'Wysoki', 'Normalny', 'Niski']) {
      expect(
        priorities.includes(expected),
        `Polityki SLA powinny zawierać priorytet ${expected}. Priorytety: ${JSON.stringify(priorities)}`
      ).toBeTruthy();
    }

    for (const policy of response.json.policies) {
      expectNumberLike(policy.first_response_hours, `first_response_hours dla ${policy.priority} powinno być liczbą`);
      expectNumberLike(policy.resolution_hours, `resolution_hours dla ${policy.priority} powinno być liczbą`);
      expectNumberLike(policy.warning_hours, `warning_hours dla ${policy.priority} powinno być liczbą`);
    }
  });

  test('admin może wykonać idempotentny update polityk SLA bez zmiany wartości biznesowych', async ({ request }) => {
    const sid = await adminSid(request);
    const before = await apiJson(request, 'GET', '/api/sla-policies', sid);

    expect(before.res.ok(), `Pobranie polityk SLA zwróciło HTTP ${before.res.status()}: ${before.text}`).toBeTruthy();
    expectArray(before.json.policies, 'policies powinno być tablicą');
    expect(before.json.policies.length).toBeGreaterThan(0);

    const policies = before.json.policies.map((policy: any) => ({
      priority: policy.priority,
      first_response_hours: Number(policy.first_response_hours),
      resolution_hours: Number(policy.resolution_hours),
      warning_hours: Number(policy.warning_hours),
    }));

    const update = await apiJson(request, 'POST', '/api/admin/sla-policies', sid, {
      data: { policies },
    });

    expect(
      update.res.ok(),
      `POST /api/admin/sla-policies zwrócił HTTP ${update.res.status()}: ${update.text}`
    ).toBeTruthy();

    expect(update.json.status).toBe('ok');
    expectArray(update.json.updated, 'updated powinno być tablicą');

    for (const policy of policies) {
      expect(
        update.json.updated.includes(policy.priority),
        `updated powinno zawierać ${policy.priority}. Odpowiedź: ${update.text}`
      ).toBeTruthy();
    }
  });

  test('zwykły użytkownik nie może zmienić polityk SLA', async ({ request }) => {
    const sid = await normalUserSid(request);

    const response = await apiJson(request, 'POST', '/api/admin/sla-policies', sid, {
      data: {
        policies: [
          {
            priority: 'Niski',
            first_response_hours: 24,
            resolution_hours: 120,
            warning_hours: 4,
          },
        ],
      },
    });

    expectControlledForbidden(response, 'Zwykły użytkownik nie powinien móc zmienić polityk SLA');
  });

  test('staff/admin może uruchomić ręczne sprawdzenie SLA /api/sla/check', async ({ request }) => {
    const sid = await adminSid(request);

    const response = await apiJson(request, 'POST', '/api/sla/check', sid);

    expect(
      response.res.ok(),
      `POST /api/sla/check zwrócił HTTP ${response.res.status()}: ${response.text}`
    ).toBeTruthy();

    expect(response.json.status).toBe('ok');
    expectPayloadHasKeys(
      response.json.notifications,
      ['first_response_warning', 'first_response_overdue', 'resolution_warning', 'resolution_overdue'],
      'notifications z /api/sla/check powinny mieć liczniki'
    );

    for (const key of ['first_response_warning', 'first_response_overdue', 'resolution_warning', 'resolution_overdue']) {
      expectNumberLike(response.json.notifications[key], `notifications.${key} powinno być liczbą`);
    }
  });

  test('zwykły użytkownik nie może uruchomić ręcznego sprawdzenia SLA', async ({ request }) => {
    const sid = await normalUserSid(request);

    const response = await apiJson(request, 'POST', '/api/sla/check', sid);

    expectControlledForbidden(response, 'Zwykły użytkownik nie powinien móc uruchomić /api/sla/check');
  });
});
