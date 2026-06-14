import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),
  FRONTEND_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  SESSION_MAX_AGE_MS: z.coerce.number().default(28800000),
  CORS_ORIGIN: z.string(),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  VAULT_ENCRYPTION_KEY: z.string().length(64),
  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),
  MS_TENANT_ID: z.string().optional(),
  MS_CALLBACK_URL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),
  GOOGLE_HOSTED_DOMAIN: z.string().optional(),
  MFA_ISSUER: z.string().default('SSHManager'),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email(),
  TERMINAL_IDLE_TIMEOUT_MIN: z.coerce.number().default(30),
  RECORDINGS_STORAGE_PATH: z.string().default('/var/lib/ssh-manager/recordings'),
  RATE_LIMIT_AUTH: z.coerce.number().default(10),
  RATE_LIMIT_API: z.coerce.number().default(100),
  ALERT_WEBHOOK_URL: z.string().optional(),
})

export type Config = z.infer<typeof schema>

export function loadConfig(): Config {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment configuration:', result.error.format())
    process.exit(1)
  }
  return result.data
}

export const config = loadConfig()
