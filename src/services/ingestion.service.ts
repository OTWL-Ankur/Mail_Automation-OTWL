import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { config } from '../config.js';
import { getPool } from '../db.js';
import { logger } from '../logger.js';
import { parseEmail } from '../gmail/parser.js';

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function headerValue(message: gmail_v1.Schema$Message, name: string): string | null {
  return message.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

interface ParsedBodyField { key: string; label: string; value: string }

function parseFormattedBody(body: string | null): ParsedBodyField[] {
  const fields = new Map<string, ParsedBodyField>();
  if (!body) return [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z _/-]{1,60})\s*:\s*(.*?)\s*$/);
    if (match?.[1] && match[2]) {
      const key = match[1].toLowerCase().replace(/[^a-z]/g, '');
      if (!fields.has(key)) fields.set(key, { key, label: match[1].trim(), value: match[2].trim() });
    }
  }
  return [...fields.values()];
}

function mapJobFields(fields: ParsedBodyField[]) {
  const values = new Map(fields.map((field) => [field.key, field.value]));
  const get = (...keys: string[]) => {
    for (const key of keys) if (values.get(key)) return values.get(key) ?? null;
    return null;
  };
  return {
    shipmentType: get('shipmenttype', 'modeoftransport', 'transportmode'),
    clientName: get('clientname', 'client', 'importername'),
    clientReference: get('clientreference', 'reference', 'shipmentreference'),
    invoiceNumber: get('invoicenumber', 'invoiceno', 'invoice'),
    origin: get('origin', 'portofloading', 'airportoforigin'),
    destination: get('destination', 'portofdischarge', 'airportofdestination')
  };
}

function safeOriginalName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_').slice(0, 180);
  return base || 'attachment.bin';
}

async function downloadAttachment(gmail: gmail_v1.Gmail, messageId: string, attachment: ReturnType<typeof parseEmail>['attachments'][number]): Promise<Buffer> {
  if (attachment.inlineData) return decodeBase64Url(attachment.inlineData);
  const response = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachment.attachmentId });
  const data = response.data.data;
  if (!data) throw new Error(`Gmail returned empty attachment data for ${attachment.attachmentId}`);
  return decodeBase64Url(data);
}

async function createOrGetEmail(message: gmail_v1.Schema$Message, gmailMessageId: string) {
  const pool = await getPool();
  const parsed = parseEmail(message);
  const parsedFields = parseFormattedBody(parsed.bodyText);
  const fields = mapJobFields(parsedFields);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT "EmailId", "JobId" FROM "EmailMessages" WHERE "GmailMessageId" = $1',
      [gmailMessageId]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { emailId: Number(existing.rows[0].EmailId), jobId: Number(existing.rows[0].JobId), isExisting: true, parsed };
    }
    const jobResult = await client.query(
      `INSERT INTO "Jobs" ("ShipmentType", "ClientName", "ClientReference", "InvoiceNumber", "Origin", "Destination", "JobStatus")
       VALUES ($1, $2, $3, $4, $5, $6, 'EmailReceived')
       RETURNING "JobId"`,
      [fields.shipmentType, fields.clientName, fields.clientReference, fields.invoiceNumber, fields.origin, fields.destination]
    );
    const jobId = Number(jobResult.rows[0]?.JobId);
    const emailResult = await client.query(
      `INSERT INTO "EmailMessages"
         ("JobId", "GmailMessageId", "GmailThreadId", "Sender", "Recipient", "Subject", "BodyText", "BodyHtml", "ReceivedAt", "GmailInternalDate", "ProcessingStatus")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Processing')
       RETURNING "EmailId"`,
      [
        jobId,
        gmailMessageId,
        message.threadId ?? null,
        parsed.sender,
        parsed.recipient,
        parsed.subject,
        parsed.bodyText,
        parsed.bodyHtml,
        parsed.receivedAt,
        parsed.internalDate
      ]
    );
    const emailId = Number(emailResult.rows[0]?.EmailId);
    for (const field of parsedFields) {
      await client.query(
        `INSERT INTO "EmailFields" ("EmailId", "JobId", "FieldKey", "FieldLabel", "FieldValue")
         VALUES ($1, $2, $3, $4, $5)`,
        [emailId, jobId, field.key, field.label, field.value.slice(0, 2000)]
      );
    }
    await client.query('COMMIT');
    return { emailId, jobId, isExisting: false, parsed };
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError) => {
      logger.error({ err: rollbackError }, 'Could not roll back email ingestion transaction');
    });
    // A concurrent worker may have inserted this message after our initial lookup.
    const existing = await pool.query(
      'SELECT "EmailId", "JobId" FROM "EmailMessages" WHERE "GmailMessageId" = $1',
      [gmailMessageId]
    );
    if (existing.rows[0]) {
      return { emailId: Number(existing.rows[0].EmailId), jobId: Number(existing.rows[0].JobId), isExisting: true, parsed };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function saveAttachment(gmail: gmail_v1.Gmail, messageId: string, emailId: number, jobId: number, attachment: ReturnType<typeof parseEmail>['attachments'][number]): Promise<void> {
  const pool = await getPool();
  const already = await pool.query(
    'SELECT "FileId" FROM "DocumentFiles" WHERE "EmailId" = $1 AND "GmailAttachmentId" = $2',
    [emailId, attachment.attachmentId]
  );
  if (already.rows.length) return;

  if (attachment.sizeHint > config.MAX_ATTACHMENT_MB * 1024 * 1024) {
    throw new Error(`Attachment ${attachment.originalFilename} exceeds MAX_ATTACHMENT_MB (${config.MAX_ATTACHMENT_MB} MB)`);
  }
  const content = await downloadAttachment(gmail, messageId, attachment);
  if (content.length > config.MAX_ATTACHMENT_MB * 1024 * 1024) {
    throw new Error(`Attachment ${attachment.originalFilename} exceeds MAX_ATTACHMENT_MB (${config.MAX_ATTACHMENT_MB} MB)`);
  }
  if (content.length === 0) throw new Error(`Attachment ${attachment.originalFilename} is empty`);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const originalFilename = safeOriginalName(attachment.originalFilename);
  const now = new Date();
  const dir = path.join(config.storageRoot, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(jobId));
  await fs.mkdir(dir, { recursive: true });
  const storedFilename = `${crypto.randomUUID()}-${originalFilename}`;
  const absolutePath = path.join(dir, storedFilename);
  const tempPath = `${absolutePath}.part`;
  await fs.writeFile(tempPath, content, { flag: 'wx' });
  await fs.rename(tempPath, absolutePath);
  const relativePath = path.relative(config.storageRoot, absolutePath).split(path.sep).join('/');
  try {
    await pool.query(
      `INSERT INTO "DocumentFiles"
         ("JobId", "EmailId", "GmailAttachmentId", "OriginalFilename", "StoredFilename", "StoragePath", "MimeType", "FileSizeBytes", "Sha256", "StorageStatus")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Stored')`,
      [jobId, emailId, attachment.attachmentId, originalFilename, storedFilename, relativePath, attachment.mimeType, content.length, sha256]
    );
  } catch (error) {
    // Do not leave an untracked file behind if its metadata insert fails.
    await fs.unlink(absolutePath).catch(() => undefined);
    throw error;
  }
}

export async function ingestMessage(gmail: gmail_v1.Gmail, gmailMessageId: string): Promise<void> {
  const messageResponse = await gmail.users.messages.get({ userId: 'me', id: gmailMessageId, format: 'full' });
  const message = messageResponse.data;
  // The mailbox watch is not inbox-only. Ignore messages that are no longer in Inbox.
  if (!message.labelIds?.includes('INBOX')) return;
  const result = await createOrGetEmail(message, gmailMessageId);
  const { emailId, jobId, parsed } = result;
  try {
    for (const attachment of parsed.attachments) {
      await saveAttachment(gmail, gmailMessageId, emailId, jobId, attachment);
    }
    const pool = await getPool();
    await pool.query(
      `UPDATE "EmailMessages"
       SET "ProcessingStatus" = 'Completed', "ProcessingError" = NULL, "UpdatedAt" = CURRENT_TIMESTAMP
       WHERE "EmailId" = $1`,
      [emailId]
    );
    logger.info({ gmailMessageId, jobId, attachmentCount: parsed.attachments.length, duplicateEmail: result.isExisting }, 'Email ingested');
  } catch (error) {
    const pool = await getPool();
    await pool.query(
      `UPDATE "EmailMessages"
       SET "ProcessingStatus" = 'ProcessingFailed', "ProcessingError" = $1, "UpdatedAt" = CURRENT_TIMESTAMP
       WHERE "EmailId" = $2`,
      [error instanceof Error ? error.message : String(error), emailId]
    );
    throw error;
  }
}
