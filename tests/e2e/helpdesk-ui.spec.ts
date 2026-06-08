import { test, expect, Page, APIRequestContext } from '@playwright/test';
import fs from 'fs';

const baseURL = process.env.HELPDESK_URL || 'https://helpdesk.lab.local';
const adminEmail = process.env.HELPDESK_ADMIN_EMAIL || '';
const adminPassword = process.env.HELPDESK_ADMIN_PASSWORD || '';
const operatorEmail = process.env.HELPDESK_OPERATOR_EMAIL || '';
const operatorPassword = process.env.HELPDESK_OPERATOR_PASSWORD || '';
const normalUserEmail = process.env.HELPDESK_USER_EMAIL || '';
const normalUserPassword = process.env.HELPDESK_USER_PASSWORD || '';

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

async function loginAs(page: Page, email: string, password: string) {
  if (!email || !password) {
    throw new Error('Brakuje e-maila lub hasła użytkownika testowego.');
  }

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try { sessionStorage.clear(); localStorage.clear(); } catch (_) {}
  }).catch(() => undefined);
  await fillFirstVisible(page, [
    'input[name="email"]',
    'input[type="email"]',
    'input[name="username"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="login" i]'
  ], email);
  await fillFirstVisible(page, [
    'input[name="password"]',
    'input[type="password"]',
    'input[placeholder*="hasło" i]',
    'input[placeholder*="password" i]'
  ], password);
  await clickFirstVisible(page, [
    'button:has-text("Zaloguj")',
    'button:has-text("Login")',
    'button[type="submit"]'
  ]);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).not.toContainText(/unauthorized|Nie udało się zalogować/i);
}

async function login(page: Page) {
  if (!adminEmail || !adminPassword) {
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów UI.');
  }
  await loginAs(page, adminEmail, adminPassword);
}

function isIgnorableConsoleError(message: string): boolean {
  return /favicon|ResizeObserver/i.test(message)
    || /Failed to load resource: the server responded with a status of (401|403)/i.test(message);
}

async function apiLoginWith(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post(`${baseURL}/api/login`, {
    data: { email, password }
  });
  expect(res.ok(), `Logowanie API ${email} zwróciło HTTP ${res.status()}: ${await res.text()}`).toBeTruthy();
  const data = await res.json();
  expect(data.sid, 'Brak pola sid w odpowiedzi /api/login').toBeTruthy();
  return data.sid;
}

async function apiLogin(request: APIRequestContext): Promise<string> {
  if (!adminEmail || !adminPassword) {
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów UI.');
  }
  return apiLoginWith(request, adminEmail, adminPassword);
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



async function apiJson(request: APIRequestContext, method: string, path: string, sid: string, options: any = {}) {
  const res = await request.fetch(`${baseURL}${path}`, {
    method,
    headers: { 'X-Helpdesk-Session': sid, ...(options.headers || {}) },
    data: options.data,
    multipart: options.multipart,
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { res, json, text };
}

function ticketFromDetail(detail: any) {
  return detail.ticket || detail;
}

function directPermissionsForRole(payload: any, roleKey: string): string[] {
  const role = (payload.roles || []).find((r: any) => r.key === roleKey || r.role_key === roleKey);
  return Array.from(new Set(role?.direct_permission_codes || role?.permission_codes || [])).sort() as string[];
}

async function firstVisibleCount(page: Page, selector: string): Promise<number> {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  let visible = 0;
  for (let i = 0; i < count; i++) {
    if (await locator.nth(i).isVisible().catch(() => false)) visible++;
  }
  return visible;
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


test.describe('Helpdesk E2E procesy workflow i uprawnień', () => {
  test('workflow blokuje zmianę statusu bez nowego komentarza i załącznika operatora', async ({ request }) => {
    const sid = await apiLogin(request);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    // Tworzymy testowe zgłoszenie o priorytecie Niski, aby tymczasowa reguła
    // była jak najwęziej ograniczona i nie wpływała na zwykłe zgłoszenia.
    const created = await apiJson(request, 'POST', '/api/tickets', sid, {
      data: {
        title: `E2E workflow validation ${stamp}`,
        description: 'Zgłoszenie testujące wymagany komentarz i załącznik przy zmianie statusu.',
        category: 'Inne',
        subcategory: 'Inne',
        priority: 'Niski'
      }
    });
    expect(created.res.ok(), `Tworzenie zgłoszenia testowego -> HTTP ${created.res.status()}: ${created.text}`).toBeTruthy();
    const ticketId = Number(created.json.id || created.json.ticket_id || created.json.ticket?.id);
    expect(ticketId, `Brak ID zgłoszenia w odpowiedzi: ${created.text}`).toBeTruthy();

    const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);
    expect(detail.res.ok(), `Szczegóły zgłoszenia #${ticketId} -> HTTP ${detail.res.status()}: ${detail.text}`).toBeTruthy();
    const ticket = ticketFromDetail(detail.json);
    const oldStatus = ticket.status;
    const statuses: string[] = detail.json.meta?.statuses || [];
    const targetStatus = statuses.find(s => s !== oldStatus && s !== 'Zamknięte');
    expect(targetStatus, `Nie znaleziono statusu docelowego innego niż ${oldStatus}`).toBeTruthy();

    const workflowsResponse = await apiJson(request, 'GET', '/api/admin/workflows', sid);
    expect(workflowsResponse.res.ok(), `Lista workflow -> HTTP ${workflowsResponse.res.status()}: ${workflowsResponse.text}`).toBeTruthy();
    const workflows = workflowsResponse.json.workflows || [];
    const workflow = workflows.find((w: any) => w.workflow_key === ticket.workflow_key) || workflows.find((w: any) => w.is_default) || workflows[0];
    expect(workflow?.id, `Nie znaleziono workflow dla zgłoszenia #${ticketId}`).toBeTruthy();

    let automationId: number | undefined;
    try {
      const automationPayload = {
        name: `E2E wymaga komentarza i załącznika ${stamp}`,
        event_type: 'status_changed',
        // Brak condition_status oznacza dowolny status źródłowy.
        // Nie używamy '*', bo API waliduje status źródłowy względem listy statusów workflow.
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
        action_type: 'require_comment',
        action_status: '',
        actions: [
          { action_order: 1, action_type: 'require_comment', action_value: null, is_active: true },
          { action_order: 2, action_type: 'require_attachment', action_value: null, is_active: true }
        ],
        is_active: true,
        stop_processing: true,
        priority: 1
      };
      const rule = await apiJson(request, 'POST', `/api/admin/workflows/${workflow.id}/automations`, sid, { data: automationPayload });
      expect(rule.res.ok(), `Utworzenie reguły workflow -> HTTP ${rule.res.status()}: ${rule.text}`).toBeTruthy();
      automationId = Number(rule.json.id || rule.json.automation_id);
      expect(automationId, `Brak ID reguły workflow w odpowiedzi: ${rule.text}`).toBeTruthy();

      const noRequirements = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, { data: { status: targetStatus } });
      expect(noRequirements.res.status(), `Zmiana statusu bez komentarza i załącznika powinna zwrócić 409, zwróciła ${noRequirements.res.status()}: ${noRequirements.text}`).toBe(409);
      expect(JSON.stringify(noRequirements.json)).toMatch(/comment|komentarz/i);
      expect(JSON.stringify(noRequirements.json)).toMatch(/attachment|załącznik/i);

      const comment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/comments`, sid, {
        data: { content: `Komentarz wymagany przez E2E ${stamp}`, visibility: 'public' }
      });
      expect(comment.res.ok(), `Dodanie komentarza -> HTTP ${comment.res.status()}: ${comment.text}`).toBeTruthy();

      // Dodanie komentarza może w tej aplikacji uruchomić inne istniejące reguły workflow,
      // np. automatyczne przejście z „Nowe” do „W trakcie”. Dlatego reguła E2E
      // ma pusty źródłowy status, czyli pasuje do dowolnego statusu; po komentarzu dodajemy jeszcze jeden
      // komentarz w aktualnym statusie, aby warunek „komentarz w obecnym statusie”
      // był spełniony niezależnie od automatycznych przejść.
      const afterCommentDetail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);
      const currentAfterComment = ticketFromDetail(afterCommentDetail.json).status;
      if (currentAfterComment !== targetStatus) {
        const currentComment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/comments`, sid, {
          data: { content: `Komentarz w aktualnym statusie E2E ${stamp}`, visibility: 'public' }
        });
        expect(currentComment.res.ok(), `Dodanie komentarza w aktualnym statusie -> HTTP ${currentComment.res.status()}: ${currentComment.text}`).toBeTruthy();
      }

      const onlyComment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, { data: { status: targetStatus } });
      expect(onlyComment.res.status(), `Zmiana statusu tylko z komentarzem powinna zwrócić 409, zwróciła ${onlyComment.res.status()}: ${onlyComment.text}`).toBe(409);
      expect(JSON.stringify(onlyComment.json)).toMatch(/attachment|załącznik/i);

      const attachment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/attachments`, sid, {
        multipart: {
          file: {
            name: `e2e-workflow-${stamp}.txt`,
            mimeType: 'text/plain',
            buffer: Buffer.from('Załącznik wymagany przez E2E workflow.\n')
          }
        }
      });
      expect(attachment.res.ok(), `Dodanie załącznika -> HTTP ${attachment.res.status()}: ${attachment.text}`).toBeTruthy();

      const ok = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, { data: { status: targetStatus } });
      expect(ok.res.ok(), `Zmiana statusu po komentarzu i załączniku powinna przejść, HTTP ${ok.res.status()}: ${ok.text}`).toBeTruthy();

      const after = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);
      expect(ticketFromDetail(after.json).status).toBe(targetStatus);
    } finally {
      if (automationId) {
        await apiJson(request, 'DELETE', `/api/admin/workflows/${workflow.id}/automations/${automationId}`, sid).catch(() => undefined);
      }
    }
  });

  test('dynamiczne menu ukrywa Kalendarz SLA po odebraniu uprawnienia operatorowi', async ({ page, request }) => {
    const operatorEmail = process.env.HELPDESK_OPERATOR_EMAIL || '';
    const operatorPassword = process.env.HELPDESK_OPERATOR_PASSWORD || '';
    test.skip(!operatorEmail || !operatorPassword, 'Ustaw HELPDESK_OPERATOR_EMAIL i HELPDESK_OPERATOR_PASSWORD, aby testować dynamiczne menu operatora.');

    const sid = await apiLogin(request);
    const before = await apiJson(request, 'GET', '/api/admin/permissions', sid);
    expect(before.res.ok(), `Pobranie uprawnień -> HTTP ${before.res.status()}: ${before.text}`).toBeTruthy();
    const originalOperatorDirect = directPermissionsForRole(before.json, 'operator');
    const originalUserDirect = directPermissionsForRole(before.json, 'user');
    expect(originalOperatorDirect.length, 'Nie udało się odczytać bezpośrednich uprawnień roli operator.').toBeGreaterThan(0);
    expect(originalUserDirect.length, 'Nie udało się odczytać bezpośrednich uprawnień roli user.').toBeGreaterThan(0);

    // Operator dziedziczy po roli user, więc aby wiarygodnie sprawdzić znikanie menu,
    // tymczasowo zdejmujemy SLA z obu ról i zawsze przywracamy oryginał w finally.
    const withoutSlaOperator = originalOperatorDirect.filter(code => code !== 'sla.view' && code !== 'sla.manage');
    const withoutSlaUser = originalUserDirect.filter(code => code !== 'sla.view' && code !== 'sla.manage');
    try {
      const updateUser = await apiJson(request, 'POST', '/api/admin/permissions', sid, {
        data: { role_key: 'user', permission_codes: withoutSlaUser }
      });
      expect(updateUser.res.ok(), `Odebranie userowi SLA -> HTTP ${updateUser.res.status()}: ${updateUser.text}`).toBeTruthy();

      const updateOperator = await apiJson(request, 'POST', '/api/admin/permissions', sid, {
        data: { role_key: 'operator', permission_codes: withoutSlaOperator }
      });
      expect(updateOperator.res.ok(), `Odebranie operatorowi SLA -> HTTP ${updateOperator.res.status()}: ${updateOperator.text}`).toBeTruthy();

      const operatorSid = await apiLoginWith(request, operatorEmail, operatorPassword);
      const operatorPerms = await apiJson(request, 'GET', '/api/permissions/me', operatorSid);
      const effectivePermissions: string[] = operatorPerms.json.permissions || operatorPerms.json.permission_codes || [];
      test.skip(effectivePermissions.includes('sla.view') || effectivePermissions.includes('sla.manage'),
        'Konto operatora nadal ma efektywne uprawnienia SLA, prawdopodobnie przez dodatkową rolę. Użyj czystego konta z rolą operator.');

      await loginAs(page, operatorEmail, operatorPassword);
      await page.waitForLoadState('networkidle');
      await expect.poll(async () => firstVisibleCount(page, 'a:has-text("Kalendarz SLA"), button:has-text("Kalendarz SLA")'), {
        message: 'Kalendarz SLA powinien zniknąć z menu operatora po odebraniu sla.view/sla.manage',
        timeout: 10000,
      }).toBe(0);
    } finally {
      await apiJson(request, 'POST', '/api/admin/permissions', sid, {
        data: { role_key: 'operator', permission_codes: originalOperatorDirect }
      }).catch(() => undefined);
      await apiJson(request, 'POST', '/api/admin/permissions', sid, {
        data: { role_key: 'user', permission_codes: originalUserDirect }
      }).catch(() => undefined);
    }
  });
});

function isoDateDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function parseHelpdeskDate(value: string): Date {
  // Daty z API PostgreSQL przychodzą zwykle jako "YYYY-MM-DD HH:mm:ss" bez strefy.
  // Do porównań różnic godzinowych wystarczy konsekwentnie parsować oba pola tak samo.
  const normalized = String(value || '').trim().replace(' ', 'T');
  const parsed = new Date(normalized);
  expect(Number.isNaN(parsed.getTime()), `Nie można sparsować daty helpdesku: ${value}`).toBeFalsy();
  return parsed;
}

function hoursBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 1000 / 3600;
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function openModule(page: Page, label: string, fallbackFunctionName?: string) {
  try {
    await clickFirstVisible(page, [
      `a:has-text("${label}")`,
      `button:has-text("${label}")`,
      `text=${label}`
    ]);
  } catch (clickError) {
    if (!fallbackFunctionName) throw clickError;
    const canRender = await page.evaluate((fn) => typeof (window as any)[fn] === 'function', fallbackFunctionName).catch(() => false);
    if (!canRender) throw clickError;
    await page.evaluate((fn) => (window as any)[fn](), fallbackFunctionName);
  }
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

test.describe('Helpdesk E2E SLA, raporty i audyt', () => {
  test('API raportów zwraca dane i eksport CSV', async ({ request }) => {
    const sid = await apiLogin(request);
    const from = isoDateDaysAgo(30);
    const to = isoDateDaysAgo(0);

    const report = await apiJson(request, 'GET', `/api/reports?from=${from}&to=${to}`, sid);
    expect(report.res.ok(), `GET /api/reports -> HTTP ${report.res.status()}: ${report.text}`).toBeTruthy();
    expect(report.json.summary, `Raport nie zawiera summary: ${report.text}`).toBeTruthy();
    expect(Array.isArray(report.json.by_status), 'Raport powinien zawierać by_status jako tablicę.').toBeTruthy();
    expect(Array.isArray(report.json.by_day), 'Raport powinien zawierać by_day jako tablicę.').toBeTruthy();

    const csv = await request.get(`${baseURL}/api/reports.csv?from=${from}&to=${to}`, {
      headers: { 'X-Helpdesk-Session': sid }
    });
    const csvText = await csv.text();
    expect(csv.ok(), `GET /api/reports.csv -> HTTP ${csv.status()}: ${csvText.slice(0, 500)}`).toBeTruthy();
    expect(csvText, 'CSV raportów powinien zawierać nagłówek raportu.').toMatch(/Raport helpdesk|Podsumowanie/i);
  });

  test('API kalendarza SLA i ręczne sprawdzenie SLA działają', async ({ request }) => {
    const sid = await apiLogin(request);

    const calendar = await apiJson(request, 'GET', '/api/sla-calendar', sid);
    expect(calendar.res.ok(), `GET /api/sla-calendar -> HTTP ${calendar.res.status()}: ${calendar.text}`).toBeTruthy();
    expect(calendar.json.counts, `Kalendarz SLA nie zawiera counts: ${calendar.text}`).toBeTruthy();
    expect(Array.isArray(calendar.json.policies || []), 'Kalendarz SLA powinien zwracać listę polityk SLA.').toBeTruthy();

    const check = await apiJson(request, 'POST', '/api/sla/check', sid, { data: {} });
    expect(check.res.ok(), `POST /api/sla/check -> HTTP ${check.res.status()}: ${check.text}`).toBeTruthy();
    expect(JSON.stringify(check.json), 'Odpowiedź sprawdzenia SLA nie powinna być pusta.').not.toBe('{}');
  });

  test('API audytu zwraca listę i eksport CSV', async ({ request }) => {
    const sid = await apiLogin(request);

    const audit = await apiJson(request, 'GET', '/api/audit?page_size=25', sid);
    expect(audit.res.ok(), `GET /api/audit -> HTTP ${audit.res.status()}: ${audit.text}`).toBeTruthy();
    expect(Array.isArray(audit.json.audit), `Audyt nie zawiera tablicy audit: ${audit.text}`).toBeTruthy();
    expect(audit.json.pagination, `Audyt nie zawiera pagination: ${audit.text}`).toBeTruthy();

    const csv = await request.get(`${baseURL}/api/audit.csv`, {
      headers: { 'X-Helpdesk-Session': sid }
    });
    const csvText = await csv.text();
    expect(csv.ok(), `GET /api/audit.csv -> HTTP ${csv.status()}: ${csvText.slice(0, 500)}`).toBeTruthy();
    expect(csvText, 'CSV audytu powinien zawierać nagłówek.').toMatch(/ID|Data|Aktor|Akcja|Audyt/i);
  });

  test('UI raportów, kalendarza SLA i audytu otwiera się bez błędów krytycznych', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('response', response => {
      if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    });

    await login(page);

    await openModule(page, 'Raporty', 'renderReports');
    await expect(page.locator('body')).toContainText(/Raporty|Pokaż raport|Eksport CSV/i, { timeout: 15000 });

    await openModule(page, 'Kalendarz SLA', 'renderSlaCalendar');
    await expect(page.locator('body')).toContainText(/SLA|Kalendarz|Polityki SLA|Sprawdź/i, { timeout: 15000 });

    await openModule(page, 'Audyt', 'renderAudit');
    await expect(page.locator('body')).toContainText(/Audyt|Eksport CSV|Akcja|Aktor/i, { timeout: 15000 });

    const realConsoleErrors = consoleErrors.filter(e => !isIgnorableConsoleError(e));
    expect(pageErrors, `Błędy JavaScript runtime: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(realConsoleErrors, `Błędy console.error: ${realConsoleErrors.join('\n')}`).toHaveLength(0);
    expect(serverErrors, `Błędy HTTP 5xx: ${serverErrors.join('\n')}`).toHaveLength(0);
  });

  test('nowe zgłoszenie ma wyliczone terminy SLA zgodne z polityką priorytetu', async ({ request }) => {
    const sid = await apiLogin(request);
    const priority = 'Niski';

    const policiesResponse = await apiJson(request, 'GET', '/api/sla-policies', sid);
    expect(policiesResponse.res.ok(), `GET /api/sla-policies -> HTTP ${policiesResponse.res.status()}: ${policiesResponse.text}`).toBeTruthy();
    const policy = (policiesResponse.json.policies || []).find((p: any) => p.priority === priority);
    expect(policy, `Nie znaleziono polityki SLA dla priorytetu ${priority}: ${policiesResponse.text}`).toBeTruthy();

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const create = await apiJson(request, 'POST', '/api/tickets', sid, {
      data: {
        title: `E2E SLA terminy ${stamp}`,
        description: 'Zgłoszenie testowe do walidacji terminów SLA.',
        category: 'Inne',
        subcategory: 'Inne',
        priority
      }
    });
    expect(create.res.ok(), `Tworzenie zgłoszenia SLA -> HTTP ${create.res.status()}: ${create.text}`).toBeTruthy();
    const ticketId = Number(create.json.id || create.json.ticket_id || create.json.ticket?.id);
    expect(ticketId, `Brak ID zgłoszenia SLA: ${create.text}`).toBeTruthy();

    const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);
    expect(detail.res.ok(), `Szczegóły zgłoszenia SLA -> HTTP ${detail.res.status()}: ${detail.text}`).toBeTruthy();
    const ticket = ticketFromDetail(detail.json);

    expect(ticket.first_response_due_at, `Brak terminu SLA reakcji w szczegółach zgłoszenia: ${detail.text}`).toBeTruthy();
    expect(ticket.sla_due_at, `Brak terminu SLA rozwiązania w szczegółach zgłoszenia: ${detail.text}`).toBeTruthy();

    const createdAt = parseHelpdeskDate(ticket.created_at);
    const firstResponseDue = parseHelpdeskDate(ticket.first_response_due_at);
    const resolutionDue = parseHelpdeskDate(ticket.sla_due_at);
    const firstHours = hoursBetween(createdAt, firstResponseDue);
    const resolutionHours = hoursBetween(createdAt, resolutionDue);

    expect(firstHours, `Termin reakcji powinien wynikać z polityki ${priority}: oczekiwano około ${policy.first_response_hours}h, otrzymano ${firstHours}h`).toBeGreaterThanOrEqual(Number(policy.first_response_hours) - 0.25);
    expect(firstHours, `Termin reakcji powinien wynikać z polityki ${priority}: oczekiwano około ${policy.first_response_hours}h, otrzymano ${firstHours}h`).toBeLessThanOrEqual(Number(policy.first_response_hours) + 0.25);
    expect(resolutionHours, `Termin rozwiązania powinien wynikać z polityki ${priority}: oczekiwano około ${policy.resolution_hours}h, otrzymano ${resolutionHours}h`).toBeGreaterThanOrEqual(Number(policy.resolution_hours) - 0.25);
    expect(resolutionHours, `Termin rozwiązania powinien wynikać z polityki ${priority}: oczekiwano około ${policy.resolution_hours}h, otrzymano ${resolutionHours}h`).toBeLessThanOrEqual(Number(policy.resolution_hours) + 0.25);
  });

  test('komentarz operatora rejestruje pierwszą reakcję SLA', async ({ request }) => {
    const sid = await apiLogin(request);
    const created = await apiCreateTicket(request, 'E2E SLA pierwsza reakcja');

    const before = await apiJson(request, 'GET', `/api/tickets/${created.id}`, sid);
    expect(before.res.ok(), `Szczegóły przed pierwszą reakcją -> HTTP ${before.res.status()}: ${before.text}`).toBeTruthy();
    const beforeTicket = ticketFromDetail(before.json);
    expect(beforeTicket.first_response_due_at, `Zgłoszenie powinno mieć termin pierwszej reakcji: ${before.text}`).toBeTruthy();
    expect(beforeTicket.first_response_at || '', 'Nowe zgłoszenie nie powinno mieć jeszcze zarejestrowanej pierwszej reakcji.').toBe('');

    const comment = await apiJson(request, 'POST', `/api/tickets/${created.id}/comments`, sid, {
      data: { content: `Pierwsza reakcja SLA E2E ${new Date().toISOString()}`, visibility: 'public' }
    });
    expect(comment.res.ok(), `Dodanie komentarza pierwszej reakcji -> HTTP ${comment.res.status()}: ${comment.text}`).toBeTruthy();
    expect(comment.json.first_response_registered, `Dodanie komentarza operatora powinno zarejestrować pierwszą reakcję SLA: ${comment.text}`).toBeTruthy();

    const after = await apiJson(request, 'GET', `/api/tickets/${created.id}`, sid);
    expect(after.res.ok(), `Szczegóły po pierwszej reakcji -> HTTP ${after.res.status()}: ${after.text}`).toBeTruthy();
    const afterTicket = ticketFromDetail(after.json);
    expect(afterTicket.first_response_at, `Po komentarzu operatora first_response_at powinno być ustawione: ${after.text}`).toBeTruthy();
    expect(JSON.stringify(after.json), 'Historia zgłoszenia powinna zawierać zdarzenie pierwszej reakcji SLA.').toMatch(/sla_first_response|pierwsz/i);
  });

  test('nowe zgłoszenie z terminem rozwiązania pojawia się w kalendarzu SLA', async ({ request }) => {
    const sid = await apiLogin(request);
    const created = await apiCreateTicket(request, 'E2E SLA kalendarz');

    const calendar = await apiJson(request, 'GET', '/api/sla-calendar', sid);
    expect(calendar.res.ok(), `GET /api/sla-calendar po utworzeniu zgłoszenia -> HTTP ${calendar.res.status()}: ${calendar.text}`).toBeTruthy();

    const allCalendarTickets = [
      ...(calendar.json.overdue || []),
      ...(calendar.json.today || []),
      ...(calendar.json.tomorrow || []),
      ...(calendar.json.next_7_days || []),
      ...(calendar.json.next_30_days || []),
    ];
    const ids = allCalendarTickets.map((ticket: any) => Number(ticket.id || ticket.ticket_id || ticket.ticket?.id));
    expect(ids, `Kalendarz SLA powinien zawierać nowe otwarte zgłoszenie #${created.id}. Odpowiedź: ${calendar.text.slice(0, 1200)}`).toContain(created.id);
  });

  test('UI kalendarza SLA pokazuje strukturę kalendarza bez błędów krytycznych', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('response', response => {
      if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    });

    await login(page);

    // Widok UI kalendarza SLA jest testem renderowania ekranu. Konkretna obecność nowego
    // zgłoszenia w grupach SLA jest sprawdzana osobnym testem API powyżej, bo UI może
    // pokazywać tylko wycinek/paginowaną listę albo mieć otwarty panel powiadomień.
    await openModule(page, 'Kalendarz SLA', 'renderSlaCalendar');
    await expect(page.locator('body')).toContainText(/SLA|Kalendarz|Dzisiaj|Najbliższe|Polityki/i, { timeout: 15000 });

    const realConsoleErrors = consoleErrors.filter(e => !isIgnorableConsoleError(e));
    expect(pageErrors, `Błędy JavaScript runtime w kalendarzu SLA: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(realConsoleErrors, `Błędy console.error w kalendarzu SLA: ${realConsoleErrors.join('\n')}`).toHaveLength(0);
    expect(serverErrors, `Błędy HTTP 5xx w kalendarzu SLA: ${serverErrors.join('\n')}`).toHaveLength(0);
  });
});


test.describe('Helpdesk E2E rozszerzone walidacje workflow', () => {
  async function createLowPriorityTicketForWorkflow(request: APIRequestContext, sid: string, titlePrefix: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const created = await apiJson(request, 'POST', '/api/tickets', sid, {
      data: {
        title: `${titlePrefix} ${stamp}`,
        description: 'Zgłoszenie testowe dla rozszerzonej walidacji workflow.',
        category: 'Inne',
        subcategory: 'Inne',
        priority: 'Niski'
      }
    });
    expect(created.res.ok(), `Tworzenie zgłoszenia testowego -> HTTP ${created.res.status()}: ${created.text}`).toBeTruthy();
    const ticketId = Number(created.json.id || created.json.ticket_id || created.json.ticket?.id);
    expect(ticketId, `Brak ID zgłoszenia w odpowiedzi: ${created.text}`).toBeTruthy();
    return { ticketId, stamp };
  }

  async function pickTransitionStatuses(request: APIRequestContext, sid: string, ticketId: number) {
    const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);
    expect(detail.res.ok(), `Szczegóły zgłoszenia #${ticketId} -> HTTP ${detail.res.status()}: ${detail.text}`).toBeTruthy();
    const ticket = ticketFromDetail(detail.json);
    const statuses: string[] = (detail.json.meta?.statuses || []).filter((s: string) => s && s !== 'Zamknięte');
    test.skip(statuses.length < 3, `Workflow ma mniej niż 3 statusy testowe: ${statuses.join(', ')}`);
    const initialStatus = ticket.status;
    const intermediateStatus = statuses.find(s => s !== initialStatus) || statuses[0];
    const targetStatus = statuses.find(s => s !== initialStatus && s !== intermediateStatus) || statuses.find(s => s !== intermediateStatus);
    expect(intermediateStatus, 'Brak statusu pośredniego dla testu workflow.').toBeTruthy();
    expect(targetStatus, 'Brak statusu docelowego dla testu workflow.').toBeTruthy();
    return { ticket, statuses, initialStatus, intermediateStatus: intermediateStatus as string, targetStatus: targetStatus as string };
  }

  async function workflowForTicket(request: APIRequestContext, sid: string, workflowKey: string) {
    const workflowsResponse = await apiJson(request, 'GET', '/api/admin/workflows', sid);
    expect(workflowsResponse.res.ok(), `Lista workflow -> HTTP ${workflowsResponse.res.status()}: ${workflowsResponse.text}`).toBeTruthy();
    const workflows = workflowsResponse.json.workflows || [];
    const workflow = workflows.find((w: any) => w.workflow_key === workflowKey) || workflows.find((w: any) => w.is_default) || workflows[0];
    expect(workflow?.id, 'Nie znaleziono workflow dla testu.').toBeTruthy();
    return workflow;
  }

  async function createValidationRule(request: APIRequestContext, sid: string, workflowId: number, targetStatus: string, actionType: 'require_comment' | 'require_attachment', stamp: string) {
    const payload = {
      name: `E2E ${actionType} aktualny status ${stamp}`,
      event_type: 'status_changed',
      // Puste condition_status oznacza dowolny status źródłowy.
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
      action_type: actionType,
      action_status: '',
      actions: [
        { action_order: 1, action_type: actionType, action_value: null, is_active: true }
      ],
      is_active: true,
      stop_processing: true,
      priority: 1
    };
    const rule = await apiJson(request, 'POST', `/api/admin/workflows/${workflowId}/automations`, sid, { data: payload });
    expect(rule.res.ok(), `Utworzenie reguły ${actionType} -> HTTP ${rule.res.status()}: ${rule.text}`).toBeTruthy();
    const automationId = Number(rule.json.id || rule.json.automation_id);
    expect(automationId, `Brak ID reguły workflow w odpowiedzi: ${rule.text}`).toBeTruthy();
    return automationId;
  }

  test('stary komentarz sprzed wejścia w status nie spełnia wymogu komentarza', async ({ request }) => {
    const sid = await apiLogin(request);
    const { ticketId, stamp } = await createLowPriorityTicketForWorkflow(request, sid, 'E2E stary komentarz');
    const { ticket, intermediateStatus, targetStatus } = await pickTransitionStatuses(request, sid, ticketId);

    const oldComment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/comments`, sid, {
      data: { content: `Stary komentarz przed zmianą statusu ${stamp}`, visibility: 'public' }
    });
    expect(oldComment.res.ok(), `Dodanie starego komentarza -> HTTP ${oldComment.res.status()}: ${oldComment.text}`).toBeTruthy();

    const move = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, { data: { status: intermediateStatus } });
    test.skip(!move.res.ok(), `Nie udało się ustawić statusu pośredniego ${intermediateStatus}: HTTP ${move.res.status()} ${move.text}`);

    const workflow = await workflowForTicket(request, sid, ticket.workflow_key || 'default');
    let automationId: number | undefined;
    try {
      automationId = await createValidationRule(request, sid, workflow.id, targetStatus, 'require_comment', stamp);

      const blocked = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, { data: { status: targetStatus } });
      expect(blocked.res.status(), `Stary komentarz nie powinien spełnić wymogu; HTTP ${blocked.res.status()}: ${blocked.text}`).toBe(409);
      expect(JSON.stringify(blocked.json)).toMatch(/comment|komentarz/i);

      const currentComment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/comments`, sid, {
        data: { content: `Komentarz w aktualnym statusie ${stamp}`, visibility: 'public' }
      });
      expect(currentComment.res.ok(), `Dodanie aktualnego komentarza -> HTTP ${currentComment.res.status()}: ${currentComment.text}`).toBeTruthy();

      const ok = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, { data: { status: targetStatus } });
      expect(ok.res.ok(), `Po aktualnym komentarzu zmiana statusu powinna przejść; HTTP ${ok.res.status()}: ${ok.text}`).toBeTruthy();
    } finally {
      if (automationId) await apiJson(request, 'DELETE', `/api/admin/workflows/${workflow.id}/automations/${automationId}`, sid).catch(() => undefined);
    }
  });

  test('stary załącznik sprzed wejścia w status nie spełnia wymogu załącznika', async ({ request }) => {
    const sid = await apiLogin(request);
    const { ticketId, stamp } = await createLowPriorityTicketForWorkflow(request, sid, 'E2E stary załącznik');
    const { ticket, intermediateStatus, targetStatus } = await pickTransitionStatuses(request, sid, ticketId);

    const oldAttachment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/attachments`, sid, {
      multipart: {
        file: {
          name: `e2e-old-attachment-${stamp}.txt`,
          mimeType: 'text/plain',
          buffer: Buffer.from('Stary załącznik dodany przed wejściem w aktualny status.\n')
        }
      }
    });
    expect(oldAttachment.res.ok(), `Dodanie starego załącznika -> HTTP ${oldAttachment.res.status()}: ${oldAttachment.text}`).toBeTruthy();

    const move = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, { data: { status: intermediateStatus } });
    test.skip(!move.res.ok(), `Nie udało się ustawić statusu pośredniego ${intermediateStatus}: HTTP ${move.res.status()} ${move.text}`);

    const workflow = await workflowForTicket(request, sid, ticket.workflow_key || 'default');
    let automationId: number | undefined;
    try {
      automationId = await createValidationRule(request, sid, workflow.id, targetStatus, 'require_attachment', stamp);

      const blocked = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, { data: { status: targetStatus } });
      expect(blocked.res.status(), `Stary załącznik nie powinien spełnić wymogu; HTTP ${blocked.res.status()}: ${blocked.text}`).toBe(409);
      expect(JSON.stringify(blocked.json)).toMatch(/attachment|załącznik/i);

      const currentAttachment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/attachments`, sid, {
        multipart: {
          file: {
            name: `e2e-current-attachment-${stamp}.txt`,
            mimeType: 'text/plain',
            buffer: Buffer.from('Załącznik dodany w aktualnym statusie.\n')
          }
        }
      });
      expect(currentAttachment.res.ok(), `Dodanie aktualnego załącznika -> HTTP ${currentAttachment.res.status()}: ${currentAttachment.text}`).toBeTruthy();

      const ok = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, { data: { status: targetStatus } });
      expect(ok.res.ok(), `Po aktualnym załączniku zmiana statusu powinna przejść; HTTP ${ok.res.status()}: ${ok.text}`).toBeTruthy();
    } finally {
      if (automationId) await apiJson(request, 'DELETE', `/api/admin/workflows/${workflow.id}/automations/${automationId}`, sid).catch(() => undefined);
    }
  });

  test('komentarz innego operatora nie spełnia wymogu komentarza dla aktualnego operatora', async ({ request }) => {
    test.skip(!operatorEmail || !operatorPassword, 'Ustaw HELPDESK_OPERATOR_EMAIL i HELPDESK_OPERATOR_PASSWORD, aby sprawdzić komentarz innego operatora.');
    test.skip(operatorEmail === adminEmail, 'Konto operatora testowego musi być inne niż konto admina.');

    const adminSid = await apiLogin(request);
    const operatorSid = await apiLoginWith(request, operatorEmail, operatorPassword);
    const { ticketId, stamp } = await createLowPriorityTicketForWorkflow(request, adminSid, 'E2E komentarz innego operatora');
    const { ticket, intermediateStatus, targetStatus } = await pickTransitionStatuses(request, adminSid, ticketId);

    const move = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, adminSid, { data: { status: intermediateStatus } });
    test.skip(!move.res.ok(), `Nie udało się ustawić statusu pośredniego ${intermediateStatus}: HTTP ${move.res.status()} ${move.text}`);

    const workflow = await workflowForTicket(request, adminSid, ticket.workflow_key || 'default');
    let automationId: number | undefined;
    try {
      automationId = await createValidationRule(request, adminSid, workflow.id, targetStatus, 'require_comment', stamp);

      const otherComment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/comments`, operatorSid, {
        data: { content: `Komentarz dodany przez innego operatora ${stamp}`, visibility: 'public' }
      });
      expect(otherComment.res.ok(), `Komentarz innego operatora -> HTTP ${otherComment.res.status()}: ${otherComment.text}`).toBeTruthy();

      const blocked = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, adminSid, { data: { status: targetStatus } });
      expect(blocked.res.status(), `Komentarz innego operatora nie powinien spełnić wymogu admina; HTTP ${blocked.res.status()}: ${blocked.text}`).toBe(409);
      expect(JSON.stringify(blocked.json)).toMatch(/comment|komentarz/i);

      const adminComment = await apiJson(request, 'POST', `/api/tickets/${ticketId}/comments`, adminSid, {
        data: { content: `Komentarz aktualnego operatora ${stamp}`, visibility: 'public' }
      });
      expect(adminComment.res.ok(), `Komentarz aktualnego operatora -> HTTP ${adminComment.res.status()}: ${adminComment.text}`).toBeTruthy();

      const ok = await apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, adminSid, { data: { status: targetStatus } });
      expect(ok.res.ok(), `Po komentarzu aktualnego operatora zmiana statusu powinna przejść; HTTP ${ok.res.status()}: ${ok.text}`).toBeTruthy();
    } finally {
      if (automationId) await apiJson(request, 'DELETE', `/api/admin/workflows/${workflow.id}/automations/${automationId}`, adminSid).catch(() => undefined);
    }
  });
});



test.describe('Helpdesk E2E negatywne API i uprawnienia', () => {
  test('API bez sesji oraz z błędnym SID zwraca 401', async ({ request }) => {
    const noSession = await request.get(`${baseURL}/api/me`);
    expect(noSession.status(), `GET /api/me bez sesji powinien zwrócić 401, zwrócił ${noSession.status()}: ${await noSession.text()}`).toBe(401);

    const badSid = await request.get(`${baseURL}/api/me`, {
      headers: { 'X-Helpdesk-Session': 'e2e-invalid-session-id' }
    });
    expect(badSid.status(), `GET /api/me z błędnym SID powinien zwrócić 401, zwrócił ${badSid.status()}: ${await badSid.text()}`).toBe(401);
  });

  test('puste albo niepoprawne zgłoszenie nie jest tworzone', async ({ request }) => {
    const sid = await apiLogin(request);
    const emptyTicket = await apiJson(request, 'POST', '/api/tickets', sid, {
      data: {
        title: '',
        description: '',
        category: '',
        subcategory: '',
        priority: ''
      }
    });
    expect(emptyTicket.res.status(), `Puste zgłoszenie powinno zwrócić 4xx, zwróciło ${emptyTicket.res.status()}: ${emptyTicket.text}`).toBeGreaterThanOrEqual(400);
    expect(emptyTicket.res.status(), `Puste zgłoszenie powinno zwrócić 4xx, zwróciło ${emptyTicket.res.status()}: ${emptyTicket.text}`).toBeLessThan(500);
  });

  test('nieistniejące zgłoszenie zwraca 404 albo kontrolowany 4xx', async ({ request }) => {
    const sid = await apiLogin(request);
    const missingId = 999999999;
    const missing = await apiJson(request, 'GET', `/api/tickets/${missingId}`, sid);
    expect(missing.res.status(), `Nieistniejące zgłoszenie powinno zwrócić 404/4xx, zwróciło ${missing.res.status()}: ${missing.text}`).toBeGreaterThanOrEqual(400);
    expect(missing.res.status(), `Nieistniejące zgłoszenie nie powinno zwracać 5xx, zwróciło ${missing.res.status()}: ${missing.text}`).toBeLessThan(500);
  });

  test('załącznik bez pliku zwraca kontrolowany błąd 4xx', async ({ request }) => {
    const { id, sid } = await apiCreateTicket(request, 'E2E negatywny załącznik');
    const response = await request.post(`${baseURL}/api/tickets/${id}/attachments`, {
      headers: { 'X-Helpdesk-Session': sid },
      multipart: {}
    });
    const text = await response.text();
    expect(response.status(), `Załącznik bez pliku powinien zwrócić 4xx, zwrócił ${response.status()}: ${text}`).toBeGreaterThanOrEqual(400);
    expect(response.status(), `Załącznik bez pliku nie powinien zwracać 5xx, zwrócił ${response.status()}: ${text}`).toBeLessThan(500);
  });

  test('operator bez uprawnień administracyjnych nie może zarządzać macierzą uprawnień', async ({ request }) => {
    test.skip(!operatorEmail || !operatorPassword, 'Ustaw HELPDESK_OPERATOR_EMAIL i HELPDESK_OPERATOR_PASSWORD, aby sprawdzić odmowy dostępu operatora.');
    const operatorSid = await apiLoginWith(request, operatorEmail, operatorPassword);
    const forbidden = await apiJson(request, 'GET', '/api/admin/permissions', operatorSid);
    expect(forbidden.res.status(), `Operator bez permissions.view powinien dostać 403, zwrócono ${forbidden.res.status()}: ${forbidden.text}`).toBe(403);
    expect(JSON.stringify(forbidden.json), 'Odpowiedź 403 powinna zawierać informację o braku uprawnienia.').toMatch(/forbidden|permission|uprawn/i);
  });

  test('zwykły użytkownik nie ma dostępu do endpointów administracyjnych', async ({ request }) => {
    test.skip(!normalUserEmail || !normalUserPassword, 'Ustaw HELPDESK_USER_EMAIL i HELPDESK_USER_PASSWORD, aby sprawdzić odmowy dostępu zwykłego użytkownika.');
    const userSid = await apiLoginWith(request, normalUserEmail, normalUserPassword);
    const permissions = await apiJson(request, 'GET', '/api/admin/permissions', userSid);
    expect(permissions.res.status(), `Zwykły użytkownik powinien dostać 403 do /api/admin/permissions, zwrócono ${permissions.res.status()}: ${permissions.text}`).toBe(403);

    const audit = await apiJson(request, 'GET', '/api/audit', userSid);
    expect([401, 403]).toContain(audit.res.status());
  });

  test('odmowa dostępu jest rejestrowana w audycie jako permission_denied', async ({ request }) => {
    test.skip(!normalUserEmail || !normalUserPassword, 'Ustaw HELPDESK_USER_EMAIL i HELPDESK_USER_PASSWORD, aby sprawdzić audyt odmów dostępu.');
    const userSid = await apiLoginWith(request, normalUserEmail, normalUserPassword);
    await apiJson(request, 'GET', '/api/admin/permissions', userSid);

    const adminSid = await apiLogin(request);
    const audit = await apiJson(request, 'GET', '/api/audit?q=permission_denied&page_size=50', adminSid);
    expect(audit.res.ok(), `GET /api/audit dla permission_denied -> HTTP ${audit.res.status()}: ${audit.text}`).toBeTruthy();
    const auditText = JSON.stringify(audit.json);
    expect(auditText, 'Audyt powinien zawierać wpis permission_denied po odmowie dostępu.').toMatch(/permission_denied/i);
  });
});


test.describe('Helpdesk E2E role użytkowników i widoczność modułów', () => {
  const moduleExpectations = [
    { label: 'Raporty', permissions: ['reports.view'] },
    { label: 'Kalendarz SLA', permissions: ['sla.view', 'sla.manage'] },
    { label: 'Workflow', permissions: ['workflow.manage', 'workflow.view_logs'] },
    { label: 'Audyt', permissions: ['audit.view'] },
    { label: 'Użytkownicy', permissions: ['users.manage'] },
    { label: 'Uprawnienia', permissions: ['permissions.view', 'permissions.manage'] },
  ];

  async function permissionsFor(request: APIRequestContext, email: string, password: string) {
    const sid = await apiLoginWith(request, email, password);
    const response = await apiJson(request, 'GET', '/api/permissions/me', sid);
    expect(response.res.ok(), `GET /api/permissions/me dla ${email} -> HTTP ${response.res.status()}: ${response.text}`).toBeTruthy();
    const permissions = new Set<string>(response.json.permissions || []);
    const roles = response.json.roles || response.json.role_keys || [];
    return { sid, permissions, roles, raw: response.json };
  }

  async function assertMenuMatchesPermissions(page: Page, permissions: Set<string>, accountLabel: string) {
    for (const item of moduleExpectations) {
      const expectedVisible = item.permissions.some(permission => permissions.has(permission));
      const visibleCount = await firstVisibleCount(page, `text=${item.label}`);
      if (expectedVisible) {
        expect(visibleCount, `${accountLabel}: moduł "${item.label}" powinien być widoczny, bo użytkownik ma jedno z uprawnień: ${item.permissions.join(', ')}`).toBeGreaterThan(0);
      } else {
        expect(visibleCount, `${accountLabel}: moduł "${item.label}" powinien być ukryty, bo użytkownik nie ma uprawnień: ${item.permissions.join(', ')}`).toBe(0);
      }
    }
  }

  test('menu administratora jest zgodne z jego realnymi uprawnieniami', async ({ page, request }) => {
    const { permissions } = await permissionsFor(request, adminEmail, adminPassword);
    await login(page);
    await assertMenuMatchesPermissions(page, permissions, 'admin');
  });

  test('menu operatora jest zgodne z jego realnymi uprawnieniami', async ({ page, request }) => {
    test.skip(!operatorEmail || !operatorPassword, 'Ustaw HELPDESK_OPERATOR_EMAIL i HELPDESK_OPERATOR_PASSWORD, aby sprawdzić profil operatora.');
    const { permissions } = await permissionsFor(request, operatorEmail, operatorPassword);
    await loginAs(page, operatorEmail, operatorPassword);
    await assertMenuMatchesPermissions(page, permissions, 'operator');
  });

  test('menu zwykłego użytkownika jest zgodne z jego realnymi uprawnieniami', async ({ page, request }) => {
    test.skip(!normalUserEmail || !normalUserPassword, 'Ustaw HELPDESK_USER_EMAIL i HELPDESK_USER_PASSWORD, aby sprawdzić profil zwykłego użytkownika.');
    const { permissions } = await permissionsFor(request, normalUserEmail, normalUserPassword);
    await loginAs(page, normalUserEmail, normalUserPassword);
    await assertMenuMatchesPermissions(page, permissions, 'user');
  });

  test('backend administracyjny respektuje uprawnienia profilu operatora i użytkownika', async ({ request }) => {
    test.skip(!operatorEmail || !operatorPassword || !normalUserEmail || !normalUserPassword, 'Ustaw konta operatora i zwykłego użytkownika, aby sprawdzić profile backendowe.');

    const operator = await permissionsFor(request, operatorEmail, operatorPassword);
    const user = await permissionsFor(request, normalUserEmail, normalUserPassword);

    const checks = [
      { label: 'operator', sid: operator.sid, permissions: operator.permissions },
      { label: 'user', sid: user.sid, permissions: user.permissions },
    ];

    for (const checked of checks) {
      const permissionsEndpoint = await apiJson(request, 'GET', '/api/admin/permissions', checked.sid);
      if (checked.permissions.has('permissions.view') || checked.permissions.has('permissions.manage')) {
        expect(permissionsEndpoint.res.ok(), `${checked.label}: /api/admin/permissions powinno działać przy permissions.view/manage; HTTP ${permissionsEndpoint.res.status()}: ${permissionsEndpoint.text}`).toBeTruthy();
      } else {
        expect(permissionsEndpoint.res.status(), `${checked.label}: /api/admin/permissions powinno zwrócić 403 bez permissions.view/manage; HTTP ${permissionsEndpoint.res.status()}: ${permissionsEndpoint.text}`).toBe(403);
      }

      const auditEndpoint = await apiJson(request, 'GET', '/api/audit', checked.sid);
      if (checked.permissions.has('audit.view')) {
        expect(auditEndpoint.res.ok(), `${checked.label}: /api/audit powinno działać przy audit.view; HTTP ${auditEndpoint.res.status()}: ${auditEndpoint.text}`).toBeTruthy();
      } else {
        expect([401, 403]).toContain(auditEndpoint.res.status());
      }

      const workflowLogEndpoint = await apiJson(request, 'GET', '/api/admin/workflow-rule-executions', checked.sid);
      if (checked.permissions.has('workflow.view_logs') || checked.permissions.has('workflow.manage')) {
        expect(workflowLogEndpoint.res.ok(), `${checked.label}: log workflow powinien działać przy workflow.view_logs/manage; HTTP ${workflowLogEndpoint.res.status()}: ${workflowLogEndpoint.text}`).toBeTruthy();
      } else {
        expect(workflowLogEndpoint.res.status(), `${checked.label}: log workflow powinien zwrócić 403 bez workflow.view_logs/manage; HTTP ${workflowLogEndpoint.res.status()}: ${workflowLogEndpoint.text}`).toBe(403);
      }
    }
  });
});


test.describe('Helpdesk E2E raporty i audyt — walidacja danych', () => {
  function rowCount(rows: any[], value: string): number {
    const row = (rows || []).find((item: any) => String(item.value || item.label || '').toLowerCase() === value.toLowerCase());
    return Number(row?.count || 0);
  }

  function dayCreated(rows: any[], day: string): number {
    const row = (rows || []).find((item: any) => String(item.day || '') === day);
    return Number(row?.created || 0);
  }

  test('raport po utworzeniu zgłoszenia pokazuje wzrost liczników, priorytetu, kategorii i trendu dziennego', async ({ request }) => {
    const sid = await apiLogin(request);
    const today = isoDateDaysAgo(0);
    const reportPath = `/api/reports?from=${today}&to=${today}`;

    const before = await apiJson(request, 'GET', reportPath, sid);
    expect(before.res.ok(), `Raport przed testem -> HTTP ${before.res.status()}: ${before.text}`).toBeTruthy();

    const beforeCreated = Number(before.json.summary?.created || 0);
    const beforeLowPriority = rowCount(before.json.by_priority || [], 'Niski');
    const beforeOtherCategory = rowCount(before.json.by_category || [], 'Inne');
    const beforeTodayCreated = dayCreated(before.json.by_day || [], today);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const created = await apiJson(request, 'POST', '/api/tickets', sid, {
      data: {
        title: `E2E raport dane ${stamp}`,
        description: 'Zgłoszenie testowe do walidacji danych raportów.',
        category: 'Inne',
        subcategory: 'Inne',
        priority: 'Niski'
      }
    });
    expect(created.res.ok(), `Tworzenie zgłoszenia do raportu -> HTTP ${created.res.status()}: ${created.text}`).toBeTruthy();

    const after = await apiJson(request, 'GET', reportPath, sid);
    expect(after.res.ok(), `Raport po teście -> HTTP ${after.res.status()}: ${after.text}`).toBeTruthy();

    expect(Number(after.json.summary?.created || 0), `summary.created powinno wzrosnąć po utworzeniu zgłoszenia. Przed: ${before.text}; Po: ${after.text}`).toBeGreaterThanOrEqual(beforeCreated + 1);
    expect(rowCount(after.json.by_priority || [], 'Niski'), 'Licznik priorytetu Niski powinien wzrosnąć.').toBeGreaterThanOrEqual(beforeLowPriority + 1);
    expect(rowCount(after.json.by_category || [], 'Inne'), 'Licznik kategorii Inne powinien wzrosnąć.').toBeGreaterThanOrEqual(beforeOtherCategory + 1);
    expect(dayCreated(after.json.by_day || [], today), 'Trend dzienny dla dzisiaj powinien wzrosnąć.').toBeGreaterThanOrEqual(beforeTodayCreated + 1);
  });

  test('eksport CSV raportów zawiera sekcje i dane agregacji', async ({ request }) => {
    const sid = await apiLogin(request);
    const today = isoDateDaysAgo(0);

    const csv = await request.get(`${baseURL}/api/reports.csv?from=${today}&to=${today}`, {
      headers: { 'X-Helpdesk-Session': sid }
    });
    const csvText = await csv.text();
    expect(csv.ok(), `Eksport CSV raportów -> HTTP ${csv.status()}: ${csvText.slice(0, 800)}`).toBeTruthy();
    expect(csvText).toMatch(/Raport helpdesk/i);
    expect(csvText).toMatch(/Podsumowanie/i);
    expect(csvText).toMatch(/Utworzone według priorytetu/i);
    expect(csvText).toMatch(/Utworzone według kategorii/i);
    expect(csvText).toMatch(/Trend dzienny/i);
  });

  test('audyt po utworzeniu zgłoszenia zawiera wpis dotyczący zgłoszenia testowego', async ({ request }) => {
    const sid = await apiLogin(request);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const title = `E2E audyt dane ${stamp}`;

    const created = await apiJson(request, 'POST', '/api/tickets', sid, {
      data: {
        title,
        description: 'Zgłoszenie testowe do walidacji audytu.',
        category: 'Inne',
        subcategory: 'Inne',
        priority: 'Normalny'
      }
    });
    expect(created.res.ok(), `Tworzenie zgłoszenia do audytu -> HTTP ${created.res.status()}: ${created.text}`).toBeTruthy();
    const ticketId = Number(created.json.id || created.json.ticket_id || created.json.ticket?.id);
    expect(ticketId, `Brak ID zgłoszenia w odpowiedzi: ${created.text}`).toBeTruthy();

    const auditById = await apiJson(request, 'GET', `/api/audit?q=${encodeURIComponent(String(ticketId))}&page_size=25`, sid);
    expect(auditById.res.ok(), `Audyt po ID zgłoszenia -> HTTP ${auditById.res.status()}: ${auditById.text}`).toBeTruthy();
    const auditRows = auditById.json.audit || [];
    const matching = auditRows.some((row: any) => String(row.target_id || '').includes(String(ticketId)) || String(row.details || '').includes(String(ticketId)) || String(row.details || '').includes(title));
    expect(matching, `Audyt powinien zawierać wpis dla zgłoszenia #${ticketId}. Odpowiedź: ${auditById.text}`).toBeTruthy();
  });

  test('eksport CSV audytu respektuje filtr i zawiera wpis testowy', async ({ request }) => {
    const sid = await apiLogin(request);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const title = `E2E audyt CSV ${stamp}`;

    const created = await apiJson(request, 'POST', '/api/tickets', sid, {
      data: {
        title,
        description: 'Zgłoszenie testowe do walidacji eksportu CSV audytu.',
        category: 'Inne',
        subcategory: 'Inne',
        priority: 'Normalny'
      }
    });
    expect(created.res.ok(), `Tworzenie zgłoszenia do CSV audytu -> HTTP ${created.res.status()}: ${created.text}`).toBeTruthy();
    const ticketId = Number(created.json.id || created.json.ticket_id || created.json.ticket?.id);
    expect(ticketId, `Brak ID zgłoszenia w odpowiedzi: ${created.text}`).toBeTruthy();

    const csv = await request.get(`${baseURL}/api/audit.csv?q=${encodeURIComponent(String(ticketId))}`, {
      headers: { 'X-Helpdesk-Session': sid }
    });
    const csvText = await csv.text();
    expect(csv.ok(), `Eksport CSV audytu -> HTTP ${csv.status()}: ${csvText.slice(0, 800)}`).toBeTruthy();
    expect(csvText).toMatch(/ID;Data;Aktor;Email;Akcja;Obiekt;ID obiektu;Szczegóły|ID.*Data.*Aktor.*Akcja/i);
    expect(csvText, `CSV audytu powinien zawierać ID zgłoszenia #${ticketId}.`).toContain(String(ticketId));
  });

  test('eksport macierzy uprawnień zawiera role podstawowe', async ({ request }) => {
    const sid = await apiLogin(request);
    const csv = await request.get(`${baseURL}/api/admin/permissions.csv`, {
      headers: { 'X-Helpdesk-Session': sid }
    });
    const csvText = await csv.text();
    expect(csv.ok(), `Eksport CSV macierzy uprawnień -> HTTP ${csv.status()}: ${csvText.slice(0, 800)}`).toBeTruthy();
    expect(csvText).toMatch(/user/i);
    expect(csvText).toMatch(/operator/i);
    expect(csvText).toMatch(/admin/i);
    expect(csvText).toMatch(/permission|uprawn/i);
  });
});


test.describe('Helpdesk E2E filtrowanie i wyszukiwanie zgłoszeń — walidacja danych', () => {
  function extractTickets(payload: any): any[] {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.tickets)) return payload.tickets;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.rows)) return payload.rows;
    return [];
  }

  async function createTicketForFiltering(request: APIRequestContext, sid: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const title = `E2E filtr wyszukiwanie ${stamp}`;
    const created = await apiJson(request, 'POST', '/api/tickets', sid, {
      data: {
        title,
        description: `Opis unikalny do filtrowania ${stamp}`,
        category: 'Inne',
        subcategory: 'Inne',
        priority: 'Niski'
      }
    });
    expect(created.res.ok(), `Tworzenie zgłoszenia do testów filtrów -> HTTP ${created.res.status()}: ${created.text}`).toBeTruthy();
    const id = Number(created.json.id || created.json.ticket_id || created.json.ticket?.id);
    expect(id, `Brak ID zgłoszenia w odpowiedzi: ${created.text}`).toBeTruthy();

    const detail = await apiJson(request, 'GET', `/api/tickets/${id}`, sid);
    expect(detail.res.ok(), `Szczegóły zgłoszenia do filtrów -> HTTP ${detail.res.status()}: ${detail.text}`).toBeTruthy();
    const ticket = ticketFromDetail(detail.json);
    return { id, title, stamp, status: ticket.status || 'Nowe', priority: ticket.priority || 'Niski', category: ticket.category || 'Inne', subcategory: ticket.subcategory || 'Inne' };
  }

  async function expectTicketVisibleInList(request: APIRequestContext, sid: string, path: string, ticketId: number, label: string) {
    const response = await apiJson(request, 'GET', path, sid);
    expect(response.res.ok(), `${label} -> HTTP ${response.res.status()}: ${response.text}`).toBeTruthy();
    const tickets = extractTickets(response.json);
    const ids = tickets.map((ticket: any) => Number(ticket.id || ticket.ticket_id || ticket.ticket?.id));
    expect(ids, `${label}: lista nie zawiera zgłoszenia #${ticketId}. Odpowiedź: ${response.text.slice(0, 1200)}`).toContain(ticketId);
    return response;
  }

  test('API listy zgłoszeń znajduje zgłoszenie po unikalnym tytule i numerze #ID', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicketForFiltering(request, sid);

    await expectTicketVisibleInList(
      request,
      sid,
      `/api/tickets?assigned=all&q=${encodeURIComponent(ticket.title)}`,
      ticket.id,
      'Wyszukiwanie po unikalnym tytule'
    );

    await expectTicketVisibleInList(
      request,
      sid,
      `/api/tickets?assigned=all&q=${encodeURIComponent('#' + ticket.id)}`,
      ticket.id,
      'Wyszukiwanie po numerze #ID'
    );
  });

  test('API listy zgłoszeń respektuje filtry priorytetu, kategorii, podkategorii i statusu', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicketForFiltering(request, sid);

    const base = `/api/tickets?assigned=all&q=${encodeURIComponent(ticket.title)}`;
    await expectTicketVisibleInList(request, sid, `${base}&priority=${encodeURIComponent(ticket.priority)}`, ticket.id, 'Filtr priorytetu');
    await expectTicketVisibleInList(request, sid, `${base}&category=${encodeURIComponent(ticket.category)}`, ticket.id, 'Filtr kategorii');
    await expectTicketVisibleInList(request, sid, `${base}&subcategory=${encodeURIComponent(ticket.subcategory)}`, ticket.id, 'Filtr podkategorii');
    await expectTicketVisibleInList(request, sid, `${base}&status=${encodeURIComponent(ticket.status)}`, ticket.id, 'Filtr statusu');
  });

  test('API listy zgłoszeń respektuje filtr daty utworzenia', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicketForFiltering(request, sid);
    const today = isoDateDaysAgo(0);

    await expectTicketVisibleInList(
      request,
      sid,
      `/api/tickets?assigned=all&q=${encodeURIComponent(ticket.title)}&created_from=${today}&created_to=${today}`,
      ticket.id,
      'Filtr daty utworzenia od/do'
    );
  });

  test('UI filtrów zgłoszeń działa bez błędów krytycznych i znajduje zgłoszenie po tytule', async ({ page, request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicketForFiltering(request, sid);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('response', response => {
      if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    });

    await login(page);
    await page.waitForLoadState('networkidle');

    // Domyślny widok operatora/admina może pokazywać tylko zgłoszenia przypisane do mnie.
    // Zgłoszenia tworzone przez test są zwykle nieprzypisane, więc dla testu filtrów
    // przełączamy listę na pełny zakres, jeśli pole wyboru jest dostępne w UI.
    const assignedSelect = page.locator('select:has(option[value="all"])').first();
    if (await assignedSelect.count() && await assignedSelect.isVisible().catch(() => false)) {
      await assignedSelect.selectOption('all').catch(() => undefined);
      await page.waitForLoadState('networkidle').catch(() => undefined);
    }

    const searchInput = page.locator('input[name="q"], input[name="search"], input[placeholder*="Szukaj" i], input[placeholder*="wyszuk" i]').first();
    if (await searchInput.count()) {
      await searchInput.fill(ticket.title);
      const filterButton = page.locator('button:has-text("Filtruj"), button:has-text("Szukaj"), button:has-text("Zastosuj")').first();
      if (await filterButton.count() && await filterButton.isVisible().catch(() => false)) {
        await filterButton.click();
      } else {
        await searchInput.press('Enter').catch(() => undefined);
      }
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await expect(page.locator('body')).toContainText(ticket.title, { timeout: 15000 });
    } else {
      // Jeżeli aktualny układ UI nie ma pola wyszukiwania w DOM, test nadal sprawdza API wyżej.
      test.skip(true, 'Nie znaleziono pola wyszukiwania na liście zgłoszeń w aktualnym UI.');
    }

    const clearButton = page.locator('button:has-text("Wyczyść filtry"), button:has-text("Wyczyść"), a:has-text("Wyczyść filtry")').first();
    if (await clearButton.count() && await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await expect(page.locator('body')).toContainText(/Zgłoszenia|Status|Priorytet|Brak zgłoszeń/i, { timeout: 15000 });
    }

    const realConsoleErrors = consoleErrors.filter(e => !isIgnorableConsoleError(e));
    expect(pageErrors, `Błędy JavaScript runtime przy filtrach zgłoszeń: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(realConsoleErrors, `Błędy console.error przy filtrach zgłoszeń: ${realConsoleErrors.join('\n')}`).toHaveLength(0);
    expect(serverErrors, `Błędy HTTP 5xx przy filtrach zgłoszeń: ${serverErrors.join('\n')}`).toHaveLength(0);
  });

function extractNotifications(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  for (const key of ['notifications', 'items', 'data', 'rows', 'results']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

async function getFirstNotificationId(request: APIRequestContext, sid: string): Promise<number | null> {
  const response = await apiJson(request, 'GET', '/api/notifications', sid);
  expect(response.res.ok(), `GET /api/notifications -> HTTP ${response.res.status()}: ${response.text}`).toBeTruthy();
  const notifications = extractNotifications(response.json);
  if (!notifications.length) return null;
  const notification = notifications.find((n: any) => n && (n.id || n.notification_id)) || notifications[0];
  const id = Number(notification.id || notification.notification_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

test.describe('Helpdesk E2E powiadomienia', () => {
  test('API powiadomień zwraca listę oraz obsługuje read/unread dla pojedynczego wpisu', async ({ request }) => {
    const sid = await apiLogin(request);

    // Utworzenie zgłoszenia często generuje powiadomienia w aplikacji.
    // Jeżeli środowisko testowe nie ma żadnych powiadomień, test zostanie pominięty,
    // żeby nie wymuszać konkretnej konfiguracji reguł workflow.
    await apiCreateTicket(request, 'E2E notification source');

    const notificationId = await getFirstNotificationId(request, sid);
    if (!notificationId) {
      test.skip(true, 'Brak powiadomień do testu read/unread w tym środowisku.');
    }

    const read = await apiJson(request, 'POST', `/api/notifications/${notificationId}/read`, sid, { data: {} });
    expect(read.res.ok(), `POST /api/notifications/${notificationId}/read -> HTTP ${read.res.status()}: ${read.text}`).toBeTruthy();

    const unread = await apiJson(request, 'POST', `/api/notifications/${notificationId}/unread`, sid, { data: {} });
    expect(unread.res.ok(), `POST /api/notifications/${notificationId}/unread -> HTTP ${unread.res.status()}: ${unread.text}`).toBeTruthy();

    const readAgain = await apiJson(request, 'POST', `/api/notifications/${notificationId}/read`, sid, { data: {} });
    expect(readAgain.res.ok(), `Ponowne oznaczenie jako przeczytane -> HTTP ${readAgain.res.status()}: ${readAgain.text}`).toBeTruthy();
  });

  test('API powiadomień obsługuje operacje zbiorcze bez błędów serwera', async ({ request }) => {
    const sid = await apiLogin(request);

    const readAll = await apiJson(request, 'POST', '/api/notifications/read-all', sid, { data: {} });
    expect([200, 204].includes(readAll.res.status()), `POST /api/notifications/read-all -> HTTP ${readAll.res.status()}: ${readAll.text}`).toBeTruthy();

    const deleteRead = await apiJson(request, 'POST', '/api/notifications/delete-read', sid, { data: {} });
    expect([200, 204].includes(deleteRead.res.status()), `POST /api/notifications/delete-read -> HTTP ${deleteRead.res.status()}: ${deleteRead.text}`).toBeTruthy();

    const after = await apiJson(request, 'GET', '/api/notifications', sid);
    expect(after.res.ok(), `GET /api/notifications po operacjach zbiorczych -> HTTP ${after.res.status()}: ${after.text}`).toBeTruthy();
    expect(Array.isArray(extractNotifications(after.json)), `Odpowiedź powiadomień powinna zawierać listę: ${after.text}`).toBeTruthy();
  });

  test('API powiadomień obsługuje usunięcie pojedynczego wpisu, jeśli wpis istnieje', async ({ request }) => {
    const sid = await apiLogin(request);
    await apiCreateTicket(request, 'E2E notification delete source');

    const notificationId = await getFirstNotificationId(request, sid);
    if (!notificationId) {
      test.skip(true, 'Brak powiadomień do testu usunięcia pojedynczego wpisu w tym środowisku.');
    }

    const del = await request.delete(`${baseURL}/api/notifications/${notificationId}`, {
      headers: { 'X-Helpdesk-Session': sid }
    });
    const text = await del.text();
    expect([200, 204, 404].includes(del.status()), `DELETE /api/notifications/${notificationId} -> HTTP ${del.status()}: ${text}`).toBeTruthy();
  });

  test('UI panelu powiadomień otwiera się bez błędów krytycznych', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('response', response => {
      if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    });

    await login(page);
    await page.waitForLoadState('networkidle');

    const openedByFunction = await page.evaluate(() => {
      const candidates = ['renderNotifications', 'openNotifications', 'toggleNotifications', 'renderNotificationCenter'];
      for (const name of candidates) {
        const fn = (window as any)[name];
        if (typeof fn === 'function') {
          fn();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (!openedByFunction) {
      await clickFirstVisible(page, [
        'button:has-text("Powiadomienia")',
        'a:has-text("Powiadomienia")',
        '[aria-label*="Powiadom" i]',
        'button:has-text("🔔")'
      ]);
    }

    await page.waitForLoadState('networkidle').catch(() => undefined);
    await expect(page.locator('body')).toContainText(/Powiadomienia|Nieprzeczytane|Oznacz wszystkie|Brak powiadomień/i, { timeout: 15000 });

    const realConsoleErrors = consoleErrors.filter(e => !isIgnorableConsoleError(e));
    expect(pageErrors, `Błędy JavaScript runtime w panelu powiadomień: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(realConsoleErrors, `Błędy console.error w panelu powiadomień: ${realConsoleErrors.join('\n')}`).toHaveLength(0);
    expect(serverErrors, `Błędy HTTP 5xx w panelu powiadomień: ${serverErrors.join('\n')}`).toHaveLength(0);
  });
});


test.describe('Helpdesk E2E historia statusu i aktywności zgłoszenia', () => {
  function arrayFromDetail(payload: any, key: string): any[] {
    return Array.isArray(payload?.[key]) ? payload[key] : [];
  }

  function stringifyArray(rows: any[]): string {
    return JSON.stringify(rows, null, 2);
  }

  async function pickAnyTargetStatus(request: APIRequestContext, sid: string, ticketId: number) {
    const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);
    expect(detail.res.ok(), `Szczegóły zgłoszenia #${ticketId} -> HTTP ${detail.res.status()}: ${detail.text}`).toBeTruthy();
    const ticket = ticketFromDetail(detail.json);
    const statuses: string[] = (detail.json.meta?.statuses || []).filter((s: string) => s && s !== ticket.status && s !== 'Zamknięte');
    const targetStatus = statuses[0];
    expect(targetStatus, `Brak statusu docelowego innego niż ${ticket.status}. Dostępne statusy: ${(detail.json.meta?.statuses || []).join(', ')}`).toBeTruthy();
    return { oldStatus: ticket.status as string, targetStatus: targetStatus as string };
  }

  test('zmiana statusu zapisuje wpis w status_history oraz aktywności zgłoszenia', async ({ request }) => {
    const created = await apiCreateTicket(request, 'E2E historia statusu');
    const { oldStatus, targetStatus } = await pickAnyTargetStatus(request, created.sid, created.id);

    const before = await apiJson(request, 'GET', `/api/tickets/${created.id}`, created.sid);
    const beforeStatusHistory = arrayFromDetail(before.json, 'status_history').length;
    const beforeEvents = arrayFromDetail(before.json, 'events').length;

    const change = await apiJson(request, 'POST', `/api/tickets/${created.id}/status`, created.sid, { data: { status: targetStatus } });
    expect(change.res.ok(), `Zmiana statusu -> HTTP ${change.res.status()}: ${change.text}`).toBeTruthy();

    const after = await apiJson(request, 'GET', `/api/tickets/${created.id}`, created.sid);
    expect(after.res.ok(), `Szczegóły po zmianie statusu -> HTTP ${after.res.status()}: ${after.text}`).toBeTruthy();
    const afterTicket = ticketFromDetail(after.json);
    expect(afterTicket.status, `Status zgłoszenia po zmianie powinien wynosić ${targetStatus}.`).toBe(targetStatus);

    const statusHistory = arrayFromDetail(after.json, 'status_history');
    expect(statusHistory.length, `status_history powinno mieć nowy wpis. Odpowiedź: ${after.text.slice(0, 1500)}`).toBeGreaterThan(beforeStatusHistory);
    expect(
      statusHistory.some((entry: any) => entry.old_status === oldStatus && entry.new_status === targetStatus),
      `status_history nie zawiera przejścia ${oldStatus} -> ${targetStatus}. Wpisy: ${stringifyArray(statusHistory)}`
    ).toBeTruthy();

    const events = arrayFromDetail(after.json, 'events');
    expect(events.length, `events powinno mieć nowy wpis aktywności po zmianie statusu.`).toBeGreaterThan(beforeEvents);
    expect(
      stringifyArray(events),
      'Historia aktywności powinna zawierać informację o zmianie statusu.'
    ).toMatch(new RegExp(`${escapeRegExp(oldStatus)}|${escapeRegExp(targetStatus)}|status`, 'i'));
  });

  test('komentarz i załącznik są widoczne w szczegółach oraz historii aktywności', async ({ request }) => {
    const created = await apiCreateTicket(request, 'E2E historia aktywności');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const commentText = `Komentarz historii aktywności E2E ${stamp}`;
    const attachmentName = `e2e-history-attachment-${stamp}.txt`;

    const before = await apiJson(request, 'GET', `/api/tickets/${created.id}`, created.sid);
    const beforeEvents = arrayFromDetail(before.json, 'events').length;

    const comment = await apiJson(request, 'POST', `/api/tickets/${created.id}/comments`, created.sid, {
      data: { content: commentText, visibility: 'public' }
    });
    expect(comment.res.ok(), `Dodanie komentarza -> HTTP ${comment.res.status()}: ${comment.text}`).toBeTruthy();

    const attachment = await apiJson(request, 'POST', `/api/tickets/${created.id}/attachments`, created.sid, {
      multipart: {
        file: {
          name: attachmentName,
          mimeType: 'text/plain',
          buffer: Buffer.from('Załącznik testujący historię aktywności zgłoszenia.\n')
        }
      }
    });
    expect(attachment.res.ok(), `Dodanie załącznika -> HTTP ${attachment.res.status()}: ${attachment.text}`).toBeTruthy();

    const after = await apiJson(request, 'GET', `/api/tickets/${created.id}`, created.sid);
    expect(after.res.ok(), `Szczegóły po komentarzu i załączniku -> HTTP ${after.res.status()}: ${after.text}`).toBeTruthy();

    const comments = arrayFromDetail(after.json, 'comments');
    expect(
      comments.some((entry: any) => String(entry.content || '').includes(commentText)),
      `Lista komentarzy nie zawiera komentarza testowego. Komentarze: ${stringifyArray(comments)}`
    ).toBeTruthy();

    const attachments = arrayFromDetail(after.json, 'attachments');
    expect(
      attachments.some((entry: any) => String(entry.original_filename || entry.filename || '').includes(attachmentName)),
      `Lista załączników nie zawiera pliku testowego. Załączniki: ${stringifyArray(attachments)}`
    ).toBeTruthy();

    const events = arrayFromDetail(after.json, 'events');
    expect(events.length, 'Historia aktywności powinna mieć nowe wpisy po komentarzu i załączniku.').toBeGreaterThan(beforeEvents);
    const eventsText = stringifyArray(events);
    expect(eventsText, 'Historia aktywności powinna zawierać komentarz albo zdarzenie komentarza.').toMatch(new RegExp(`${escapeRegExp(commentText)}|komentarz|comment`, 'i'));
    expect(eventsText, 'Historia aktywności powinna zawierać załącznik albo zdarzenie załącznika.').toMatch(new RegExp(`${escapeRegExp(attachmentName)}|załącznik|attachment|plik`, 'i'));
  });

  test('UI szczegółów zgłoszenia pokazuje historię statusu i historię aktywności bez błędów krytycznych', async ({ page, request }) => {
    const created = await apiCreateTicket(request, 'E2E UI historia');
    const { targetStatus } = await pickAnyTargetStatus(request, created.sid, created.id);
    const commentText = `Komentarz UI historia ${new Date().toISOString()}`;

    const comment = await apiJson(request, 'POST', `/api/tickets/${created.id}/comments`, created.sid, {
      data: { content: commentText, visibility: 'public' }
    });
    expect(comment.res.ok(), `Dodanie komentarza do UI historii -> HTTP ${comment.res.status()}: ${comment.text}`).toBeTruthy();

    const change = await apiJson(request, 'POST', `/api/tickets/${created.id}/status`, created.sid, { data: { status: targetStatus } });
    expect(change.res.ok(), `Zmiana statusu do UI historii -> HTTP ${change.res.status()}: ${change.text}`).toBeTruthy();

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('response', response => {
      if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    });

    await login(page);
    await openTicketInUi(page, created.id);

    await expect(page.locator('body')).toContainText(/Historia statusu|Historia aktywności|Aktywność/i, { timeout: 15000 });
    await expect(page.locator('body')).toContainText(commentText, { timeout: 15000 });
    await expect(page.locator('body')).toContainText(targetStatus, { timeout: 15000 });

    const realConsoleErrors = consoleErrors.filter(e => !isIgnorableConsoleError(e));
    expect(pageErrors, `Błędy JavaScript runtime w historii zgłoszenia: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(realConsoleErrors, `Błędy console.error w historii zgłoszenia: ${realConsoleErrors.join('\n')}`).toHaveLength(0);
    expect(serverErrors, `Błędy HTTP 5xx w historii zgłoszenia: ${serverErrors.join('\n')}`).toHaveLength(0);
  });
});


test.describe('Helpdesk E2E zarządzanie użytkownikami', () => {
  async function cleanupUser(request: APIRequestContext, sid: string, email: string) {
    if (!email) return;
    await apiJson(request, 'DELETE', `/api/admin/users/${encodeURIComponent(email)}`, sid).catch(() => undefined);
  }

  test('administrator tworzy, edytuje, resetuje hasło i usuwa użytkownika testowego', async ({ request }) => {
    const sid = await apiLogin(request);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
    const email = `e2e-user-${stamp}@example.local`;
    const initialPassword = `E2eStart-${Date.now()}!`;
    const newPassword = `E2eReset-${Date.now()}!`;

    await cleanupUser(request, sid, email);

    try {
      const created = await apiJson(request, 'POST', '/api/admin/users', sid, {
        data: {
          first_name: 'E2E',
          last_name: 'Użytkownik',
          email,
          department: 'IT',
          roles: ['user'],
          password: initialPassword
        }
      });
      expect(created.res.ok(), `Utworzenie użytkownika -> HTTP ${created.res.status()}: ${created.text}`).toBeTruthy();
      expect([200, 201]).toContain(created.res.status());

      const listed = await apiJson(request, 'GET', '/api/admin/users', sid);
      expect(listed.res.ok(), `Lista użytkowników -> HTTP ${listed.res.status()}: ${listed.text}`).toBeTruthy();
      const users = Array.isArray(listed.json.users) ? listed.json.users : [];
      expect(
        users.some((u: any) => String(u.email || '').toLowerCase() === email),
        `Lista użytkowników nie zawiera ${email}. Odpowiedź: ${listed.text.slice(0, 1500)}`
      ).toBeTruthy();

      const detail = await apiJson(request, 'GET', `/api/admin/users/${encodeURIComponent(email)}`, sid);
      expect(detail.res.ok(), `Szczegóły użytkownika -> HTTP ${detail.res.status()}: ${detail.text}`).toBeTruthy();
      expect(String(detail.json.email || '').toLowerCase()).toBe(email);
      expect(detail.json.roles || [], `Nowy użytkownik powinien mieć rolę user: ${detail.text}`).toContain('user');

      const userSid = await apiLoginWith(request, email, initialPassword);
      const userPerms = await apiJson(request, 'GET', '/api/permissions/me', userSid);
      expect(userPerms.res.ok(), `Uprawnienia nowego użytkownika -> HTTP ${userPerms.res.status()}: ${userPerms.text}`).toBeTruthy();
      expect(JSON.stringify(userPerms.json), 'Nowe konto powinno mieć profil/rolę user.').toMatch(/user/i);

      const updated = await apiJson(request, 'PUT', `/api/admin/users/${encodeURIComponent(email)}`, sid, {
        data: {
          first_name: 'E2E',
          last_name: 'Operator',
          department: 'IT',
          roles: ['operator']
        }
      });
      expect(updated.res.ok(), `Edycja użytkownika -> HTTP ${updated.res.status()}: ${updated.text}`).toBeTruthy();

      const updatedDetail = await apiJson(request, 'GET', `/api/admin/users/${encodeURIComponent(email)}`, sid);
      expect(updatedDetail.res.ok(), `Szczegóły po edycji -> HTTP ${updatedDetail.res.status()}: ${updatedDetail.text}`).toBeTruthy();
      expect(updatedDetail.json.roles || [], `Po edycji użytkownik powinien mieć rolę operator: ${updatedDetail.text}`).toContain('operator');
      expect(String(updatedDetail.json.last_name || '')).toBe('Operator');

      const reset = await apiJson(request, 'POST', `/api/admin/users/${encodeURIComponent(email)}/password`, sid, {
        data: { new_password: newPassword, confirm_password: newPassword }
      });
      expect(reset.res.ok(), `Reset hasła -> HTTP ${reset.res.status()}: ${reset.text}`).toBeTruthy();

      const oldLogin = await request.post(`${baseURL}/api/login`, { data: { email, password: initialPassword } });
      expect(oldLogin.ok(), 'Stare hasło nie powinno działać po resecie.').toBeFalsy();

      const newSid = await apiLoginWith(request, email, newPassword);
      const meAfterReset = await apiJson(request, 'GET', '/api/me', newSid);
      expect(meAfterReset.res.ok(), `Login po resecie hasła -> HTTP ${meAfterReset.res.status()}: ${meAfterReset.text}`).toBeTruthy();

      const deleted = await apiJson(request, 'DELETE', `/api/admin/users/${encodeURIComponent(email)}`, sid);
      expect(deleted.res.ok(), `Usunięcie użytkownika -> HTTP ${deleted.res.status()}: ${deleted.text}`).toBeTruthy();

      const missing = await apiJson(request, 'GET', `/api/admin/users/${encodeURIComponent(email)}`, sid);
      expect(missing.res.status(), `Po usunięciu użytkownik powinien zwracać 404, otrzymano ${missing.res.status()}: ${missing.text}`).toBe(404);

      const loginDeleted = await request.post(`${baseURL}/api/login`, { data: { email, password: newPassword } });
      expect(loginDeleted.ok(), 'Usunięte konto nie powinno umożliwiać logowania.').toBeFalsy();
    } finally {
      await cleanupUser(request, sid, email);
    }
  });

  test('API użytkowników odrzuca duplikat i blokuje usunięcie własnego konta administratora', async ({ request }) => {
    const sid = await apiLogin(request);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
    const email = `e2e-duplicate-${stamp}@example.local`;
    const password = `E2eDuplicate-${Date.now()}!`;

    await cleanupUser(request, sid, email);

    try {
      const create = await apiJson(request, 'POST', '/api/admin/users', sid, {
        data: {
          first_name: 'E2E',
          last_name: 'Duplikat',
          email,
          department: 'IT',
          roles: ['user'],
          password
        }
      });
      expect(create.res.ok(), `Utworzenie użytkownika do testu duplikatu -> HTTP ${create.res.status()}: ${create.text}`).toBeTruthy();

      const duplicate = await apiJson(request, 'POST', '/api/admin/users', sid, {
        data: {
          first_name: 'E2E',
          last_name: 'Duplikat',
          email,
          department: 'IT',
          roles: ['user'],
          password
        }
      });
      expect(duplicate.res.status(), `Duplikat użytkownika powinien zwrócić 409, otrzymano ${duplicate.res.status()}: ${duplicate.text}`).toBe(409);

      const selfDelete = await apiJson(request, 'DELETE', `/api/admin/users/${encodeURIComponent(adminEmail)}`, sid);
      expect(selfDelete.res.status(), `Usunięcie własnego konta powinno być zablokowane 4xx, otrzymano ${selfDelete.res.status()}: ${selfDelete.text}`).toBeGreaterThanOrEqual(400);
      expect(selfDelete.res.status(), `Usunięcie własnego konta powinno być zablokowane 4xx, otrzymano ${selfDelete.res.status()}: ${selfDelete.text}`).toBeLessThan(500);
    } finally {
      await cleanupUser(request, sid, email);
    }
  });

  test('UI modułu Użytkownicy otwiera się bez błędów krytycznych', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('response', response => {
      if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    });

    await login(page);
    const canRender = await page.evaluate(() => typeof (window as any).renderAdminUsers === 'function').catch(() => false);
    if (canRender) {
      await page.evaluate(() => (window as any).renderAdminUsers());
    } else {
      await clickFirstVisible(page, [
        'button:has-text("Użytkownicy")',
        'a:has-text("Użytkownicy")',
        'text=Użytkownicy'
      ]);
    }
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toContainText(/Użytkownicy|Zarządzanie użytkownikami|Role/i, { timeout: 15000 });

    const realConsoleErrors = consoleErrors.filter(e => !isIgnorableConsoleError(e));
    expect(pageErrors, `Błędy JavaScript runtime w module Użytkownicy: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(realConsoleErrors, `Błędy console.error w module Użytkownicy: ${realConsoleErrors.join('\n')}`).toHaveLength(0);
    expect(serverErrors, `Błędy HTTP 5xx w module Użytkownicy: ${serverErrors.join('\n')}`).toHaveLength(0);
  });
});

});
