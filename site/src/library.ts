import {
  FeaturedFileSchema, IndexFileSchema, MonthFileSchema,
  type IndexFile, type MonthEntry, type MonthFile, type Photo,
} from "@photos/core";

export interface Library {
  index(): Promise<IndexFile>;
  months(): Promise<MonthEntry[]>;
  month(m: string): Promise<MonthFile>;
  featured(): Promise<Photo[]>;
  photo(id: string, month: string | null): Promise<Photo | null>;
  prefetch(m: string): void;
}

export function createLibrary(fetchFn: typeof fetch = fetch): Library {
  let indexPromise: Promise<IndexFile> | null = null;
  let featuredPromise: Promise<Photo[]> | null = null;
  const monthCache = new Map<string, Promise<MonthFile>>();

  async function getJson(url: string, what: string): Promise<unknown> {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`could not load ${what} (${res.status})`);
    return res.json();
  }

  function index(): Promise<IndexFile> {
    if (!indexPromise) {
      indexPromise = getJson("/data/index.json", "the photo index").then((r) =>
        IndexFileSchema.parse(r),
      );
      indexPromise.catch(() => { indexPromise = null; });
    }
    return indexPromise;
  }

  function month(m: string): Promise<MonthFile> {
    const cached = monthCache.get(m);
    if (cached) return cached;

    const promise = (async () => {
      const entry = (await index()).months.find((x) => x.month === m);
      if (!entry) throw new Error(`no photos for ${m}`);
      return MonthFileSchema.parse(await getJson(`/${entry.path}`, `photos for ${m}`));
    })();

    monthCache.set(m, promise);
    promise.catch(() => monthCache.delete(m));
    return promise;
  }

  return {
    index,
    async months() {
      return (await index()).months;
    },
    month,
    featured() {
      if (!featuredPromise) {
        featuredPromise = getJson("/data/featured.json", "the featured photos").then(
          (r) => FeaturedFileSchema.parse(r).photos,
        );
        featuredPromise.catch(() => { featuredPromise = null; });
      }
      return featuredPromise;
    },
    async photo(id, hint) {
      if (hint) {
        return (await month(hint)).photos.find((p) => p.id === id) ?? null;
      }
      for (const entry of (await index()).months) {
        const found = (await month(entry.month)).photos.find((p) => p.id === id);
        if (found) return found;
      }
      return null;
    },
    prefetch(m) {
      void month(m).catch(() => {});
    },
  };
}
