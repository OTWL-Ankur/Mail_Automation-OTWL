import type { gmail_v1 } from 'googleapis';
import { config } from '../config.js';
import { getPool } from '../db.js';
import { logger } from '../logger.js';
import { ingestMessage } from './ingestion.service.js';

const STATE_KEY = `gmail-history:${config.GMAIL_MAILBOX.toLowerCase()}`;
const BOOTSTRAP_KEY = `gmail-bootstrap:${config.GMAIL_MAILBOX.toLowerCase()}`;

async function readHistoryId(): Promise<string | null> {
  const result = await getPool().query(
    'SELECT "StateValue" FROM "GmailSyncState" WHERE "StateKey" = $1',
    [STATE_KEY]
  );
  return result.rows[0]?.StateValue ?? null;
}

async function saveState(key: string, value: string): Promise<void> {
  await getPool().query(
    `INSERT INTO "GmailSyncState" ("StateKey", "StateValue")
     VALUES ($1, $2)
     ON CONFLICT ("StateKey") DO UPDATE
     SET "StateValue" = EXCLUDED."StateValue", "UpdatedAt" = CURRENT_TIMESTAMP`,
    [key, value]
  );
}

async function saveHistoryId(historyId: string): Promise<void> {
  await saveState(STATE_KEY, historyId);
}

async function getState(key: string): Promise<string | null> {
  const result = await getPool().query(
    'SELECT "StateValue" FROM "GmailSyncState" WHERE "StateKey" = $1',
    [key]
  );
  return result.rows[0]?.StateValue ?? null;
}

async function listAllInboxIds(gmail: gmail_v1.Gmail): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], maxResults: 500, pageToken });
    for (const item of page.data.messages ?? []) if (item.id) ids.push(item.id);
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

async function fullInboxResync(gmail: gmail_v1.Gmail): Promise<void> {
  logger.warn('Gmail history expired; reconciling the full inbox. This can take time for a large mailbox.');
  // Capture the checkpoint before listing. Any mail arriving during the scan remains discoverable afterwards.
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const baselineHistoryId = profile.data.historyId;
  const ids = await listAllInboxIds(gmail);
  for (const id of ids) await ingestMessage(gmail, id);
  if (baselineHistoryId) await saveHistoryId(baselineHistoryId);
  logger.info({ count: ids.length }, 'Full inbox reconciliation completed');
}

async function initialize(gmail: gmail_v1.Gmail): Promise<void> {
  const existing = await readHistoryId();
  if (!existing) {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    if (!profile.data.historyId) throw new Error('Gmail profile did not return a historyId');
    // Save baseline before any optional inbox import so mail arriving during the import is still discoverable.
    await saveHistoryId(profile.data.historyId);
    if (config.GMAIL_IMPORT_EXISTING) await saveState(BOOTSTRAP_KEY, 'pending');
    logger.info({ importedExisting: config.GMAIL_IMPORT_EXISTING }, 'Gmail sync baseline initialized');
  }
  if (config.GMAIL_IMPORT_EXISTING && (await getState(BOOTSTRAP_KEY)) !== 'completed') {
    await saveState(BOOTSTRAP_KEY, 'pending');
    const ids = await listAllInboxIds(gmail);
    for (const id of ids) await ingestMessage(gmail, id);
    await saveState(BOOTSTRAP_KEY, 'completed');
    logger.info({ count: ids.length }, 'Initial inbox import completed');
  }
}

export async function syncMailbox(gmail: gmail_v1.Gmail): Promise<void> {
  await initialize(gmail);
  const startHistoryId = await readHistoryId();
  if (!startHistoryId) throw new Error('Could not load Gmail history checkpoint');

  const ids = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | undefined;
  try {
    do {
      const page = await gmail.users.history.list({ userId: 'me', startHistoryId, historyTypes: ['messageAdded'], maxResults: 500, pageToken });
      latestHistoryId = page.data.historyId ?? latestHistoryId;
      for (const history of page.data.history ?? []) {
        for (const added of history.messagesAdded ?? []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }
      pageToken = page.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (error: any) {
    if (error?.code === 404 || error?.response?.status === 404) {
      await fullInboxResync(gmail);
      return;
    }
    throw error;
  }

  // Only advance the checkpoint after every discovered message is processed successfully.
  for (const id of ids) await ingestMessage(gmail, id);
  if (latestHistoryId) await saveHistoryId(latestHistoryId);
  if (ids.size) logger.info({ messages: ids.size, historyId: latestHistoryId }, 'Gmail mailbox sync completed');
}
