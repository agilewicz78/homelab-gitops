import { test, expect, Page, APIRequestContext } from '@playwright/test';
import fs from 'fs';

/**
 * helpdesk-ticket-comments-attachments-v32.spec.ts
 *
 * Etap 3 — testy komentarzy i załączników na zgłoszeniu.
 *
 * Zakres:
 * 1. Dodanie komentarza do zgłoszenia przez UI.
 * 2. Widoczność komentarza po ponownym otwarciu zgłoszenia.
 * 3. Potwierdzenie komentarza przez API.
 * 4. Dodanie załącznika do zgłoszenia przez UI.
 * 5. Widoczność załącznika po ponownym otwarciu zgłoszenia.
 * 6. Potwierdzenie załącznika przez API.
 * 7. Sprawdzenie, że komentarz i załącznik są przypisane do właściwego zgłoszenia.
 *
 * Ten plik jest osobnym plikiem testowym i nie nadpisuje:
 * - tests/e2e/helpdesk-ui.spec.ts
 * - tests/e2e/helpdesk-workflow-regression-v30.spec.ts
 * - tests/e2e/helpdesk-workflow-actions-ui-v31.spec.ts
 */

const baseURL = process.env.HELPDESK_URL || 'https://helpdesk.lab.local';
const adminEmail = process.env.HELPDESK_ADMIN_EMAIL || '';
const adminPassword = process.env.HELPDESK_ADMIN_PASSWORD || '';

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

async function login(page: Page) {
  if (!adminEmail || !adminPassword) {
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów UI.');
  }

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
  await expect(page.locator('body')).not.toContainText(/unauthorized|Nie udało się zalogować/i);
}

async function apiLogin(request: APIRequestContext): Promise<string> {
  if (!adminEmail || !adminPassword) {
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów API/UI.');
  }

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
) {
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

function uniqueStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ticketFromDetail(detail: any) {
  return detail.ticket || detail;
}

async function createTicketByApi(
  request: APIRequestContext,
  sid: string,
  titlePrefix: string
): Promise<{ id: number; title: string }> {
  const stamp = uniqueStamp();
  const title = `${titlePrefix} ${stamp}`;

  const created = await apiJson(request, 'POST', '/api/tickets', sid, {
    data: {
      title,
      description: 'Zgłoszenie testowe dla Etapu 3 E2E — komentarze i załączniki.',
      category: 'Inne',
      subcategory: 'Inne',
      priority: 'Normalny',
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

async function openTicketInUi(page: Page, ticketId: number) {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  /**
   * Aplikacja helpdesk jest SPA i w dotychczasowych testach udostępniała renderTicket().
   * Najpierw używamy tego stabilnego wejścia, a dopiero potem próbujemy kliknięcia po #ID.
   */
  const hasRenderTicket = await page
    .evaluate(() => typeof (window as any).renderTicket === 'function')
    .catch(() => false);

  if (hasRenderTicket) {
    await page.evaluate((id) => (window as any).renderTicket(id), ticketId);
    await page.waitForLoadState('networkidle');
  } else {
    await page.getByText(`#${ticketId}`, { exact: false }).first().click();
    await page.waitForLoadState('networkidle');
  }

  await expect(page.locator('body')).toContainText(new RegExp(`#${ticketId}\\b`), {
    timeout: 15000,
  });
}

async function reopenTicketInUi(page: Page, ticketId: number) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const hasRenderTicket = await page
    .evaluate(() => typeof (window as any).renderTicket === 'function')
    .catch(() => false);

  if (hasRenderTicket) {
    await page.evaluate((id) => (window as any).renderTicket(id), ticketId);
    await page.waitForLoadState('networkidle');
  }

  await expect(page.locator('body')).toContainText(new RegExp(`#${ticketId}\\b`), {
    timeout: 15000,
  });
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

  await expect(page.locator('body')).toContainText(comment, {
    timeout: 15000,
  });
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

  await expect(page.locator('body')).toContainText(fileName, {
    timeout: 15000,
  });
}

async function getTicketDetail(request: APIRequestContext, sid: string, ticketId: number) {
  const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);

  expect(
    detail.res.ok(),
    `Pobranie szczegółów zgłoszenia #${ticketId} zwróciło HTTP ${detail.res.status()}: ${detail.text}`
  ).toBeTruthy();

  return detail.json;
}

function findTextInUnknownPayload(payload: any, expectedText: string): boolean {
  return JSON.stringify(payload).includes(expectedText);
}

function findFileNameInUnknownPayload(payload: any, expectedFileName: string): boolean {
  return JSON.stringify(payload).includes(expectedFileName);
}

test.describe('Helpdesk E2E v32 — Etap 3 komentarze i załączniki na zgłoszeniu', () => {
  test('dodaje komentarz przez UI i komentarz pozostaje widoczny po ponownym otwarciu zgłoszenia', async ({ page, request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicketByApi(request, sid, 'E2E v32 komentarz UI');
    const comment = `Komentarz E2E v32 — trwałość po odświeżeniu — ${uniqueStamp()}`;

    await login(page);
    await openTicketInUi(page, ticket.id);

    await addCommentInUi(page, comment);

    await reopenTicketInUi(page, ticket.id);

    await expect(page.locator('body')).toContainText(comment, {
      timeout: 15000,
    });

    const detail = await getTicketDetail(request, sid, ticket.id);

    expect(
      findTextInUnknownPayload(detail, comment),
      `Komentarz powinien być widoczny w odpowiedzi API /api/tickets/${ticket.id}. Odpowiedź: ${JSON.stringify(detail).slice(0, 2000)}`
    ).toBeTruthy();
  });

  test('dodaje załącznik przez UI i załącznik pozostaje widoczny po ponownym otwarciu zgłoszenia', async ({ page, request }, testInfo) => {
    const sid = await apiLogin(request);
    const ticket = await createTicketByApi(request, sid, 'E2E v32 załącznik UI');
    const fileName = `e2e-v32-attachment-${Date.now()}.txt`;
    const filePath = testInfo.outputPath(fileName);

    fs.writeFileSync(
      filePath,
      `Załącznik E2E v32 przypisany do zgłoszenia #${ticket.id}\n`
    );

    await login(page);
    await openTicketInUi(page, ticket.id);

    await addAttachmentInUi(page, filePath, fileName);

    await reopenTicketInUi(page, ticket.id);

    await expect(page.locator('body')).toContainText(fileName, {
      timeout: 15000,
    });

    const detail = await getTicketDetail(request, sid, ticket.id);

    expect(
      findFileNameInUnknownPayload(detail, fileName),
      `Załącznik powinien być widoczny w odpowiedzi API /api/tickets/${ticket.id}. Odpowiedź: ${JSON.stringify(detail).slice(0, 2000)}`
    ).toBeTruthy();
  });

  test('komentarz i załącznik są przypisane do właściwego zgłoszenia', async ({ page, request }, testInfo) => {
    const sid = await apiLogin(request);

    const ticketA = await createTicketByApi(request, sid, 'E2E v32 powiązanie A');
    const ticketB = await createTicketByApi(request, sid, 'E2E v32 powiązanie B');

    const commentA = `Komentarz tylko dla zgłoszenia A — E2E v32 — ${uniqueStamp()}`;
    const fileNameA = `e2e-v32-ticket-a-${Date.now()}.txt`;
    const filePathA = testInfo.outputPath(fileNameA);

    fs.writeFileSync(
      filePathA,
      `Załącznik tylko dla zgłoszenia A #${ticketA.id}\n`
    );

    await login(page);
    await openTicketInUi(page, ticketA.id);

    await addCommentInUi(page, commentA);
    await addAttachmentInUi(page, filePathA, fileNameA);

    await reopenTicketInUi(page, ticketA.id);

    await expect(page.locator('body')).toContainText(commentA, {
      timeout: 15000,
    });
    await expect(page.locator('body')).toContainText(fileNameA, {
      timeout: 15000,
    });

    await openTicketInUi(page, ticketB.id);

    await expect(page.locator('body')).not.toContainText(commentA);
    await expect(page.locator('body')).not.toContainText(fileNameA);

    const detailA = await getTicketDetail(request, sid, ticketA.id);
    const detailB = await getTicketDetail(request, sid, ticketB.id);

    expect(findTextInUnknownPayload(detailA, commentA)).toBeTruthy();
    expect(findFileNameInUnknownPayload(detailA, fileNameA)).toBeTruthy();

    expect(
      findTextInUnknownPayload(detailB, commentA),
      `Komentarz z ticketA nie powinien występować w ticketB. Odpowiedź ticketB: ${JSON.stringify(detailB).slice(0, 2000)}`
    ).toBeFalsy();

    expect(
      findFileNameInUnknownPayload(detailB, fileNameA),
      `Załącznik z ticketA nie powinien występować w ticketB. Odpowiedź ticketB: ${JSON.stringify(detailB).slice(0, 2000)}`
    ).toBeFalsy();

    /**
     * Dodatkowo upewniamy się, że oba zgłoszenia nadal istnieją i nie pomyliliśmy widoków.
     */
    expect(ticketFromDetail(detailA).id || ticketFromDetail(detailA).ticket_id).toBeTruthy();
    expect(ticketFromDetail(detailB).id || ticketFromDetail(detailB).ticket_id).toBeTruthy();
  });
});
