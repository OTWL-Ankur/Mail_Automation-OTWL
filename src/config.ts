import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  GMAIL_MAILBOX: z.string().email(),
  GMAIL_POLL_INTERVAL_MS: z.coerce.number().int().min(15000).default(60000),
  GMAIL_IMPORT_EXISTING: z.string().default('false').transform((v) => v.toLowerCase() === 'true'),
  MAX_ATTACHMENT_MB: z.coerce.number().int().positive().max(100).default(25),
  DATABASE_URL: z.string().url().optional(),
  DB_HOST: z.string().min(1).optional(),
  DB_SERVER: z.string().min(1).optional(),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_DATABASE: z.string().min(1).optional(),
  DB_USER: z.string().min(1).optional(),
  DB_PASSWORD: z.string().min(1).optional(),
  DB_SSL: z.string().default('false').transform((v) => v.toLowerCase() === 'true'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  STORAGE_ROOT: z.string().default('./storage'),
  GOOGLE_CREDENTIALS_PATH: z.string().default('./credentials.json'),
  GOOGLE_TOKEN_PATH: z.string().default('./token.json')
}).superRefine((value, context) => {
  if (!value.DATABASE_URL && !(value.DB_HOST ?? value.DB_SERVER)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['DB_HOST'], message: 'DB_HOST is required when DATABASE_URL is not set' });
  }
  if (!value.DATABASE_URL) {
    for (const key of ['DB_DATABASE', 'DB_USER', 'DB_PASSWORD'] as const) {
      if (!value[key]) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when DATABASE_URL is not set` });
    }
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid .env configuration. Copy .env.example to .env and fill required values.');
}

const value = parsed.data;
export const config = {
  ...value,
  DB_HOST: value.DB_HOST ?? value.DB_SERVER,
  storageRoot: path.resolve(value.STORAGE_ROOT),
  credentialsPath: path.resolve(value.GOOGLE_CREDENTIALS_PATH),
  tokenPath: path.resolve(value.GOOGLE_TOKEN_PATH)
};
