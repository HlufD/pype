/**
 * ETag cost microbenchmark: `npm run bench:etag`.
 *
 * `res.send()` hashes the whole body for its weak ETag unless the `etag`
 * setting is off. This measures that hash for 1 KB to 100 MB bodies, so the
 * cost can be weighed against turning ETags off for large responses.
 *
 * @packageDocumentation
 */
import { generateETag } from "../src/utils/helpers";

/** Body sizes in bytes. */
const SIZES = [1024, 64 * 1024, 1024 ** 2, 10 * 1024 ** 2, 100 * 1024 ** 2];

/** Time spent per size, in milliseconds. */
const BUDGET_MS = 1000;

const label = (bytes: number) => (bytes >= 1024 ** 2 ? `${bytes / 1024 ** 2} MB` : `${bytes / 1024} KB`);

console.log(`${"body".padEnd(8)} ${"etag on".padStart(12)} ${"MB/s".padStart(8)} ${"etag off".padStart(12)}`);

for (const size of SIZES) {
  const body = Buffer.alloc(size, 7);
  for (let i = 0; i < 3; i++) generateETag(body);

  let runs = 0;
  const start = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - start) / 1e6 < BUDGET_MS) {
    generateETag(body);
    runs++;
  }
  const msPerSend = Number(process.hrtime.bigint() - start) / 1e6 / runs;
  const throughput = size / 1024 ** 2 / (msPerSend / 1000);

  // With the setting off, res.send() only reads the length.
  const offStart = process.hrtime.bigint();
  for (let i = 0; i < 1e6; i++) void body.length;
  const offMs = Number(process.hrtime.bigint() - offStart) / 1e6 / 1e6;

  console.log(
    `${label(size).padEnd(8)} ${(msPerSend.toFixed(3) + " ms").padStart(12)} ${throughput.toFixed(0).padStart(8)} ${(offMs.toFixed(6) + " ms").padStart(12)}`,
  );
}
