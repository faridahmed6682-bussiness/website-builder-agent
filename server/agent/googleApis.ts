// Google APIs via OAuth 2.0 refresh-token flow (Gmail / Calendar / Drive / Docs).
// Port of Nexus-ai6 GoogleAuthManager.kt — Android Credential Manager is
// replaced by env vars: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
// GOOGLE_OAUTH_REFRESH_TOKEN (obtained once via Google's OAuth playground or
// a one-time consent flow; never in code). Scopes: gmail.modify, calendar.events,
// drive.file (app-created files only), documents, email, profile.
// Every function returns a clean "not configured" error when the env vars
// are missing — the tools are never registered dead.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

function isGoogleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  );
}

export function googleConfigError(): string {
  return 'Google is not connected. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REFRESH_TOKEN (see README — one-time OAuth setup), then retry.';
}

async function getAccessToken(): Promise<string> {
  if (!isGoogleConfigured()) throw new Error(googleConfigError());
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) {
    return cachedAccessToken.token;
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
      grant_type: 'refresh_token',
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    cachedAccessToken = null;
    throw new Error(`Google token refresh failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  }
  cachedAccessToken = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
  };
  return body.access_token;
}

async function googleFetch(url: string, opts: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* plain text */ }
  if (!res.ok) {
    throw new Error(`Google API error (HTTP ${res.status}): ${String(text).slice(0, 200)}`);
  }
  return body;
}

export { isGoogleConfigured };

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function rfc822(to: string, subject: string, body: string): string {
  return `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`;
}

// --- Gmail -----------------------------------------------------------------
export async function gmailList(maxResults = 5): Promise<string> {
  const list = await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`,
  );
  const messages: any[] = list.messages || [];
  if (!messages.length) return 'Inbox is empty.';
  const lines: string[] = [];
  for (const m of messages.slice(0, maxResults)) {
    const full = await googleFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
    );
    const headers: any[] = full.payload?.headers || [];
    const get = (n: string) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || '';
    lines.push(`• ${get('Subject') || '(no subject)'} — ${get('From') || ''}${full.snippet ? `\n  ${(full.snippet as string).slice(0, 120)}` : ''}`);
  }
  return lines.join('\n');
}

export async function gmailSearch(query: string, maxResults = 5): Promise<string> {
  const list = await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
  );
  const messages: any[] = list.messages || [];
  if (!messages.length) return `No messages found for "${query}".`;
  const lines: string[] = [];
  for (const m of messages.slice(0, maxResults)) {
    const full = await googleFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
    );
    const headers: any[] = full.payload?.headers || [];
    const get = (n: string) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || '';
    lines.push(`• ${get('Subject') || '(no subject)'} — ${get('From') || ''}`);
  }
  return lines.join('\n');
}

export async function gmailSend(to: string, subject: string, body: string): Promise<string> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error(`Invalid recipient email: ${to}`);
  const raw = base64url(rfc822(to, subject, body));
  const sent = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  });
  return `Email sent to ${to} (message id: ${sent.id}).`;
}

export async function gmailDraft(to: string, subject: string, body: string): Promise<string> {
  const raw = base64url(rfc822(to, subject, body));
  const draft = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    body: JSON.stringify({ message: { raw } }),
  });
  return `Draft saved (id: ${draft.id}).`;
}

// --- Calendar ---------------------------------------------------------------
export async function calendarList(maxResults = 5): Promise<string> {
  const now = new Date().toISOString();
  const data = await googleFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now)}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`,
  );
  const items: any[] = data.items || [];
  if (!items.length) return 'No upcoming events.';
  return items
    .map((e) => `• ${e.summary || '(no title)'} — ${e.start?.dateTime || e.start?.date || ''}`)
    .join('\n');
}

export async function calendarCreate(title: string, start: string, end: string): Promise<string> {
  const event = await googleFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    body: JSON.stringify({
      summary: title,
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(end).toISOString() },
    }),
  });
  return `Event created: "${event.summary}" — ${event.htmlLink || event.id}`;
}

// --- Drive / Docs ------------------------------------------------------------
export async function driveList(query = '', pageSize = 10): Promise<string> {
  const q = query ? `name contains '${query.replace(/'/g, "\\'")}'` : '';
  const data = await googleFetch(
    `https://www.googleapis.com/drive/v3/files?${q ? `q=${encodeURIComponent(q)}&` : ''}fields=files(id,name)&pageSize=${pageSize}`,
  );
  const files: any[] = data.files || [];
  if (!files.length) return 'No files found (Drive scope sees only files this app created).';
  return files.map((f) => `• ${f.name} (${f.id})`).join('\n');
}

export async function docsCreate(title: string, text: string): Promise<string> {
  const doc = await googleFetch('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  if (text) {
    await googleFetch(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ insertText: { location: { index: 1 }, text } }],
      }),
    });
  }
  return `Created document "${title}": https://docs.google.com/document/d/${doc.documentId}/edit`;
}

export async function docsRead(name: string): Promise<string> {
  const found = await googleFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`name='${name.replace(/'/g, "\\'")}'`)}&fields=files(id,name)&pageSize=1`,
  );
  const file = found.files?.[0];
  if (!file) return `No document named "${name}" found.`;
  const doc = await googleFetch(`https://docs.googleapis.com/v1/documents/${file.id}`);
  const parts: string[] = [];
  for (const el of doc.body?.content || []) {
    for (const pe of el.paragraph?.elements || []) {
      if (pe.textRun?.content) parts.push(pe.textRun.content);
    }
  }
  return parts.join('').slice(0, 3000) || '(Document is empty.)';
}
