import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import readline from 'node:readline';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface JsonLine {
  lineNumber: number;
  value: unknown;
}

export async function* readJsonLines(file: string): AsyncGenerator<JsonLine> {
  const stream = createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of rl) {
      if (!line) continue;
      lineNumber += 1;
      try {
        yield { lineNumber, value: JSON.parse(line) as unknown };
      } catch {
        throw new Error(`line ${lineNumber} is not valid JSON`);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function writeJsonLinesAtomic(
  file: string,
  values: Iterable<unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const out = createWriteStream(tmp, { encoding: 'utf-8' });

  const writeLine = async (line: string): Promise<void> => {
    if (!out.write(`${line}\n`)) await once(out, 'drain');
  };

  try {
    for (const value of values) await writeLine(JSON.stringify(value));
    out.end();
    await once(out, 'finish');
  } catch (err) {
    out.destroy();
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  await fs.rename(tmp, file);
}
