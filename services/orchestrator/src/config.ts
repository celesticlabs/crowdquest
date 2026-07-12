import { z } from "zod";

const Env = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  LOG_LEVEL: z.string().default("info"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  SESSION_CLEANUP_MINUTES: z.coerce.number().int().min(5).max(1_440).default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(10_000).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  SESSION_CREATE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000).default(12),
  ANSWER_WINDOW_SECONDS: z.coerce.number().int().min(1).max(300).default(24),
  DATABASE_URL: z.string().optional(),
  TXLINE_ORIGIN: z.string().url().default("https://txline-dev.txodds.com"),
  TXLINE_API_TOKEN: z.string().min(8).optional(),
  TXLINE_FIXTURE_ID: z.coerce.number().int().positive().default(18209181),
  COINBASE_AGENT_URL: z.string().url().optional(),
  COINBASE_AGENT_TOKEN: z.string().min(8).optional(),
  PAYOUT_MODE: z.enum(["disabled", "test", "approval"]).default("test"),
  MAX_PAYOUT_USDC: z.coerce.number().min(0).max(100).default(20),
  ADMIN_TOKEN: z.string().min(24).optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.parse(env);
  return {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
    sessionTtlMs: parsed.SESSION_TTL_HOURS * 60 * 60 * 1_000,
    sessionCleanupMs: parsed.SESSION_CLEANUP_MINUTES * 60 * 1_000,
    answerWindowMs: parsed.ANSWER_WINDOW_SECONDS * 1_000,
  };
}
