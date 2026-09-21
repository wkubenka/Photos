const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The month a photo belongs to, from its LOCAL capture date.
 *
 * An ISO timestamp carrying an offset already expresses local time, so the
 * literal date prefix is the local date. Constructing a Date here would
 * normalize to UTC and file evening photos into the following month.
 */
export function monthOf(takenAt: string): string {
  const m = ISO_WITH_OFFSET.exec(takenAt);
  if (!m) throw new Error(`takenAt must be ISO 8601 with a UTC offset: ${takenAt}`);
  return `${m[1]}-${m[2]}`;
}

export function localDateOf(takenAt: string): string {
  const m = ISO_WITH_OFFSET.exec(takenAt);
  if (!m) throw new Error(`takenAt must be ISO 8601 with a UTC offset: ${takenAt}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const MAX_TITLE_SLUG = 60;

export function makePhotoId(takenAt: string, title: string, frame: string): string {
  const date = localDateOf(takenAt);
  const slug = slugify(title).slice(0, MAX_TITLE_SLUG).replace(/-+$/, "");
  const frameSlug = slugify(frame);
  return [date, slug, frameSlug].filter(Boolean).join("-");
}
