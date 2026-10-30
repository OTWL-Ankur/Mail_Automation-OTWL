import { Pool } from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      ...(config.DATABASE_URL
        ? { connectionString: config.DATABASE_URL }
        : {
            host: config.DB_HOST,
            port: config.DB_PORT,
            database: config.DB_DATABASE,
            user: config.DB_USER,
            password: config.DB_PASSWORD
          }),
      ...(config.DB_SSL ? { ssl: { rejectUnauthorized: true } } : {}),
      max: config.DB_POOL_MAX,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    });
    pool.on('error', (error) => logger.error({ err: error }, 'PostgreSQL pool error'));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const activePool = pool;
    pool = undefined;
    await activePool.end();
  }
}
