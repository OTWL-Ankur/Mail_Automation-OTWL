import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: ['*.access_token', '*.refresh_token', '*.client_secret', '*.DB_PASSWORD']
});
