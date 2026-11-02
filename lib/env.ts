import "server-only";
import { z } from "zod";

const requiredString = z.string();

const allowedTelegramIds = z.string().transform((value, ctx) => {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    ctx.addIssue({
      code: "custom",
      input: value,
      message: "must contain at least one Telegram user ID",
    });
    return z.NEVER;
  }
  const ids: number[] = [];
  for (const part of parts) {
    const id = Number(part);
    if (!Number.isSafeInteger(id) || id <= 0) {
      ctx.addIssue({
        code: "custom",
        input: value,
        message: "must be comma-separated numeric Telegram user IDs",
      });
      return z.NEVER;
    }
    ids.push(id);
  }
  return ids;
});

const positiveNumber = z.preprocess(
  (value) => (value === undefined ? undefined : Number(value)),
  z.number().finite().positive()
);

// Optional boolean for the allowlist switch. The common spellings are
// accepted; anything else fails validation loudly so a typo can never
// silently open or close the bot.
const allowlistEnabled = z
  .string()
  .transform((value, ctx): boolean => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "false" || normalized === "0" || normalized === "no") return false;
    if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
    ctx.addIssue({
      code: "custom",
      input: value,
      message: "must be one of true, 1, yes, false, 0, no",
    });
    return z.NEVER;
  })
  .default(true);

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: requiredString,
  TELEGRAM_BOT_USERNAME: requiredString,
  TELEGRAM_WEBHOOK_SECRET: requiredString,
  ALLOWED_TELEGRAM_IDS: allowedTelegramIds,
  MODEL_API_KEY: requiredString,
  META_API_BASE_URL: z.url().default("https://api.meta.ai/v1"),
  META_MODEL: requiredString.default("muse-spark-1.3"),
  // Optional faster model for text only messages (no image or pdf). Blank or
  // missing means "use META_MODEL".
  META_TEXT_MODEL: z.string().optional(),
  // Optional reasoning effort for those text only calls. Blank or missing
  // means "low", the effort used today.
  META_TEXT_EFFORT: z.enum(["minimal", "low", "medium"]).optional(),
  META_TRANSCRIBE_MODEL: requiredString.default("muse-voice-transcribe-1.0"),
  META_DAILY_BUDGET_USD: positiveNumber.default(10),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: requiredString,
  SUPABASE_STORAGE_BUCKET: requiredString.default("uploads"),
  SUPABASE_DB_URL: requiredString,
  SESSION_SECRET: z.string().min(16),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  BILLING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Launch switch: false opens the bot to everyone, but only while billing is
  // on (lib/telegram/access.ts enforces that pairing).
  ALLOWLIST_ENABLED: allowlistEnabled,
  // Stripe (web payments). All optional: a deploy without them starts fine
  // and /billing simply shows that paid plans are not open yet.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
  STRIPE_PRICE_PRO_YEARLY: z.string().optional(),
  STRIPE_PRICE_PRO_YEARLY_PAYNOW: z.string().optional(),
  // Stripe Managed Payments: Stripe becomes the seller of record for web card
  // payments and handles tax. Off by default; only turn it on after the
  // checklist in docs/STRIPE-MANAGED-PAYMENTS.md has been done in Stripe.
  STRIPE_MANAGED_PAYMENTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Identity shown on the legal pages (content/legal/*.md tokens). Optional:
  // a blank or missing value becomes a visible [[MISSING: VAR]] marker in the
  // pages instead of failing startup; scripts/check-legal.ts reports it.
  LEGAL_BUSINESS_NAME: z.string().optional(),
  LEGAL_BUSINESS_UEN: z.string().optional(),
  LEGAL_SUPPORT_EMAIL: z.string().optional(),
  LEGAL_SUPABASE_REGION: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

// Blank or whitespace-only values count as absent so defaults still apply.
function normalize(raw: Record<string, string | undefined>) {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    out[key] = trimmed.length > 0 ? trimmed : undefined;
  }
  return out;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  // Custom transformer messages are already human wording; they must not be
  // swallowed by the missing-value check below. The custom code exists at
  // runtime but is not part of the union's discriminant type.
  const code = issue.code as string | undefined;
  if (code === "custom" && "message" in issue) return issue.message;
  if (issue.input === undefined) return "missing";
  switch (issue.code) {
    case "invalid_type":
      return "has an invalid value";
    case "invalid_format":
      return issue.format === "url" ? "must be a valid URL" : "has an invalid format";
    case "too_small":
      return "is too short or too small";
    case "too_big":
      return "is too big";
    case "custom":
      return issue.message;
    default:
      return "is invalid";
  }
}

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(normalize(raw));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"} ${describeIssue(issue)}`)
      .join(", ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env as Record<string, string | undefined>);
  return cached;
}

// Lazy: importing this module never parses; the first key read does. Keeps
// `next build` working when env vars are absent from the build environment.
export const env: Env = new Proxy({} as Env, {
  get(_target, prop) {
    if (typeof prop !== "string") return undefined;
    return getEnv()[prop as keyof Env];
  },
});
