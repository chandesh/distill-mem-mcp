import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  DISTILL_TRANSPORT: z.enum(['http', 'stdio']).default('http'),
  DISTILL_HOST: z.string().default('127.0.0.1'),
  DISTILL_PORT: z.coerce.number().int().min(1).max(65535).default(8181),
  DISTILL_DB_PATH: z.string().min(1).default('/data/distill.db'),
  DISTILL_API_KEY: z.string().optional(),
  DISTILL_DEFAULT_BUDGET: z.coerce.number().int().min(100).max(100000).default(1200),
  DISTILL_INGEST_OUTPUT_CAP: z.coerce.number().int().min(256).max(100000).default(2000),
  DISTILL_EVENT_RETENTION: z.coerce.number().int().min(100).max(1000000).default(5000),
  DISTILL_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | undefined;

export function loadConfig(overrides?: Partial<Record<keyof Config, string | number>>): Config {
  const merged = { ...process.env, ...overrides } as Record<string, unknown>;
  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}

export function getConfig(): Config {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

export function resetConfig(): void {
  cached = undefined;
}
