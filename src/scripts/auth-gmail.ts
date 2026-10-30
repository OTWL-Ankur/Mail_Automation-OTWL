import fs from 'node:fs/promises';
import path from 'node:path';
import { authenticate } from '@google-cloud/local-auth';
import { config } from '../config.js';
import { logger } from '../logger.js';

await fs.access(config.credentialsPath).catch(() => {
  throw new Error(`OAuth credentials not found at ${config.credentialsPath}. Download a Desktop App OAuth JSON and save it as credentials.json.`);
});

const client = await authenticate({
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  keyfilePath: config.credentialsPath
});

await fs.writeFile(config.tokenPath, JSON.stringify(client.credentials, null, 2), { mode: 0o600 });
logger.info({ tokenPath: path.basename(config.tokenPath) }, 'Gmail OAuth authorization saved. Keep token.json private.');
