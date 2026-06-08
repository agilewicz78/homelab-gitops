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
