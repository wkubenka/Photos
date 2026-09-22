import { readFileSync } from "node:fs";
import { z } from "zod";

export const CACHE_IMMUTABLE = "max-age=31536000, immutable";
export const CACHE_SHORT = "max-age=60, must-revalidate";

const ConfigSchema = z
  .object({
    bucket: z.string().min(1),
    region: z.string().min(1),
    profile: z.string().min(1),
    distributionId: z.string().min(1),
    siteUrl: z.string().url().startsWith("https://", "siteUrl must be https"),
    creator: z.string().min(1),
    copyright: z.string().min(1),
    usageTerms: z.string().min(1),
    sizes: z.object({
      display: z.number().int().positive(),
      thumb: z.number().int().positive(),
    }),
  })
  .refine((c) => c.sizes.thumb < c.sizes.display, {
    message: "sizes.thumb must be smaller than sizes.display",
    path: ["sizes", "thumb"],
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path = "photos.config.json"): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`config not found at ${path}`);
  }
  const parsed = ConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid ${path}:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
