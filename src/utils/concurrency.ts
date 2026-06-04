/**
 * Run async task factories with bounded concurrency to avoid overwhelming the backend.
 * The returned results array aligns with the input order.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const safeLimit = Math.max(1, Math.floor(limit) || 1);
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = new Array(Math.min(safeLimit, tasks.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= tasks.length) return;
        results[idx] = await tasks[idx]();
      }
    });
  await Promise.all(workers);
  return results;
}
