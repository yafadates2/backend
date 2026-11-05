import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  NEON_S3_ENDPOINT: z.string().url(),
  NEON_S3_REGION: z.string().min(1),
  NEON_S3_ACCESS_KEY_ID: z.string().min(1),
  NEON_S3_SECRET_ACCESS_KEY: z.string().min(1),
  NEON_S3_BUCKET: z.string().min(1),
  PDF_TIMEZONE: z.string().default('Africa/Tunis'),
  PDF_FONT_REGULAR: z.string().optional(),
  PDF_FONT_BOLD: z.string().optional(),
});

export function loadConfig(env = process.env) {
  const r = schema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return r.data;
}
