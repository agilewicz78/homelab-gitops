const { test, expect } = require('@playwright/test');

test('helpdesk responds and renders visible content', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });

  expect(response, 'The helpdesk did not return an HTTP response').not.toBeNull();
  expect(response.status(), 'The helpdesk returned a server error').toBeLessThan(500);
  await expect(page.locator('body')).toBeVisible();

  const bodyText = (await page.locator('body').innerText()).trim();
  expect(bodyText, 'The helpdesk rendered an empty page').not.toBe('');
  expect(pageErrors, 'The page raised a JavaScript error').toEqual([]);
});

test('health endpoint reports a healthy application', async ({ request }) => {
  const response = await request.get('/healthz');

  expect(response.status()).toBe(200);
  expect((await response.text()).toLowerCase()).toMatch(/ok|healthy|status/);
});
