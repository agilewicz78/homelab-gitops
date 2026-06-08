import { test, expect, Page, APIRequestContext } from '@playwright/test';

/**
 * helpdesk-workflow-actions-ui-v31.spec.ts
 *
 * Etap 2 — testy UI listy akcji workflow.
 *
 * Wersja v31.1:
 * - poprawia problem z v31, gdzie pierwszy test zostawał na liście workflow,
 *   bo nagłówek tabeli "AKCJE" spełniał zbyt luźny warunek oczekiwania.
 * - test otwiera workflow przez konkretny przycisk "Edytuj" w wierszu workflow,
 *   a nie przez samo wystąpienie tekstu "Edytuj".
 * - test tworzy tymczasową regułę przez API, żeby formularz/lista reguł miała
 *   kontrolowany wpis z akcjami require_comment i require_attachment.
 */

const baseURL = process.env.HELPDESK_URL || 'https://helpdesk.lab.local';
const adminEmail = process.env.HELPDESK_ADMIN_EMAIL || '';
const adminPassword = process.env.HELPDESK_ADMIN_PASSWORD || '';

type CreatedWorkflowRule = {
  sid: string;
  workflowId: number;
  workflowName: string;
  workflowKey?: string;
  automationId: number;
  ruleName: string;
};

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
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów UI.');
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

async function createWorkflowRuleWithRequiredActionsViaApi(request: APIRequestContext): Promise<CreatedWorkflowRule> {
  const sid = await apiLogin(request);
  const workflowsResponse = await apiJson(request, 'GET', '/api/admin/workflows', sid);

  expect(
    workflowsResponse.res.ok(),
    `Pobranie listy workflow zwróciło HTTP ${workflowsResponse.res.status()}: ${workflowsResponse.text}`
  ).toBeTruthy();

  const workflows = workflowsResponse.json.workflows || [];
  const workflow =
    workflows.find((w: any) => w.workflow_key === 'default') ||
    workflows.find((w: any) => w.is_default) ||
    workflows[0];

  expect(workflow?.id, `Nie znaleziono workflow w odpowiedzi: ${workflowsResponse.text}`).toBeTruthy();

  const statuses: string[] = workflow.statuses || workflow.status_list || ['Nowe', 'W trakcie'];
  const targetStatus = statuses.find((s) => s !== 'Nowe') || statuses[0] || 'W trakcie';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ruleName = `E2E v31 UI akcje workflow ${stamp}`;

  const payload = {
    name: ruleName,
    event_type: 'status_changed',

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
      {
        action_order: 1,
        action_type: 'require_comment',
        action_value: null,
        is_active: true,
      },
      {
        action_order: 2,
        action_type: 'require_attachment',
        action_value: null,
        is_active: true,
      },
    ],

    is_active: true,
    stop_processing: true,
    priority: 1,
  };

  const created = await apiJson(request, 'POST', `/api/admin/workflows/${workflow.id}/automations`, sid, {
    data: payload,
  });

  expect(
    created.res.ok(),
    `Utworzenie reguły workflow v31 zwróciło HTTP ${created.res.status()}: ${created.text}`
  ).toBeTruthy();

  const automationId = Number(created.json.id || created.json.automation_id);
  expect(automationId, `Brak ID reguły workflow w odpowiedzi: ${created.text}`).toBeTruthy();

  return {
    sid,
    workflowId: Number(workflow.id),
    workflowName: workflow.name || 'Standardowy workflow zgłoszenia',
    workflowKey: workflow.workflow_key,
    automationId,
    ruleName,
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

async function openWorkflowAdmin(page: Page) {
  try {
    await clickFirstVisible(page, [
      'a:has-text("Workflow")',
      'button:has-text("Workflow")',
      'text=Workflow',
    ]);
  } catch (clickError) {
    const canRender = await page.evaluate(() => typeof (window as any).renderAdminWorkflows === 'function').catch(() => false);
    if (!canRender) throw clickError;

    await page.evaluate(() => (window as any).renderAdminWorkflows());
  }

  await page.waitForLoadState('networkidle');

  await expect(page.locator('body')).toContainText(/Definicje workflow|Workflow zgłoszeń/i, {
    timeout: 15000,
  });
}

async function openSpecificWorkflowEditor(page: Page, createdRule: CreatedWorkflowRule) {
  /**
   * Otwieramy edycję konkretnego workflow.
   * To jest poprawka względem v31: nie klikamy pierwszego lepszego tekstu "Edytuj",
   * tylko szukamy wiersza zawierającego nazwę albo klucz workflow.
   */
  const workflowIdentity = createdRule.workflowKey || createdRule.workflowName;

  const rowCandidates = [
    page.locator('tr').filter({ hasText: workflowIdentity }).first(),
    page.locator('section, article, div, li').filter({ hasText: workflowIdentity }).first(),
    page.locator('body').filter({ hasText: workflowIdentity }),
  ];

  let clicked = false;

  for (const row of rowCandidates) {
    if (await row.count().catch(() => 0)) {
      const editButton = row.locator('button:has-text("Edytuj"), a:has-text("Edytuj"), text=Edytuj').first();
      if (await editButton.count().catch(() => 0)) {
        await editButton.scrollIntoViewIfNeeded();
        await editButton.click();
        clicked = true;
        break;
      }
    }
  }

  if (!clicked) {
    /**
     * Fallback: klikamy pierwszy widoczny przycisk Edytuj.
     * Po kliknięciu i tak sprawdzimy, czy pojawiła się reguła utworzona przez API.
     */
    await clickFirstVisible(page, [
      'button:has-text("Edytuj")',
      'a:has-text("Edytuj")',
      'text=Edytuj',
    ]);
  }

  await page.waitForLoadState('networkidle');

  /**
   * Bardzo ważne:
   * Nie akceptujemy już samego tekstu "AKCJE", bo występuje on na liście workflow
   * jako nagłówek kolumny i powodował fałszywe przejście do dalszej części testu.
   */
  await expect(page.locator('body')).toContainText(
    new RegExp(`${createdRule.ruleName}|Reguły automatyzacji|Automatyzacje workflow|Test reguły|Dodaj z szablonu`, 'i'),
    {
      timeout: 15000,
    }
  );
}

async function assertRequiredActionLabels(page: Page) {
  const body = await page.locator('body').innerText({ timeout: 15000 });

  expect(
    body,
    'UI workflow musi pokazywać akcję "Wymagaj komentarza" albo jej techniczny typ require_comment.'
  ).toMatch(/Wymagaj komentarza|require_comment|komentarz/i);

  expect(
    body,
    'UI workflow musi pokazywać akcję "Wymagaj załącznika" albo jej techniczny typ require_attachment.'
  ).toMatch(/Wymagaj załącznika|require_attachment|załącznik|zalacznik/i);
}

async function openActionSelectorIfPresent(page: Page) {
  const selectors = [
    'select[name="action_type"]',
    'select[name*="action" i]',
    'select[id*="action" i]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      if (await locator.nth(i).isVisible().catch(() => false)) {
        return locator.nth(i);
      }
    }
  }

  const addActionButton = page.locator('button:has-text("Dodaj akcję"), button:has-text("Dodaj kolejną akcję")').first();

  if (await addActionButton.isVisible().catch(() => false)) {
    await addActionButton.click();
    await page.waitForTimeout(500);

    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let i = 0; i < count; i++) {
        if (await locator.nth(i).isVisible().catch(() => false)) {
          return locator.nth(i);
        }
      }
    }
  }

  return null;
}

test.describe('Helpdesk E2E v31.1 — Etap 2 UI listy akcji workflow', () => {
  test('UI formularza workflow pokazuje akcje "Wymagaj komentarza" i "Wymagaj załącznika"', async ({ page, request }) => {
    const createdRule = await createWorkflowRuleWithRequiredActionsViaApi(request);

    try {
      await login(page);
      await openWorkflowAdmin(page);
      await openSpecificWorkflowEditor(page, createdRule);

      /**
       * Sprawdzamy widoczność akcji na ekranie edycji/listy reguł.
       */
      await expect(page.locator('body')).toContainText(createdRule.ruleName, {
        timeout: 15000,
      });

      await assertRequiredActionLabels(page);

      /**
       * Jeżeli formularz używa selecta/listy wyboru akcji, dodatkowo sprawdzamy opcje.
       * Jeżeli UI renderuje akcje inaczej, wystarczy wcześniejsze sprawdzenie body.
       */
      const actionSelector = await openActionSelectorIfPresent(page);

      if (actionSelector) {
        const optionText = (await actionSelector.locator('option').allTextContents()).join('\n');

        expect(optionText).toMatch(/Wymagaj komentarza|require_comment|komentarz/i);
        expect(optionText).toMatch(/Wymagaj załącznika|require_attachment|załącznik|zalacznik/i);
      }
    } finally {
      await deleteAutomationSafe(
        request,
        createdRule.sid,
        createdRule.workflowId,
        createdRule.automationId
      );
    }
  });

  test('UI pokazuje tymczasową regułę z akcjami require_comment i require_attachment', async ({ page, request }) => {
    const createdRule = await createWorkflowRuleWithRequiredActionsViaApi(request);

    try {
      await login(page);
      await openWorkflowAdmin(page);
      await openSpecificWorkflowEditor(page, createdRule);

      await expect(page.locator('body')).toContainText(createdRule.ruleName, {
        timeout: 15000,
      });

      await assertRequiredActionLabels(page);
    } finally {
      await deleteAutomationSafe(
        request,
        createdRule.sid,
        createdRule.workflowId,
        createdRule.automationId
      );
    }
  });
});
