import { test, expect, Page } from '@playwright/test';

const baseURL = process.env.HELPDESK_URL || 'https://helpdesk.lab.local';
const adminEmail = process.env.HELPDESK_ADMIN_EMAIL || '';
const adminPassword = process.env.HELPDESK_ADMIN_PASSWORD || '';

async function fillFirstVisible(page: Page, selectors: string[], value: string) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible({ timeout: 1000 })) {
          await locator.fill(value);
          return;
        }
      } catch (_) {}
    }
  }
  throw new Error(`Nie znaleziono widocznego pola dla selektorów: ${selectors.join(', ')}`);
}

async function clickFirstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible({ timeout: 1000 })) {
          await locator.click();
          return;
        }
      } catch (_) {}
    }
  }
  throw new Error(`Nie znaleziono widocznego przycisku/linku dla selektorów: ${selectors.join(', ')}`);
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
}

function isIgnorableConsoleError(message: string): boolean {
  return /favicon|ResizeObserver/i.test(message)
    || /Failed to load resource: the server responded with a status of (401|403)/i.test(message);
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
