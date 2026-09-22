#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { createCloudFrontCdn, createS3Store } from "./store.js";
import { promptPassword } from "./password.js";
import { addPhotos } from "./commands/add.js";
import { editPhoto, removePhoto, setFeatured } from "./commands/curate.js";
import {
  collectGarbage, deleteGarbage, formatList, listPhotos, publish, repair,
} from "./commands/maintain.js";
import { listFileVersions, restoreFile, rotatePassword } from "./commands/keys.js";
import { KEYS } from "./manifest.js";
import { formatReport, recordBackup, verifyLibrary } from "./commands/verify.js";
import { uploadSite } from "./commands/deploy.js";
import { closeExif, type ExtractedExif } from "./exif.js";
import { closeRightsWriter } from "./rights.js";
import { parseArgs } from "./args.js";

const USAGE = `photos <command>

  add <files...> [--location "Big Bend NP"] [--keep-gps] [--offset ±HH:MM]
                              ingest, encrypt, and publish. --location applies
                              to the whole batch instead of prompting per file
  ls [month] [--featured]     list ids, dates, and titles (★ marks featured)
  edit <id> [--title t] [--caption c] [--location l]
  rm <id>
  feature <ids...>            mark photos for the home page
  unfeature <ids...>
  publish                     re-upload anything missing and invalidate the CDN
  deploy-site [dir]           upload site/dist (default: site/dist)
  repair                      rebuild shards, index, and featured from S3
  verify [--decrypt-sample]   check the library is consistent
  gc [--yes]                  list and optionally delete unreferenced objects
  rotate-password             re-wrap every data key under a new password
  restore <data/path> [ver]   list versions of one manifest file; with a
                              version id, roll that file back to it
  record-backup               stamp today as the last backup date
`;

async function askPhoto(file: string, exif: ExtractedExif, askLocation: boolean) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${file}  (${exif.takenAt}, ${exif.exif.camera})\n`);
    const title = await rl.question("  Title: ");
    const caption = await rl.question("  Caption: ");
    if (!askLocation) return { title, caption };
    return { title, caption, location: await rl.question("  Location: ") };
  } finally {
    rl.close();
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} `)).trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help") { process.stdout.write(USAGE); return 0; }

  const { positional, flags } = parseArgs(rest);
  const str = (name: string): string | undefined =>
    typeof flags[name] === "string" ? (flags[name] as string) : undefined;

  const config = loadConfig();
  const store = createS3Store(config);
  const cdn = createCloudFrontCdn(config);

  switch (command) {
    case "add": {
      const offset = str("offset");
      const location = str("location");
      const added = await addPhotos(
        { store, config, prompt: askPhoto, password: () => promptPassword("Library password: ") },
        positional,
        {
          keepGps: flags["keep-gps"] === true,
          ...(offset !== undefined ? { offset } : {}),
          ...(location !== undefined ? { location } : {}),
        },
      );
      for (const p of added) process.stdout.write(`added ${p.id}\n`);
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "ls": {
      const month = positional[0];
      const rows = await listPhotos(store, {
        ...(month !== undefined ? { month } : {}),
        featuredOnly: flags.featured === true,
      });
      if (!rows.length) { process.stdout.write("no photos\n"); return 0; }
      process.stdout.write(`${formatList(rows)}\n${rows.length} photos\n`);
      return 0;
    }
    case "edit": {
      const id = positional[0];
      if (!id) {
        process.stderr.write("usage: photos edit <id> [--title t] [--caption c] [--location l]\n");
        return 1;
      }
      const patch = { title: str("title"), caption: str("caption"), location: str("location") };
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const updated = await editPhoto(store, id, defined);
      process.stdout.write(`updated ${updated.id}\n`);
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "rm": {
      const id = positional[0];
      if (!id) {
        process.stderr.write("usage: photos rm <id>\n");
        return 1;
      }
      await removePhoto(store, id);
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "feature":
    case "unfeature":
      await setFeatured(store, positional, command === "feature");
      await cdn.invalidate(["/data/*"]);
      return 0;
    case "publish": {
      const { missing } = await publish(store, cdn);
      if (missing.length) {
        process.stderr.write(`missing objects:\n  ${missing.join("\n  ")}\n`);
        process.stderr.write("re-run `photos add` for these photos, or `photos rm` to drop them\n");
        return 1;
      }
      process.stdout.write("published\n");
      return 0;
    }
    case "deploy-site":
      await uploadSite(store, cdn, positional[0] ?? "site/dist");
      process.stdout.write("site deployed\n");
      return 0;
    case "repair": {
      const index = await repair(store);
      process.stdout.write(`rebuilt ${index.photoCount} photos across ${index.months.length} months\n`);
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "verify": {
      const password = flags["decrypt-sample"] === true
        ? await promptPassword("Library password: ")
        : undefined;
      const report = await verifyLibrary({ store, ...(password ? { password } : {}) });
      process.stdout.write(`${formatReport(report)}\n`);
      return report.ok ? 0 : 1;
    }
    case "gc": {
      const junk = await collectGarbage(store);
      if (!junk.length) { process.stdout.write("nothing to collect\n"); return 0; }
      process.stdout.write(`${junk.length} unreferenced objects:\n  ${junk.join("\n  ")}\n`);
      if (flags.yes !== true) { process.stdout.write("re-run with --yes to delete\n"); return 0; }
      await deleteGarbage(store, junk);
      process.stdout.write("deleted\n");
      return 0;
    }
    case "rotate-password": {
      const oldPassword = await promptPassword("Current password: ");
      const newPassword = await promptPassword("New password: ");
      const again = await promptPassword("New password again: ");
      if (newPassword !== again) { process.stderr.write("passwords did not match\n"); return 1; }
      const { rewrapped } = await rotatePassword(store, oldPassword, newPassword);
      process.stdout.write(`re-wrapped ${rewrapped} keys; no originals were touched\n`);
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "restore": {
      const path = positional[0];
      if (!path) {
        process.stderr.write("usage: photos restore <data/path> [version]\n");
        return 1;
      }
      // With no version id this lists and stops. It used to list and then
      // restore anyway in the same run, which reads like a dry run and is
      // not — on a command whose whole job is to overwrite live manifest
      // state with older bytes.
      const version = positional[1];
      if (!version) {
        const versions = await listFileVersions(store, path);
        process.stdout.write(`${versions.length} versions of ${path}:\n`);
        for (const v of versions) process.stdout.write(`  ${v.versionId}  ${v.lastModified}\n`);
        process.stdout.write(
          "nothing was restored. Re-run with the version id you want:\n"
          + `  photos restore ${path} <version>\n`,
        );
        return 0;
      }

      // Rolling data/keys.json back past an `add` drops that photo's wrapped
      // key, and its ciphertext under orig/ becomes undecryptable for good —
      // the data key exists nowhere else.
      if (path === KEYS.keys) {
        process.stdout.write(
          "WARNING: restoring data/keys.json rolls the wrapped data keys back.\n"
          + "Any photo added after that version loses its key, and its encrypted\n"
          + "original can never be decrypted again — the data key exists nowhere else.\n",
        );
        if (!(await confirm("Type yes to continue:"))) {
          process.stdout.write("nothing was restored\n");
          return 0;
        }
      }

      await restoreFile(store, path, version);
      process.stdout.write(`restored ${path}\n`);
      if (path.startsWith("data/months/")) {
        process.stdout.write(
          "This shard's photo count has changed, but data/index.json has not.\n"
          + "Run `photos repair` now so the index and the rail agree with it.\n",
        );
      }
      await cdn.invalidate(["/data/*"]);
      return 0;
    }
    case "record-backup":
      await recordBackup(store, new Date().toISOString());
      await cdn.invalidate(["/data/*"]);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

async function closeAll(): Promise<void> {
  await Promise.all([closeExif(), closeRightsWriter()]);
}

main()
  .then(async (code) => { await closeAll(); process.exit(code); })
  .catch(async (err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    await closeAll();
    process.exit(1);
  });
