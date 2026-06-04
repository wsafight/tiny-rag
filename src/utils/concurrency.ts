/**
 * 用有限并发执行异步任务工厂，避免一次性把后端打挂。
 * 与输入顺序对齐返回结果数组。
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
