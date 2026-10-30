import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { closePool, getPool } from './db.js';
import { createGmailClient } from './gmail/client.js';
import { logger } from './logger.js';
import { syncMailbox } from './services/sync.service.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  try {
    await getPool().query('SELECT 1');
    res.status(200).json({ status: 'ok', database: 'connected', service: 'mail-to-job-backend' });
  } catch (error) {
    logger.error({ err: error }, 'Health check failed');
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const result = await getPool().query(
      `SELECT j."JobId", j."ShipmentType", j."ClientName", j."ClientReference", j."InvoiceNumber",
              j."Origin", j."Destination", j."JobStatus", j."CreatedAt",
              e."Subject", e."Sender", e."ReceivedAt",
              (SELECT COUNT(*) FROM "DocumentFiles" d WHERE d."JobId" = j."JobId") AS "AttachmentCount"
       FROM "Jobs" j
       LEFT JOIN "EmailMessages" e ON e."JobId" = j."JobId"
       ORDER BY j."JobId" DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ data: result.rows, limit, offset });
  } catch (error) {
    logger.error({ err: error }, 'Could not list jobs');
    res.status(500).json({ error: 'Could not list jobs' });
  }
});

app.get('/api/jobs/:jobId', async (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid jobId' });
  try {
    const pool = getPool();
    const job = await pool.query('SELECT * FROM "Jobs" WHERE "JobId" = $1', [jobId]);
    if (!job.rows[0]) return res.status(404).json({ error: 'Job not found' });
    const emails = await pool.query(
      `SELECT "EmailId", "GmailMessageId", "GmailThreadId", "Sender", "Recipient", "Subject", "BodyText", "BodyHtml", "ReceivedAt", "ProcessingStatus", "ProcessingError"
       FROM "EmailMessages" WHERE "JobId" = $1 ORDER BY "EmailId"`,
      [jobId]
    );
    const fields = await pool.query(
      'SELECT "EmailFieldId", "EmailId", "FieldKey", "FieldLabel", "FieldValue" FROM "EmailFields" WHERE "JobId" = $1 ORDER BY "EmailFieldId"',
      [jobId]
    );
    const documents = await pool.query(
      `SELECT "FileId", "EmailId", "OriginalFilename", "MimeType", "FileSizeBytes", "DocumentType", "StorageStatus", "OcrStatus", "CreatedAt"
       FROM "DocumentFiles" WHERE "JobId" = $1 ORDER BY "FileId"`,
      [jobId]
    );
    return res.json({ job: job.rows[0], emails: emails.rows, emailFields: fields.rows, documents: documents.rows });
  } catch (error) {
    logger.error({ err: error, jobId }, 'Could not load job');
    return res.status(500).json({ error: 'Could not load job' });
  }
});

app.get('/api/documents/:fileId/content', async (req, res) => {
  const fileId = Number(req.params.fileId);
  if (!Number.isSafeInteger(fileId) || fileId <= 0) return res.status(400).json({ error: 'Invalid fileId' });
  try {
    const result = await getPool().query(
      `SELECT "OriginalFilename", "StoragePath", "MimeType"
       FROM "DocumentFiles" WHERE "FileId" = $1 AND "StorageStatus" = 'Stored'`,
      [fileId]
    );
    const document = result.rows[0];
    if (!document) return res.status(404).json({ error: 'Document not found' });
    const absolutePath = path.resolve(config.storageRoot, document.StoragePath);
    const storageRoot = path.resolve(config.storageRoot) + path.sep;
    if (!absolutePath.startsWith(storageRoot)) return res.status(400).json({ error: 'Invalid document path' });
    await fs.access(absolutePath);
    res.setHeader('Content-Type', document.MimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(document.OriginalFilename)}`);
    return res.sendFile(absolutePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return res.status(404).json({ error: 'Stored file is missing from server storage' });
    logger.error({ err: error, fileId }, 'Could not serve document');
    return res.status(500).json({ error: 'Could not serve document' });
  }
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'Backend API started');
});

let stopping = false;
let syncRunning = false;
async function runSyncLoop(): Promise<void> {
  const gmail = await createGmailClient();
  const runOnce = async () => {
    if (stopping || syncRunning) return;
    syncRunning = true;
    try {
      await syncMailbox(gmail);
    } catch (error) {
      logger.error({ err: error }, 'Gmail sync failed; it will retry on the next cycle');
    } finally {
      syncRunning = false;
    }
  };
  await runOnce();
  const timer = setInterval(() => { void runOnce(); }, config.GMAIL_POLL_INTERVAL_MS);
  timer.unref();
}

void runSyncLoop().catch((error) => {
  logger.fatal({ err: error }, 'Could not start Gmail sync. Check OAuth and configuration.');
  process.exitCode = 1;
  server.close();
});

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Shutting down');
  server.close();
  await closePool().catch((error) => logger.error({ err: error }, 'Error closing SQL pool'));
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
