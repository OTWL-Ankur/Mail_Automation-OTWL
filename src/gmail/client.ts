import fs from 'node:fs/promises';
import { google, gmail_v1 } from 'googleapis';
import { config } from '../config.js';

export async function createGmailClient(): Promise<gmail_v1.Gmail> {
  let credentials: any;
  let token: any;
  try {
    credentials = JSON.parse(await fs.readFile(config.credentialsPath, 'utf8'));
    token = JSON.parse(await fs.readFile(config.tokenPath, 'utf8'));
  } catch {
    throw new Error('Gmail OAuth files missing. Run `npm run auth:gmail` after adding credentials.json.');
  }
  const installed = credentials.installed ?? credentials.web;
  if (!installed?.client_id || !installed?.client_secret) {
    throw new Error('credentials.json must contain an OAuth Desktop App client under `installed`.');
  }
  const redirectUri = installed.redirect_uris?.[0] ?? 'http://localhost';
  const auth = new google.auth.OAuth2(installed.client_id, installed.client_secret, redirectUri);
  auth.setCredentials(token);
  auth.on('tokens', async (newTokens) => {
    const merged = { ...token, ...newTokens };
    await fs.writeFile(config.tokenPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    token = merged;
  });
  const gmail = google.gmail({ version: 'v1', auth });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const actualMailbox = profile.data.emailAddress?.toLowerCase();
  if (actualMailbox !== config.GMAIL_MAILBOX.toLowerCase()) {
    throw new Error(`Authorized Gmail account (${actualMailbox ?? 'unknown'}) does not match GMAIL_MAILBOX (${config.GMAIL_MAILBOX}). Authorize the dedicated mailbox account.`);
  }
  return gmail;
}
