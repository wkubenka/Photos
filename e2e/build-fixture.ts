import { mkdir, writeFile } from "node:fs/promises";
import { buildFixture } from "./fixture.js";

const OUT = "e2e/.fixture";

await mkdir(OUT, { recursive: true });
const { sources } = await buildFixture(OUT);
await writeFile(`${OUT}/sources.json`, JSON.stringify(sources, null, 2));
process.stdout.write(`fixture built in ${OUT} with ${sources.length} photos\n`);
