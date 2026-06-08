import { test, expect, Page, APIRequestContext } from '@playwright/test';
import fs from 'fs';

/**
 * helpdesk-smoke-v34.spec.ts
 *
 * Etap 5 — pełny smoke test aplikacji helpdesk.
 *
 * Cel:
 * Szybko potwierdzić, że główne ścieżki aplikacji działają po wdrożeniu:
 * - logowanie,
 * - dashboard/lista zgłoszeń,
 * - utworzenie zgłoszenia przez API,
 * - otwarcie zgłoszenia w UI,
 * - dodanie komentarza,
 * - dodanie załącznika,
 * - zmiana statusu,
 * - podstawowy dostęp do administracji workflow,
 * - brak krytycznych błędów w UI.
 *
 * Ten plik nie zastępuje szczegółowych testów v30-v33.
 * Jest szybkim smoke testem po wdrożeniu ConfigMapa/aplikacji.
 */

const baseURL = process.env.HELPDESK_URL || 'https://helpdesk.lab.local';
const adminEmail = process.env.HELPDESK_ADMIN_EMAIL || '';
const adminPassword = process.env.HELPDESK_ADMIN_PASSWORD || '';

type ApiResult = {
  res: Awaited<ReturnType<APIRequestContext['fetch']>>;
  json: any;
  text: string;
};

function requireAdminCredentials() {
  if (!adminEmail || !adminPassword) {
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem smoke testu.');
  }
}

function uniqueStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function firstVisibleLocator(page: Page, selector: string, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;

  while (Date.now() < deadline) {
    const locator = page.locator(selector);
    lastCount = await locator.count().catch(() => 0);

    for (let i = 0; i < lastCount; i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }

    await page.waitForTimeout(200);
  }

  throw new Error(`${selector}: nie znaleziono widocznego elementu; liczba dopasowań: ${lastCount}`);
}

async function fillFirstVisible(page: Page, selectors: string[], value: string) {
  const errors: string[] = [];

  for (const selector of selectors) {
    try {
      const locator = await firstVisibleLocator(page, selector);
      await locator.fill(value);
      return;
    } catch (err: any) {
      errors.push(`${selector}: ${err?.message || err}`);
    }
  }

  throw new Error(`Nie znaleziono widocznego pola dla selektorów: ${selectors.join(', ')}\n${errors.join('\n')}`);
}

async function clickFirstVisible(page: Page, selectors: string[]) {
  const errors: string[] = [];

  for (const selector of selectors) {
    try {
      const locator = await firstVisibleLocator(page, selector);
      await locator.scrollIntoViewIfNeeded();
      await locator.click();
      return;
    } catch (err: any) {
      errors.push(`${selector}: ${err?.message || err}`);
    }
  }

  throw new Error(`Nie znaleziono widocznego elementu dla selektorów: ${selectors.join(', ')}\n${errors.join('\n')}`);
}

async function loginUi(page: Page) {
  requireAdminCredentials();

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });

  await page.evaluate(() => {
    try {
      sessionStorage.clear();
      localStorage.clear();
    } catch (_) {}
  }).catch(() => undefined);

  await fillFirstVisible(page, [
    'input[name="email"]',
    'input[type="email"]',
    'input[name="username"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="login" i]',
  ], adminEmail);

  await fillFirstVisible(page, [
    'input[name="password"]',
    'input[type="password"]',
    'input[placeholder*="hasło" i]',
    'input[placeholder*="password" i]',
  ], adminPassword);

  await clickFirstVisible(page, [
    'button:has-text("Zaloguj")',
    'button:has-text("Login")',
    'button[type="submit"]',
  ]);

  await page.waitForLoadState('networkidle');

  await expect(page.locator('body')).toContainText(/Zalogowany|Dashboard|Lista zgłoszeń|Workflow|Raporty/i, {
    timeout: 15000,
  });

  await expect(page.locator('body')).not.toContainText(/unauthorized|Nie udało się zalogować|Błąd logowania/i);

  const criticalErrors = consoleErrors.filter((message) =>
    /uncaught|typeerror|referenceerror|syntaxerror|failed to fetch|500|internal server/i.test(message)
  );

  expect(
    criticalErrors,
    `Po logowaniu nie powinno być krytycznych błędów JS/API. Błędy: ${criticalErrors.join('\n')}`
  ).toEqual([]);
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

function ticketFromDetail(detail: any) {
  return detail.ticket || detail;
}

async function createTicketByApi(
  request: APIRequestContext,
  sid: string,
  titlePrefix: string
): Promise<{ id: number; title: string; oldStatus: string; targetStatus: string }> {
  const title = `${titlePrefix} ${uniqueStamp()}`;

  const created = await apiJson(request, 'POST', '/api/tickets', sid, {
    data: {
      title,
      description: 'Zgłoszenie smoke test E2E v34.',
      category: 'Inne',
      subcategory: 'Inne',
      priority: 'Niski',
    },
  });

  expect(
    created.res.ok(),
    `Tworzenie zgłoszenia smoke test zwróciło HTTP ${created.res.status()}: ${created.text}`
  ).toBeTruthy();

  const ticketId = Number(created.json.id || created.json.ticket_id || created.json.ticket?.id);
  expect(ticketId, `Brak ID zgłoszenia w odpowiedzi: ${created.text}`).toBeTruthy();

  const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);
  expect(
    detail.res.ok(),
    `Pobranie zgłoszenia #${ticketId} zwróciło HTTP ${detail.res.status()}: ${detail.text}`
  ).toBeTruthy();

  const ticket = ticketFromDetail(detail.json);
  const oldStatus = ticket.status || 'Nowe';
  const statuses: string[] = detail.json.meta?.statuses || ['Nowe', 'W trakcie'];
  const targetStatus =
    statuses.find((status) => status !== oldStatus && !/zamknięte|closed/i.test(status)) ||
    statuses.find((status) => status !== oldStatus) ||
    oldStatus;

  return {
    id: ticketId,
    title,
    oldStatus,
    targetStatus,
  };
}

async function openTicketInUi(page: Page, ticketId: number, title?: string) {
  const hasRenderTicket = await page
    .evaluate(() => typeof (window as any).renderTicket === 'function')
    .catch(() => false);

  if (hasRenderTicket) {
    await page.evaluate((id) => (window as any).renderTicket(id), ticketId);
    await page.waitForLoadState('networkidle');
  } else {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.getByText(`#${ticketId}`, { exact: false }).first().click();
    await page.waitForLoadState('networkidle');
  }

  await expect(page.locator('body')).toContainText(new RegExp(`#${ticketId}\\b`), {
    timeout: 15000,
  });

  if (title) {
    await expect(page.locator('body')).toContainText(title, {
      timeout: 15000,
    });
  }
}

async function addCommentInUi(page: Page, comment: string) {
  await fillFirstVisible(page, [
    '#commentForm textarea[name="content"]',
    'form#commentForm textarea',
    'textarea[name="content"]',
    'textarea[placeholder*="komentarz" i]',
    'textarea[placeholder*="comment" i]',
  ], comment);

  await clickFirstVisible(page, [
    '#commentForm button[type="submit"]',
    '#commentForm button:has-text("Dodaj komentarz")',
    'button:has-text("Dodaj komentarz")',
    'button:has-text("Zapisz komentarz")',
    'button:has-text("Add comment")',
  ]);

  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).toContainText(comment, { timeout: 15000 });
}

async function addAttachmentInUi(page: Page, filePath: string, fileName: string) {
  const input = await firstVisibleLocator(page, [
    '#attachmentForm input[type="file"]',
    'form#attachmentForm input[type="file"]',
    'input[type="file"]',
  ].join(', '));

  await input.setInputFiles(filePath);

  await clickFirstVisible(page, [
    '#attachmentForm button[type="submit"]',
    '#attachmentForm button:has-text("Dodaj załącznik")',
    'button:has-text("Dodaj załącznik")',
    'button:has-text("Dodaj plik")',
    'button:has-text("Wyślij plik")',
    'button:has-text("Upload")',
  ]);

  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).toContainText(fileName, { timeout: 15000 });
}

async function changeStatusByApi(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  targetStatus: string
) {
  const response = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, {
    data: {
      status: targetStatus,
    },
  });

  expect(
    response.res.ok(),
    `Zmiana statusu zgłoszenia #${ticketId} na "${targetStatus}" zwróciła HTTP ${response.res.status()}: ${response.text}`
  ).toBeTruthy();
}

async function assertTicketContainsByApi(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  expectedValues: string[]
) {
  const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);

  expect(
    detail.res.ok(),
    `Pobranie zgłoszenia #${ticketId} po operacjach smoke zwróciło HTTP ${detail.res.status()}: ${detail.text}`
  ).toBeTruthy();

  const body = JSON.stringify(detail.json);

  for (const expected of expectedValues) {
    expect(
      body.includes(expected),
      `Odpowiedź API /api/tickets/${ticketId} powinna zawierać "${expected}". Fragment: ${body.slice(0, 2000)}`
    ).toBeTruthy();
  }
}

async function openWorkflowAdmin(page: Page) {
  try {
    await clickFirstVisible(page, [
      'a:has-text("Workflow")',
      'button:has-text("Workflow")',
      'text=Workflow',
    ]);
  } catch (clickError) {
    const canRender = await page
      .evaluate(() => typeof (window as any).renderAdminWorkflows === 'function')
      .catch(() => false);

    if (!canRender) throw clickError;

    await page.evaluate(() => (window as any).renderAdminWorkflows());
  }

  await page.waitForLoadState('networkidle');

  await expect(page.locator('body')).toContainText(/Definicje workflow|Workflow zgłoszeń|Automatyzacje|Log automatyzacji/i, {
    timeout: 15000,
  });
}

async function assertNoCriticalUiErrors(page: Page) {
  const body = await page.locator('body').innerText({ timeout: 15000 });

  expect(body).not.toMatch(/Traceback|Internal Server Error|Unhandled|ReferenceError|TypeError/i);
  expect(body).not.toMatch(/Nie udało się pobrać danych|Błąd krytyczny/i);
}

test.describe('Helpdesk E2E v34 — Etap 5 pełny smoke test aplikacji', () => {
  test('smoke: logowanie, zgłoszenie, komentarz, załącznik, status, workflow admin', async ({ page, request }, testInfo) => {
    const sid = await apiLogin(request);
    const ticket = await createTicketByApi(request, sid, 'E2E v34 smoke');

    const comment = `Komentarz smoke E2E v34 ${uniqueStamp()}`;
    const fileName = `e2e-v34-smoke-${Date.now()}.txt`;
    const filePath = testInfo.outputPath(fileName);

    fs.writeFileSync(filePath, `Załącznik smoke E2E v34 dla zgłoszenia #${ticket.id}\n`);

    await loginUi(page);

    await openTicketInUi(page, ticket.id, ticket.title);

    await addCommentInUi(page, comment);

    await addAttachmentInUi(page, filePath, fileName);

    if (ticket.targetStatus !== ticket.oldStatus) {
      await changeStatusByApi(request, sid, ticket.id, ticket.targetStatus);

      await openTicketInUi(page, ticket.id, ticket.title);

      await expect(page.locator('body')).toContainText(ticket.targetStatus, {
        timeout: 15000,
      });
    }

    await assertTicketContainsByApi(request, sid, ticket.id, [
      ticket.title,
      comment,
      fileName,
    ]);

    await openWorkflowAdmin(page);

    await expect(page.locator('body')).toContainText(/Standardowy workflow|default|Definicje workflow/i, {
      timeout: 15000,
    });

    await assertNoCriticalUiErrors(page);
  });

  test('smoke API: podstawowe endpointy helpdesku odpowiadają poprawnie', async ({ request }) => {
    const sid = await apiLogin(request);

    const workflows = await apiJson(request, 'GET', '/api/admin/workflows', sid);
    expect(workflows.res.ok(), `GET /api/admin/workflows -> HTTP ${workflows.res.status()}: ${workflows.text}`).toBeTruthy();
    expect(JSON.stringify(workflows.json)).toMatch(/workflow|default|workflows/i);

    const tickets = await apiJson(request, 'GET', '/api/tickets', sid);
    expect(tickets.res.ok(), `GET /api/tickets -> HTTP ${tickets.res.status()}: ${tickets.text}`).toBeTruthy();
    expect(JSON.stringify(tickets.json)).toMatch(/ticket|tickets|zgłosz|zglosz|items|data/i);

    const created = await createTicketByApi(request, sid, 'E2E v34 smoke API');
    const detail = await apiJson(request, 'GET', `/api/tickets/${created.id}`, sid);

    expect(detail.res.ok(), `GET /api/tickets/${created.id} -> HTTP ${detail.res.status()}: ${detail.text}`).toBeTruthy();
    expect(JSON.stringify(detail.json)).toContain(created.title);
  });
});
