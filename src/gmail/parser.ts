import type { gmail_v1 } from 'googleapis';

export interface ParsedAttachment {
  attachmentId: string;
  inlineData?: string;
  originalFilename: string;
  mimeType: string;
  sizeHint: number;
}

export interface ParsedEmail {
  sender: string | null;
  recipient: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: Date | null;
  internalDate: number | null;
  attachments: ParsedAttachment[];
}

function decodeBase64Url(value?: string | null): string {
  if (!value) return '';
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function header(part: gmail_v1.Schema$MessagePart, name: string): string | null {
  const found = part.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

function walkParts(part: gmail_v1.Schema$MessagePart | undefined, result: {
  text: string[]; html: string[]; attachments: ParsedAttachment[];
}): void {
  if (!part) return;
  const filename = part.filename?.trim();
  const attachmentId = part.body?.attachmentId;
  if (filename && (attachmentId || part.body?.data)) {
    result.attachments.push({
      attachmentId: attachmentId ?? `inline:${part.partId ?? filename}`,
      ...(attachmentId ? {} : { inlineData: part.body?.data ?? undefined }),
      originalFilename: filename,
      mimeType: part.mimeType || 'application/octet-stream',
      sizeHint: part.body?.size ?? 0
    });
  } else if (part.body?.data) {
    const content = decodeBase64Url(part.body.data);
    if (part.mimeType === 'text/plain') result.text.push(content);
    if (part.mimeType === 'text/html') result.html.push(content);
  }
  for (const child of part.parts ?? []) walkParts(child, result);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

export function parseEmail(message: gmail_v1.Schema$Message): ParsedEmail {
  const payload = message.payload;
  const collected = { text: [] as string[], html: [] as string[], attachments: [] as ParsedAttachment[] };
  walkParts(payload, collected);
  const html = collected.html.join('\n') || null;
  const text = collected.text.join('\n').trim() || (html ? stripHtml(html) : null);
  const internalDate = message.internalDate ? Number(message.internalDate) : null;
  return {
    sender: payload ? header(payload, 'From') : null,
    recipient: payload ? header(payload, 'To') : null,
    subject: payload ? header(payload, 'Subject') : null,
    bodyText: text,
    bodyHtml: html,
    receivedAt: internalDate && Number.isFinite(internalDate) ? new Date(internalDate) : null,
    internalDate,
    attachments: collected.attachments
  };
}
