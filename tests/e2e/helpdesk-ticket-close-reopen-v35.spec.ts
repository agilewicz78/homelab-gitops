import { test, expect, APIRequestContext } from '@playwright/test';

/**
 * helpdesk-ticket-close-reopen-v35.spec.ts
 *
 * v35 — zamknięcie i ponowne otwarcie zgłoszenia.
 *
 * Zakres:
 * 1. Zwykły endpoint zmiany statusu nie może służyć do ustawienia statusu "Zamknięte".
 * 2. Zgłoszenie można zamknąć tylko przez dedykowany endpoint /api/tickets/:id/close.
 * 3. Zamknięcie zapisuje status "Zamknięte", czas rozwiązania, komentarz końcowy i opcjonalny załącznik.
 * 4. Zamknięte zgłoszenie jest tylko do odczytu dla operacji mutujących, np. komentarz/załącznik/status.
 * 5. Ponowne otwarcie wymaga powodu.
 * 6. Admin może ponownie otworzyć zamknięte zgłoszenie.
 * 7. Po ponownym otwarciu można znowu dodać komentarz.
 * 8. Historia/zdarzenia zgłoszenia zawierają zamknięcie i ponowne otwarcie.
 *
 * Ten plik nie nadpisuje testów v30-v34.
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
    throw new Error('Ustaw HELPDESK_ADMIN_EMAIL oraz HELPDESK_ADMIN_PASSWORD przed uruchomieniem testów v35.');
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

async function createTicket(
  request: APIRequestContext,
  sid: string,
  titlePrefix: string
): Promise<{ id: number; title: string; status: string }> {
  const title = `${titlePrefix} ${uniqueStamp()}`;

  const created = await apiJson(request, 'POST', '/api/tickets', sid, {
    data: {
      title,
      description: 'Zgłoszenie testowe v35 — zamknięcie i ponowne otwarcie.',
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

  const detail = await getTicketDetail(request, sid, ticketId);
  const ticket = ticketFromDetail(detail);

  return {
    id: ticketId,
    title,
    status: ticket.status || 'Nowe',
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

async function addComment(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  content: string,
  expectedOk = true
): Promise<ApiResult> {
  const response = await apiJson(request, 'POST', `/api/tickets/${ticketId}/comments`, sid, {
    data: {
      content,
      visibility: 'public',
    },
  });

  if (expectedOk) {
    expect(
      response.res.ok(),
      `Dodanie komentarza do zgłoszenia #${ticketId} zwróciło HTTP ${response.res.status()}: ${response.text}`
    ).toBeTruthy();
  } else {
    expect(
      response.res.status(),
      `Dodanie komentarza do zamkniętego zgłoszenia powinno być zablokowane. Odpowiedź: HTTP ${response.res.status()} ${response.text}`
    ).toBeGreaterThanOrEqual(400);

    expect(response.res.status()).toBeLessThan(500);
  }

  return response;
}

async function addAttachment(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  fileName: string,
  expectedOk = true
): Promise<ApiResult> {
  const response = await apiJson(request, 'POST', `/api/tickets/${ticketId}/attachments`, sid, {
    multipart: {
      file: {
        name: fileName,
        mimeType: 'text/plain',
        buffer: Buffer.from(`Załącznik testowy v35 dla zgłoszenia #${ticketId}\n`),
      },
    },
  });

  if (expectedOk) {
    expect(
      response.res.ok(),
      `Dodanie załącznika do zgłoszenia #${ticketId} zwróciło HTTP ${response.res.status()}: ${response.text}`
    ).toBeTruthy();
  } else {
    expect(
      response.res.status(),
      `Dodanie załącznika do zamkniętego zgłoszenia powinno być zablokowane. Odpowiedź: HTTP ${response.res.status()} ${response.text}`
    ).toBeGreaterThanOrEqual(400);

    expect(response.res.status()).toBeLessThan(500);
  }

  return response;
}

async function changeStatus(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  status: string
): Promise<ApiResult> {
  return apiJson(request, 'POST', `/api/tickets/${ticketId}/status`, sid, {
    data: {
      status,
    },
  });
}

async function closeTicket(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  options: {
    summary: string;
    hours?: string;
    minutes?: string;
    visibility?: 'public' | 'internal';
    fileName?: string;
  }
): Promise<ApiResult> {
  const multipart: Record<string, any> = {
    resolution_hours: options.hours ?? '1',
    resolution_minutes: options.minutes ?? '15',
    resolution_summary: options.summary,
    visibility: options.visibility ?? 'public',
  };

  if (options.fileName) {
    multipart.file = {
      name: options.fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from(`Załącznik końcowy v35 dla zgłoszenia #${ticketId}\n`),
    };
  }

  return apiJson(request, 'POST', `/api/tickets/${ticketId}/close`, sid, {
    multipart,
  });
}

async function reopenTicket(
  request: APIRequestContext,
  sid: string,
  ticketId: number,
  reason?: string
): Promise<ApiResult> {
  return apiJson(request, 'POST', `/api/tickets/${ticketId}/reopen`, sid, {
    data: reason === undefined ? {} : { reason },
  });
}

function expectPayloadContains(payload: any, expected: string, message: string) {
  expect(
    jsonText(payload).includes(expected),
    `${message}\nSzukano: ${expected}\nOdpowiedź: ${jsonText(payload).slice(0, 3000)}`
  ).toBeTruthy();
}

function expectPayloadMatches(payload: any, pattern: RegExp, message: string) {
  expect(
    jsonText(payload),
    `${message}\nOdpowiedź: ${jsonText(payload).slice(0, 3000)}`
  ).toMatch(pattern);
}

test.describe('Helpdesk E2E v35 — zamknięcie i ponowne otwarcie zgłoszenia', () => {
  test('blokuje zwykłą zmianę statusu na Zamknięte i wymaga dedykowanego endpointu close', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicket(request, sid, 'E2E v35 direct close blocked');

    const directClose = await changeStatus(request, sid, ticket.id, 'Zamknięte');

    expect(
      directClose.res.status(),
      `Zwykły endpoint /status nie powinien zamykać zgłoszenia. Odpowiedź: HTTP ${directClose.res.status()} ${directClose.text}`
    ).toBeGreaterThanOrEqual(400);

    expect(directClose.res.status()).toBeLessThan(500);

    expectPayloadMatches(
      directClose.json,
      /zamkn|formularz|close|dedykowan/i,
      'Odpowiedź powinna sugerować użycie dedykowanego mechanizmu zamknięcia albo blokować status Zamknięte.'
    );

    const detail = await getTicketDetail(request, sid, ticket.id);
    expect(ticketFromDetail(detail).status).not.toBe('Zamknięte');
  });

  test('zamyka zgłoszenie przez /close z komentarzem końcowym, czasem rozwiązania i załącznikiem', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicket(request, sid, 'E2E v35 close with summary');
    const summary = `Podsumowanie zamknięcia v35 ${uniqueStamp()}`;
    const fileName = `e2e-v35-close-${Date.now()}.txt`;

    const close = await closeTicket(request, sid, ticket.id, {
      summary,
      hours: '2',
      minutes: '30',
      visibility: 'public',
      fileName,
    });

    expect(
      close.res.ok(),
      `Zamknięcie zgłoszenia przez /close zwróciło HTTP ${close.res.status()}: ${close.text}`
    ).toBeTruthy();

    expect(close.json.ticket_status).toBe('Zamknięte');

    const detail = await getTicketDetail(request, sid, ticket.id);
    const closedTicket = ticketFromDetail(detail);

    expect(closedTicket.status).toBe('Zamknięte');
    expect(Number(closedTicket.resolution_minutes)).toBe(150);
    expect(closedTicket.closed_at).toBeTruthy();
    expect(closedTicket.closed_by_email).toBeTruthy();

    expectPayloadContains(detail, summary, 'Szczegóły zgłoszenia powinny zawierać komentarz końcowy.');
    expectPayloadContains(detail, fileName, 'Szczegóły zgłoszenia powinny zawierać załącznik dodany przy zamknięciu.');
    expectPayloadMatches(detail, /ticket_closed|close_ticket|Zgłoszenie zamknięte|Zamknięte/i, 'Historia/zdarzenia powinny zawierać zamknięcie zgłoszenia.');
  });

  test('po zamknięciu zgłoszenie jest tylko do odczytu dla komentarzy, załączników i statusu', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicket(request, sid, 'E2E v35 read only after close');
    const summary = `Zamknięcie do testu read-only v35 ${uniqueStamp()}`;

    const close = await closeTicket(request, sid, ticket.id, {
      summary,
      hours: '1',
      minutes: '0',
      visibility: 'public',
    });

    expect(close.res.ok(), `Zamknięcie zgłoszenia zwróciło HTTP ${close.res.status()}: ${close.text}`).toBeTruthy();

    const commentAfterClose = await addComment(
      request,
      sid,
      ticket.id,
      `Komentarz po zamknięciu v35 ${uniqueStamp()}`,
      false
    );

    expectPayloadMatches(
      commentAfterClose.json,
      /zamknięte|zamkniete|read.?only|tylko do odczytu|closed/i,
      'Komentarz do zamkniętego zgłoszenia powinien zwrócić komunikat o trybie tylko do odczytu.'
    );

    const attachmentAfterClose = await addAttachment(
      request,
      sid,
      ticket.id,
      `e2e-v35-after-close-${Date.now()}.txt`,
      false
    );

    expectPayloadMatches(
      attachmentAfterClose.json,
      /zamknięte|zamkniete|read.?only|tylko do odczytu|closed/i,
      'Załącznik do zamkniętego zgłoszenia powinien zwrócić komunikat o trybie tylko do odczytu.'
    );

    const statusAfterClose = await changeStatus(request, sid, ticket.id, 'W trakcie');

    expect(
      statusAfterClose.res.status(),
      `Zmiana statusu zamkniętego zgłoszenia powinna być zablokowana. Odpowiedź: HTTP ${statusAfterClose.res.status()} ${statusAfterClose.text}`
    ).toBeGreaterThanOrEqual(400);

    expect(statusAfterClose.res.status()).toBeLessThan(500);

    expectPayloadMatches(
      statusAfterClose.json,
      /zamknięte|zamkniete|read.?only|tylko do odczytu|closed/i,
      'Zmiana statusu zamkniętego zgłoszenia powinna zwrócić komunikat o trybie tylko do odczytu.'
    );
  });

  test('ponowne otwarcie wymaga powodu, a po podaniu powodu odblokowuje zgłoszenie', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicket(request, sid, 'E2E v35 reopen');
    const closeSummary = `Zamknięcie przed reopen v35 ${uniqueStamp()}`;
    const reopenReason = `Powód ponownego otwarcia v35 ${uniqueStamp()}`;
    const commentAfterReopen = `Komentarz po ponownym otwarciu v35 ${uniqueStamp()}`;

    const close = await closeTicket(request, sid, ticket.id, {
      summary: closeSummary,
      hours: '0',
      minutes: '45',
      visibility: 'public',
    });

    expect(close.res.ok(), `Zamknięcie zgłoszenia zwróciło HTTP ${close.res.status()}: ${close.text}`).toBeTruthy();

    const reopenWithoutReason = await reopenTicket(request, sid, ticket.id);

    expect(
      reopenWithoutReason.res.status(),
      `Ponowne otwarcie bez powodu powinno być zablokowane. Odpowiedź: HTTP ${reopenWithoutReason.res.status()} ${reopenWithoutReason.text}`
    ).toBe(400);

    expectPayloadMatches(
      reopenWithoutReason.json,
      /powód|powod|reason|required|wymagan/i,
      'Odpowiedź reopen bez powodu powinna informować o wymaganym powodzie.'
    );

    const reopen = await reopenTicket(request, sid, ticket.id, reopenReason);

    expect(
      reopen.res.ok(),
      `Ponowne otwarcie z powodem zwróciło HTTP ${reopen.res.status()}: ${reopen.text}`
    ).toBeTruthy();

    const reopenedDetail = await getTicketDetail(request, sid, ticket.id);
    const reopenedTicket = ticketFromDetail(reopenedDetail);

    expect(reopenedTicket.status).not.toBe('Zamknięte');

    expectPayloadContains(
      reopenedDetail,
      reopenReason,
      'Historia/zdarzenia zgłoszenia powinny zawierać powód ponownego otwarcia.'
    );

    expectPayloadMatches(
      reopenedDetail,
      /ticket_reopened|reopen_ticket|otwarte ponownie|ponownie/i,
      'Historia/zdarzenia zgłoszenia powinny zawierać ponowne otwarcie.'
    );

    await addComment(request, sid, ticket.id, commentAfterReopen, true);

    const afterCommentDetail = await getTicketDetail(request, sid, ticket.id);

    expectPayloadContains(
      afterCommentDetail,
      commentAfterReopen,
      'Po ponownym otwarciu zgłoszenia powinno być możliwe dodanie komentarza.'
    );
  });

  test('nie pozwala ponownie otworzyć zgłoszenia, które nie jest zamknięte', async ({ request }) => {
    const sid = await apiLogin(request);
    const ticket = await createTicket(request, sid, 'E2E v35 reopen not closed');

    const reopen = await reopenTicket(
      request,
      sid,
      ticket.id,
      `Próba reopen niezamkniętego zgłoszenia v35 ${uniqueStamp()}`
    );

    expect(
      reopen.res.status(),
      `Ponowne otwarcie niezamkniętego zgłoszenia powinno być zablokowane. Odpowiedź: HTTP ${reopen.res.status()} ${reopen.text}`
    ).toBe(400);

    expectPayloadMatches(
      reopen.json,
      /zamknięte|zamkniete|closed|tylko zamknięte|tylko zamkniete/i,
      'Odpowiedź powinna informować, że tylko zamknięte zgłoszenie można otworzyć ponownie.'
    );
  });
});
