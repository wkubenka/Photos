import {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand,
  ListObjectsV2Command, DeleteObjectCommand, ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Config } from "./config.js";

export interface Store {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType: string, cacheControl: string): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
  listVersions(key: string): Promise<{ versionId: string; lastModified: string }[]>;
  getVersion(key: string, versionId: string): Promise<Uint8Array>;
}

export interface Cdn {
  invalidate(paths: string[]): Promise<void>;
}

async function toBytes(body: unknown): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(c);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export function createS3Store(config: Config): Store {
  const client = new S3Client({
    region: config.region,
    credentials: fromIni({ profile: config.profile }),
  });
  const Bucket = config.bucket;

  return {
    async get(Key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket, Key }));
        return await toBytes(r.Body);
      } catch (e) {
        if ((e as { name?: string }).name === "NoSuchKey") return null;
        throw e;
      }
    },
    async put(Key, body, ContentType, CacheControl) {
      await client.send(new PutObjectCommand({
        Bucket, Key, Body: body, ContentType, CacheControl,
      }));
    },
    async head(Key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket, Key }));
        return { size: r.ContentLength ?? 0 };
      } catch (e) {
        if ((e as { name?: string }).name === "NotFound") return null;
        throw e;
      }
    },
    async list(Prefix) {
      const keys: string[] = [];
      let ContinuationToken: string | undefined;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
        ContinuationToken = r.NextContinuationToken;
      } while (ContinuationToken);
      return keys;
    },
    async delete(Key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key }));
    },
    async listVersions(Key) {
      const r = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix: Key }));
      return (r.Versions ?? [])
        .filter((v) => v.Key === Key && v.VersionId)
        .map((v) => ({ versionId: v.VersionId!, lastModified: v.LastModified?.toISOString() ?? "" }));
    },
    async getVersion(Key, VersionId) {
      const r = await client.send(new GetObjectCommand({ Bucket, Key, VersionId }));
      return toBytes(r.Body);
    },
  };
}

export function createCloudFrontCdn(config: Config): Cdn {
  const client = new CloudFrontClient({
    region: "us-east-1",
    credentials: fromIni({ profile: config.profile }),
  });
  return {
    async invalidate(paths) {
      await client.send(new CreateInvalidationCommand({
        DistributionId: config.distributionId,
        InvalidationBatch: {
          CallerReference: `photos-${Date.now()}`,
          Paths: { Quantity: paths.length, Items: paths },
        },
      }));
    },
  };
}
