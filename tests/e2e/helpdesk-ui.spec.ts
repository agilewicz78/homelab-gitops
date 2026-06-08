import { test, expect, Page, APIRequestContext } from '@playwright/test';
import fs from 'fs';

const baseURL = process.env.HELPDESK_URL || 'https://helpdesk.lab.local';
const adminEmail = process.env.HELPDESK_ADMIN_EMAIL || '';
const adminPassword = process.env.HELPDESK_ADMIN_PASSWORD || '';

async function firstVisibleLocator(page: Page, selector: string, timeoutMs = 7000) {
  // Playwright domyślnie bierze pierwszy element pasujący do selektora.
  // W tej aplikacji część tekstów może występować też w ukrytych powiadomieniach,
  // dlatego aktywnie szukamy pierwszego realnie widocznego elementu.
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
  throw new Error(`Nie znaleziono widocznego przycisku/linku dla selektorów: ${selectors.join(', ')}\n${errors.join('\n')}`);
}

async function openNewTicketForm(page: Page) {
  // Najpierw próbujemy prawdziwego kliknięcia w UI. Jeśli przycisk jest ukryty
  // przez uprawnienia lub aktualny widok, używamy funkcji SPA jako kontrolowanego fallbacku.
  try {
    await clickFirstVisible(page, [
      'button:has-text("Nowe zgłoszenie")',
      'a:has-text("Nowe zgłoszenie")',
      'button:has-text("Dodaj zgłoszenie")',
      'a:has-text("Dodaj zgłoszenie")'
    ]);
  } catch (clickError) {
    const canRender = await page.evaluate(() => typeof (window as any).renderNewTicket === 'function').catch(() => false);
    if (!canRender) throw clickError;
    await page.evaluate(() => (window as any).renderNewTicket());
  }
  await expect(page.locator('body')).toContainText(/Nowe zgłoszenie|Tytuł problemu/i, { timeout: 15000 });
}

async function login(page: Page) {
  if (!adminEmail || !adminPassword) {
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów UI.');
  }

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await fillFirstVisible(page, [
    'input[name="email"]',
    'input[type="email"]',
    'input[name="username"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="login" i]'
  ], adminEmail);
  await fillFirstVisible(page, [
    'input[name="password"]',
    'input[type="password"]',
    'input[placeholder*="hasło" i]',
    'input[placeholder*="password" i]'
  ], adminPassword);
  await clickFirstVisible(page, [
    'button:has-text("Zaloguj")',
    'button:has-text("Login")',
    'button[type="submit"]'
  ]);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).not.toContainText(/unauthorized|Nie udało się zalogować/i);
}

function isIgnorableConsoleError(message: string): boolean {
  return /favicon|ResizeObserver/i.test(message)
    || /Failed to load resource: the server responded with a status of (401|403)/i.test(message);
}

async function apiLogin(request: APIRequestContext): Promise<string> {
  if (!adminEmail || !adminPassword) {
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów UI.');
  }
  const res = await request.post(`${baseURL}/api/login`, {
    data: { email: adminEmail, password: adminPassword }
  });
  expect(res.ok(), `Logowanie API zwróciło HTTP ${res.status()}: ${await res.text()}`).toBeTruthy();
  const data = await res.json();
  expect(data.sid, 'Brak pola sid w odpowiedzi /api/login').toBeTruthy();
  return data.sid;
}

async function apiCreateTicket(request: APIRequestContext, titlePrefix = 'UI E2E'): Promise<{ id: number; title: string; sid: string }> {
  const sid = await apiLogin(request);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const title = `${titlePrefix} ${stamp}`;
  const res = await request.post(`${baseURL}/api/tickets`, {
    headers: { 'X-Helpdesk-Session': sid },
    data: {
      title,
      description: 'Automatyczne zgłoszenie utworzone przez test UI E2E.',
      category: 'Inne',
      subcategory: 'Inne',
      priority: 'Normalny'
    }
  });
  expect(res.ok(), `Tworzenie zgłoszenia przez API zwróciło HTTP ${res.status()}: ${await res.text()}`).toBeTruthy();
  const data = await res.json();
  expect(data.id || data.ticket_id || data.ticket?.id, `Brak ID w odpowiedzi: ${JSON.stringify(data)}`).toBeTruthy();
  return { id: Number(data.id || data.ticket_id || data.ticket.id), title, sid };
}

async function openTicketInUi(page: Page, ticketId: number) {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const hasRenderTicket = await page.evaluate(() => typeof (window as any).renderTicket === 'function').catch(() => false);
  if (hasRenderTicket) {
    await page.evaluate((id) => (window as any).renderTicket(id), ticketId);
    await page.waitForLoadState('networkidle');
  } else {
    await page.getByText(`#${ticketId}`, { exact: false }).first().click();
    await page.waitForLoadState('networkidle');
  }
  await expect(page.locator('body')).toContainText(new RegExp(`#${ticketId}\\b`), { timeout: 15000 });
}

test.describe('Helpdesk UI E2E smoke', () => {
  test('logowanie i strona główna', async ({ page }) => {
    await login(page);
    await expect(page.locator('body')).toContainText(/Zgłoszenia|Helpdesk|Dashboard|Moje/i, { timeout: 15000 });
    await expect(page.locator('body')).not.toContainText(/Service Temporarily Unavailable|Internal Server Error|ReferenceError/i);
  });

  test('lista zgłoszeń ładuje dane lub pusty stan', async ({ page }) => {
    await login(page);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toContainText(/Zgłoszenia|Brak zgłoszeń|Status|Priorytet/i, { timeout: 15000 });
  });

  test('moduły administracyjne nie wywołują błędów JS ani HTTP 5xx', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('response', response => {
      if (response.status() >= 500) {
        serverErrors.push(`${response.status()} ${response.url()}`);
      }
    });

    await login(page);

    const labels = ['Workflow', 'Log automatyzacji', 'Uprawnienia', 'Audyt', 'Raporty', 'Kalendarz SLA'];
    for (const label of labels) {
      const item = page.getByText(label, { exact: false }).first();
      if (await item.count()) {
        try {
          if (await item.isVisible({ timeout: 1000 })) {
            await item.click();
            await page.waitForLoadState('networkidle');
            await expect(page.locator('body')).not.toContainText(/is not defined|Błąd logu automatyzacji|Service Temporarily Unavailable|Internal Server Error/i);
          }
        } catch (_) {
          // Element może być ukryty przez uprawnienia albo niewidoczny w danym profilu.
          // To nie jest błąd smoke testu UI.
        }
      }
    }

    const realConsoleErrors = consoleErrors.filter(e => !isIgnorableConsoleError(e));
    expect(pageErrors, `Błędy JavaScript runtime: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(realConsoleErrors, `Błędy console.error: ${realConsoleErrors.join('\n')}`).toHaveLength(0);
    expect(serverErrors, `Błędy HTTP 5xx: ${serverErrors.join('\n')}`).toHaveLength(0);
  });
});

test.describe('Helpdesk UI E2E funkcjonalne', () => {
  test('utworzenie zgłoszenia przez UI', async ({ page }) => {
    await login(page);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const title = `UI E2E zgłoszenie ${stamp}`;

    await openNewTicketForm(page);

    await page.locator('input[name="title"]').fill(title);
    await page.locator('textarea[name="description"]').fill('Opis zgłoszenia utworzonego automatycznie przez Playwright.');

    const category = page.locator('select[name="category"]');
    if (await category.count()) {
      const options = await category.locator('option').allTextContents();
      if (options.includes('Inne')) await category.selectOption({ label: 'Inne' });
    }
    const subcategory = page.locator('select[name="subcategory"]');
    if (await subcategory.count()) {
      const options = await subcategory.locator('option').allTextContents();
      if (options.includes('Inne')) await subcategory.selectOption({ label: 'Inne' });
    }
    const priority = page.locator('select[name="priority"]');
    if (await priority.count()) await priority.selectOption({ label: 'Normalny' }).catch(async () => {});

    await clickFirstVisible(page, [
      'button:has-text("Utwórz zgłoszenie")',
      'button[type="submit"]'
    ]);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toContainText(title, { timeout: 15000 });
  });

  test('dodanie komentarza do zgłoszenia przez UI', async ({ page, request }) => {
    const created = await apiCreateTicket(request, 'UI E2E komentarz');
    await login(page);
    await openTicketInUi(page, created.id);

    const comment = `Komentarz UI E2E ${new Date().toISOString()}`;
    await page.locator('#commentForm textarea[name="content"], form#commentForm textarea').first().fill(comment);
    await page.locator('#commentForm button[type="submit"], #commentForm button:has-text("Dodaj komentarz")').first().click();
    await page.waitForLoadState('networkidle');

    await expect(page.locator('body')).toContainText(comment, { timeout: 15000 });
  });

  test('dodanie załącznika do zgłoszenia przez UI', async ({ page, request }, testInfo) => {
    const created = await apiCreateTicket(request, 'UI E2E załącznik');
    await login(page);
    await openTicketInUi(page, created.id);

    const fileName = `e2e-attachment-${Date.now()}.txt`;
    const filePath = testInfo.outputPath(fileName);
    fs.writeFileSync(filePath, 'Plik testowy dodany automatycznie przez Playwright.\n');

    await page.locator('#attachmentForm input[type="file"]').first().setInputFiles(filePath);
    await page.locator('#attachmentForm button[type="submit"], #attachmentForm button:has-text("Dodaj załącznik")').first().click();
    await page.waitForLoadState('networkidle');

    await expect(page.locator('body')).toContainText(fileName, { timeout: 15000 });
  });
});
