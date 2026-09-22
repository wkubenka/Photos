import { createInterface } from "node:readline/promises";

export async function promptPassword(label = "Password: "): Promise<string> {
  const fromEnv = process.env.PHOTOS_PASSWORD;
  if (fromEnv) return fromEnv;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const output = process.stdout as NodeJS.WriteStream & { muted?: boolean };
  const write = output.write.bind(output);
  output.write = ((chunk: string, ...rest: unknown[]) =>
    output.muted ? true : write(chunk, ...(rest as []))) as typeof output.write;
  try {
    const answer = rl.question(label);
    output.muted = true;
    const value = await answer;
    return value;
  } finally {
    output.muted = false;
    output.write = write;
    rl.close();
    process.stdout.write("\n");
  }
}
