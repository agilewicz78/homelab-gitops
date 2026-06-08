import { test, expect, APIRequestContext } from '@playwright/test';

/**
 * helpdesk-attachments-validation-download-v37.spec.ts
 *
 * v37.1 — poprawka endpointu pobierania załącznika.
 *
 * v37 — walidacja i pobieranie załączników.
 *
 * Zakres:
 * 1. Upload dozwolonego pliku .txt przechodzi.
 * 2. Upload niedozwolonego pliku .exe jest blokowany.
 * 3. Upload niedozwolonego pliku .sh jest blokowany.
 * 4. Upload pustego pliku jest blokowany.
 * 5. Upload pliku powyżej limitu 10 MB jest blokowany.
 * 6. Pobranie istniejącego załącznika zwraca poprawną zawartość/nagłówki.
 * 7. Użytkownik bez dostępu do zgłoszenia nie może pobrać załącznika.
 *
 * Ten plik nie nadpisuje testów v30-v36.
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
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów v37.');
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

async function apiLogin(request: APIRequestContext, email = adminEmail, password = adminPassword): Promise<string> {
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

async function createTicket(
  request: APIRequestContext,
  sid: string,
  titlePrefix: string
): Promise<{ id: number; title: string }> {
  const title = `${titlePrefix} ${uniqueStamp()}`;

  const created = await apiJson(request, 'POST', '/api/tickets', sid, {
    data: {
      title,
      description: 'Zgłoszenie testowe v37 — walidacja i pobieranie załączników.',
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

async function getTicketDetail(request: APIRequestContext, sid: string, ticketId: number) {
  const detail = await apiJson(request, 'GET', `/api/tickets/${ticketId}`, sid);

  expect(
    detail.res.ok(),
    `Pobranie szczegółów zgłoszenia #${ticketId} zwróciło HTTP ${detail.res.status()}: ${detail.text}`
  ).toBeTruthy();

  return detail.json;
}

async function uploadAttachment(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  fileName: string,
  buffer: Buffer,
  mimeType = 'text/plain'
): Promise<ApiResult> {
  return apiJson(request, 'POST', `/api/tickets/${ticketId}/attachments`, sid, {
    multipart: {
      file: {
        name: fileName,
        mimeType,
        buffer,
      },
    },
  });
}

function expectControlledClientError(response: ApiResult, message: string) {
  expect(
    response.res.status(),
    `${message}. Odpowiedź: HTTP ${response.res.status()} ${response.text}`
  ).toBeGreaterThanOrEqual(400);

  expect(
    response.res.status(),
    `${message}. To powinien być kontrolowany błąd 4xx, nie 5xx. Odpowiedź: HTTP ${response.res.status()} ${response.text}`
  ).toBeLessThan(500);
}

function expectPayloadMatches(payload: any, pattern: RegExp, message: string) {
  expect(
    jsonText(payload),
    `${message}\nOdpowiedź: ${jsonText(payload).slice(0, 3000)}`
  ).toMatch(pattern);
}

function extractAttachmentFromPayload(payload: any, fileName: string): any | undefined {
  const seen = new Set<any>();

  function walk(value: any): any | undefined {
    if (!value || typeof value !== 'object') return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);

    if (
      typeof value.filename === 'string' && value.filename === fileName ||
      typeof value.file_name === 'string' && value.file_name === fileName ||
      typeof value.name === 'string' && value.name === fileName ||
      typeof value.original_filename === 'string' && value.original_filename === fileName
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) return found;
      }
    } else {
      for (const item of Object.values(value)) {
        const found = walk(item);
        if (found) return found;
      }
    }

    return undefined;
  }

  return walk(payload);
}

function extractAttachmentId(attachment: any): string {
  const id =
    attachment?.id ??
    attachment?.attachment_id ??
    attachment?.file_id ??
    attachment?.uuid;

  expect(
    id,
    `Nie udało się ustalić ID załącznika z obiektu: ${JSON.stringify(attachment)}`
  ).toBeTruthy();

  return String(id);
}

async function downloadAttachment(
  request: APIRequestContext,
  sid: string,
  attachmentId: string
) {
  /**
   * Backend używa globalnego endpointu pobierania:
   *
   * GET /api/attachments/<attachment_id>/download
   *
   * Nie:
   *
   * GET /api/tickets/<ticket_id>/attachments/<attachment_id>
   *
   * Kontrola dostępu nadal jest wykonywana po stronie backendu przez can_view_ticket().
   */
  return request.fetch(`${baseURL}/api/attachments/${encodeURIComponent(attachmentId)}/download`, {
    method: 'GET',
    headers: {
      'X-Helpdesk-Session': sid,
    },
  });
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

test.describe('Helpdesk E2E v37.1 — walidacja i pobieranie załączników', () => {
  test('pozwala wgrać dozwolony plik .txt i pobrać go z poprawną zawartością', async ({ request }) => {
    const sid = await adminSid(request);
    const ticket = await createTicket(request, sid, 'E2E v37 txt download');

    const fileName = `e2e-v37-allowed-${Date.now()}.txt`;
    const fileContent = `Dozwolony załącznik TXT v37 dla zgłoszenia #${ticket.id}\n`;

    const upload = await uploadAttachment(
      request,
      sid,
      ticket.id,
      fileName,
      Buffer.from(fileContent, 'utf-8'),
      'text/plain'
    );

    expect(
      upload.res.ok(),
      `Upload dozwolonego .txt zwrócił HTTP ${upload.res.status()}: ${upload.text}`
    ).toBeTruthy();

    const detail = await getTicketDetail(request, sid, ticket.id);
    const attachment = extractAttachmentFromPayload(detail, fileName);

    expect(
      attachment,
      `Szczegóły zgłoszenia powinny zawierać załącznik ${fileName}. Odpowiedź: ${jsonText(detail).slice(0, 3000)}`
    ).toBeTruthy();

    const attachmentId = extractAttachmentId(attachment);
    const download = await downloadAttachment(request, sid, attachmentId);
    const downloadedText = await download.text();

    expect(
      download.ok(),
      `Pobranie załącznika ${attachmentId} zwróciło HTTP ${download.status()}: ${downloadedText}`
    ).toBeTruthy();

    const contentDisposition = download.headers()['content-disposition'] || '';
    expect(
      contentDisposition + downloadedText,
      `Pobranie powinno zawierać nazwę pliku w nagłówku albo prawidłową zawartość. content-disposition=${contentDisposition}`
    ).toMatch(new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|' + 'Dozwolony załącznik TXT v37'));

    expect(downloadedText).toContain('Dozwolony załącznik TXT v37');
  });

  test('blokuje upload niedozwolonego pliku .exe', async ({ request }) => {
    const sid = await adminSid(request);
    const ticket = await createTicket(request, sid, 'E2E v37 exe rejected');

    const response = await uploadAttachment(
      request,
      sid,
      ticket.id,
      `e2e-v37-malware-${Date.now()}.exe`,
      Buffer.from('MZ fake exe content'),
      'application/octet-stream'
    );

    expectControlledClientError(response, 'Upload pliku .exe powinien być zablokowany');

    expectPayloadMatches(
      response.json,
      /typ|rozszerz|extension|allowed|niedozwol|dozwolone|plik/i,
      'Odpowiedź powinna informować o niedozwolonym typie/rozszerzeniu pliku.'
    );
  });

  test('blokuje upload niedozwolonego pliku .sh', async ({ request }) => {
    const sid = await adminSid(request);
    const ticket = await createTicket(request, sid, 'E2E v37 sh rejected');

    const response = await uploadAttachment(
      request,
      sid,
      ticket.id,
      `e2e-v37-script-${Date.now()}.sh`,
      Buffer.from('#!/bin/bash\necho test\n'),
      'application/x-sh'
    );

    expectControlledClientError(response, 'Upload pliku .sh powinien być zablokowany');

    expectPayloadMatches(
      response.json,
      /typ|rozszerz|extension|allowed|niedozwol|dozwolone|plik/i,
      'Odpowiedź powinna informować o niedozwolonym typie/rozszerzeniu pliku.'
    );
  });

  test('blokuje upload pustego pliku', async ({ request }) => {
    const sid = await adminSid(request);
    const ticket = await createTicket(request, sid, 'E2E v37 empty file rejected');

    const response = await uploadAttachment(
      request,
      sid,
      ticket.id,
      `e2e-v37-empty-${Date.now()}.txt`,
      Buffer.alloc(0),
      'text/plain'
    );

    expectControlledClientError(response, 'Upload pustego pliku powinien być zablokowany');

    expectPayloadMatches(
      response.json,
      /pust|empty|rozmiar|size|plik/i,
      'Odpowiedź powinna informować o pustym pliku albo nieprawidłowym rozmiarze.'
    );
  });

  test('blokuje upload pliku większego niż 10 MB', async ({ request }) => {
    const sid = await adminSid(request);
    const ticket = await createTicket(request, sid, 'E2E v37 too large rejected');

    /**
     * Backend deklaruje limit 10 MB; wysyłamy minimalnie więcej.
     */
    const tooLargeBuffer = Buffer.alloc(10 * 1024 * 1024 + 1, 'a');

    const response = await uploadAttachment(
      request,
      sid,
      ticket.id,
      `e2e-v37-too-large-${Date.now()}.txt`,
      tooLargeBuffer,
      'text/plain'
    );

    expectControlledClientError(response, 'Upload pliku większego niż 10 MB powinien być zablokowany');

    expectPayloadMatches(
      response.json,
      /10\s*MB|limit|rozmiar|size|duży|duzy|large|plik/i,
      'Odpowiedź powinna informować o limicie rozmiaru pliku.'
    );
  });

  test('użytkownik bez dostępu do zgłoszenia nie może pobrać załącznika', async ({ request }) => {
    const sid = await adminSid(request);
    const normalUser = await getNormalUser(request, sid);
    const ticket = await createTicket(request, sid, 'E2E v37 forbidden download');

    const fileName = `e2e-v37-private-${Date.now()}.txt`;

    const upload = await uploadAttachment(
      request,
      sid,
      ticket.id,
      fileName,
      Buffer.from(`Prywatny załącznik v37 dla zgłoszenia #${ticket.id}\n`, 'utf-8'),
      'text/plain'
    );

    expect(upload.res.ok(), `Upload pliku testowego zwrócił HTTP ${upload.res.status()}: ${upload.text}`).toBeTruthy();

    const detail = await getTicketDetail(request, sid, ticket.id);
    const attachment = extractAttachmentFromPayload(detail, fileName);
    expect(attachment, `Nie znaleziono załącznika ${fileName} w szczegółach zgłoszenia.`).toBeTruthy();

    const attachmentId = extractAttachmentId(attachment);
    const userSid = await apiLogin(request, normalUser.email, adminPassword);

    const forbidden = await downloadAttachment(request, userSid, attachmentId);
    const forbiddenText = await forbidden.text();

    expect(
      [403, 404].includes(forbidden.status()),
      `Użytkownik bez dostępu do zgłoszenia nie powinien pobrać załącznika. Odpowiedź: HTTP ${forbidden.status()} ${forbiddenText}`
    ).toBeTruthy();
  });
});
