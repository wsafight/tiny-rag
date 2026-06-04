// bench/bench.ts
// -----------------------------------------------------------------------------
// 性能基准测试：用合成数据测量「向量库写入 / 加载 / 查询」的耗时与内存占用。
//
// 设计目标（详见根目录 PERFORMANCE.md）：
//   1) 在改动检索/存储相关代码前后，能够稳定复现量级；
//   2) 不依赖任何外部 LLM / Embedding 服务，全部用确定性合成向量；
//   3) 独立于 test runner，通过 `pnpm bench` 显式启用。
//
// 跑法：
//   pnpm bench                                    # 跑基准（默认追加历史 + 自动 vs baseline）
//   BENCH_SIZES=1000,10000 pnpm bench             # 自定义档位
//   BENCH_DIM=768 pnpm bench                      # 自定义向量维度
//   BENCH_LABEL="after-p0" pnpm bench             # 给本次跑打标签，写入历史时一起记录
//   BENCH_BASELINE_SAVE=1 pnpm bench              # 把本次结果保存为基线（不会自动覆盖）
//   BENCH_NO_LOG=1 pnpm bench                     # 临时禁用历史追加
//   INTERMEDIATE_DIR=./.tiny-rag-cache pnpm bench # 启用中间态缓存加载路径
//
// 产出文件（均放在仓库根目录的 `bench/` 下，已加入 .gitignore 建议中）：
//   - bench/history.jsonl     每次跑追加一行 JSON
//   - bench/baseline.json     最近一次显式保存的基线
// -----------------------------------------------------------------------------

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { writeVectorStore, loadVectorStore } from '../src/storage/vector-store';
import { createLoadedRetriever } from '../src/query/retrieval';
import { buildKeywordStats } from '../src/query/keyword';
import { normalize } from '../src/utils/index';
import type { EmbeddingConfig } from '../src/types';
import type { StoreMeta } from '../src/storage/types';

// ----------------------------- 配置参数 -----------------------------

/** 基准档位：默认覆盖 1k / 1w，避免 50k 跑太久；可通过 BENCH_SIZES 覆盖。 */
const BENCH_SIZES: number[] = (process.env.BENCH_SIZES ?? '1000,10000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

/** 向量维度，默认 384（贴近常见小型 embedding）。 */
const BENCH_DIM = Number.isInteger(Number(process.env.BENCH_DIM))
  ? Number(process.env.BENCH_DIM)
  : 384;

/** 每档查询次数，取平均以降低抖动。 */
const QUERY_TIMES = Number.isInteger(Number(process.env.BENCH_QUERY_TIMES))
  ? Number(process.env.BENCH_QUERY_TIMES)
  : 5;

/** 本次跑的可选标签，写入历史时一起记录，便于事后追溯。 */
const BENCH_LABEL = process.env.BENCH_LABEL ?? '';

/** 是否把本次结果保存为基线（默认 false，需要显式开启，避免误覆盖）。 */
const BENCH_BASELINE_SAVE =
  process.env.BENCH_BASELINE_SAVE === '1' || process.env.BENCH_BASELINE_SAVE === 'true';

/** 是否禁用历史追加（默认追加）。 */
const BENCH_NO_LOG = process.env.BENCH_NO_LOG === '1' || process.env.BENCH_NO_LOG === 'true';

/** 可选中间态缓存目录；留空时 bench 仍走纯 NDJSON 加载路径。 */
const BENCH_INTERMEDIATE_DIR = process.env.INTERMEDIATE_DIR?.trim() || undefined;

/** 历史与基线文件的存放目录（仓库根 / bench/），便于 git 管理或忽略。 */
const BENCH_DIR = resolve(process.cwd(), 'bench');
const HISTORY_FILE = join(BENCH_DIR, 'history.jsonl');
const BASELINE_FILE = join(BENCH_DIR, 'baseline.json');

/** 用于 bench 的虚拟 embedding 配置。 */
const embeddingConfig: EmbeddingConfig = {
  provider: 'lmstudio',
  baseURL: 'http://example.test/v1',
  apiKey: 'test',
  model: 'bench-embedding',
};

// ----------------------------- 类型 -----------------------------

/** 单档（单个 size）测得的所有指标。 */
interface BenchMetrics {
  size: number;
  writeMs: number;
  loadMs: number;
  retrieverMs: number;
  vectorOnlyAvgMs: number;
  hybridAvgMs: number;
  rssBeforeMB: number;
  rssAfterMB: number;
  recordsLoaded: number;
}

/** 一次完整跑的快照：包含时间戳、环境、参数、所有档位的指标。 */
interface BenchRun {
  timestamp: string; // ISO 8601
  label: string;
  node: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemMB: number;
  params: {
    sizes: number[];
    dim: number;
    queryTimes: number;
    intermediateDir?: string;
  };
  metrics: BenchMetrics[];
}

// ----------------------------- 工具函数 -----------------------------

/**
 * 基于种子的伪随机生成器（mulberry32），保证不同档位之间数据分布稳定可复现。
 */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成长度为 dim 的合成向量并做 L2 归一化（贴近真实向量库存储形式）。
 */
function makeRandomVector(dim: number, rng: () => number): number[] {
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) v[i] = rng() * 2 - 1;
  return normalize(v);
}

/**
 * 为某个 chunk 生成"看起来像中英文混合"的合成文本，便于 BM25 路径走到分词与 term 统计。
 */
function makeSyntheticText(index: number, rng: () => number): { heading: string; content: string } {
  const topics = [
    '缓存策略 cache',
    '权限校验 auth',
    '数据库索引 index',
    '消息队列 queue',
    '分布式事务 transaction',
    '日志采集 logging',
  ];
  const verbs = ['优化', '清理', '回滚', '降级', '熔断', '重试'];
  const heading = `章节${index % 50} ${topics[index % topics.length]}`;
  const sentences: string[] = [];
  for (let i = 0; i < 4; i++) {
    const t = topics[Math.floor(rng() * topics.length)];
    const v = verbs[Math.floor(rng() * verbs.length)];
    sentences.push(`系统会在第 ${index}-${i} 步对 ${t} 执行 ${v} 操作以保证稳定性。`);
  }
  return { heading, content: sentences.join('\n') };
}

/**
 * 生成一个用于 bench 的合成向量库文件，返回文件路径与元数据。
 */
async function buildBenchStore(
  dir: string,
  size: number,
  dim: number,
): Promise<{ vectorStore: string; meta: StoreMeta }> {
  const rng = createRng(size * 1000 + dim);
  const vectorStore = join(dir, `bench-${size}.ndjson`);
  const meta: StoreMeta = {
    version: 1,
    provider: embeddingConfig.provider,
    model: embeddingConfig.model,
    dim,
    chunkSize: 600,
    chunkOverlap: 80,
    headingWeight: 2,
    createdAt: new Date().toISOString(),
  };

  const records: object[] = new Array(size);
  for (let i = 0; i < size; i++) {
    const { heading, content } = makeSyntheticText(i, rng);
    const stats = buildKeywordStats(heading, content);
    records[i] = {
      id: `doc-${i % 200}.md#${i}`,
      source: `doc-${i % 200}.md`,
      chunkIndex: i,
      heading,
      content,
      hash: `hash-${i}`,
      embedding: makeRandomVector(dim, rng),
      ...stats,
    };
  }

  await writeVectorStore(meta, records, vectorStore, {
    intermediateDir: BENCH_INTERMEDIATE_DIR,
  });
  return { vectorStore, meta };
}

/**
 * 计时工具：执行函数并返回毫秒耗时与结果。
 */
async function timed<T>(fn: () => Promise<T> | T): Promise<{ ms: number; result: T }> {
  const t0 = performance.now();
  const result = await fn();
  return { ms: performance.now() - t0, result };
}

/**
 * 取 RSS 内存占用（MB），仅用于打印参考。
 */
function rssMB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

/**
 * 简易 print，统一格式化输出。
 */
function printRow(label: string, value: string): void {
  // eslint-disable-next-line no-console
  console.log(`  ${label.padEnd(28)} ${value}`);
}

/**
 * 读取 baseline 文件，不存在或解析失败时返回 undefined。
 */
async function readBaseline(): Promise<BenchRun | undefined> {
  try {
    const raw = await readFile(BASELINE_FILE, 'utf-8');
    return JSON.parse(raw) as BenchRun;
  } catch {
    return undefined;
  }
}

/**
 * 把当前 BenchRun 追加到 history.jsonl（一行一条）。
 */
async function appendHistory(run: BenchRun): Promise<void> {
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  await appendFile(HISTORY_FILE, JSON.stringify(run) + '\n', 'utf-8');
}

/**
 * 把当前 BenchRun 保存为 baseline.json（覆盖式）。
 */
async function saveBaseline(run: BenchRun): Promise<void> {
  await mkdir(dirname(BASELINE_FILE), { recursive: true });
  await writeFile(BASELINE_FILE, JSON.stringify(run, null, 2), 'utf-8');
}

/**
 * 比较 current 与 baseline 中同一 size 的指标，输出 diff 表。
 * 规则：
 *   - 耗时类指标越小越好，下降为 ↓（绿色 ✓），上升为 ↑（红色 ✗）
 *   - 内存类视为越小越好
 *   - 阈值 5%：变化在 ±5% 内打印为 ≈，避免抖动误读
 */
function printDelta(current: BenchMetrics, baseline: BenchMetrics): void {
  const fmt = (
    name: string,
    cur: number,
    base: number,
    unit: string,
    smallerIsBetter = true,
  ): void => {
    if (base === 0) {
      printRow(name, `${cur.toFixed(2)}${unit} (no baseline)`);
      return;
    }
    const deltaPct = ((cur - base) / base) * 100;
    const absPct = Math.abs(deltaPct);
    let arrow = '≈';
    if (absPct >= 5) arrow = deltaPct < 0 ? '↓' : '↑';
    const isBetter = smallerIsBetter ? deltaPct < 0 : deltaPct > 0;
    const tag = absPct < 5 ? '' : isBetter ? ' ✓' : ' ✗';
    const sign = deltaPct >= 0 ? '+' : '';
    printRow(
      name,
      `${base.toFixed(2)} → ${cur.toFixed(2)}${unit}  (${sign}${deltaPct.toFixed(1)}% ${arrow}${tag})`,
    );
  };

  fmt('write store (ms)', current.writeMs, baseline.writeMs, ' ms');
  fmt('cold load (ms)', current.loadMs, baseline.loadMs, ' ms');
  fmt('build retriever (ms)', current.retrieverMs, baseline.retrieverMs, ' ms');
  fmt('query vector-only avg', current.vectorOnlyAvgMs, baseline.vectorOnlyAvgMs, ' ms');
  fmt('query hybrid avg', current.hybridAvgMs, baseline.hybridAvgMs, ' ms');
  fmt('rss after (MB)', current.rssAfterMB, baseline.rssAfterMB, ' MB');
}

// ----------------------------- 实际基准流程 -----------------------------

async function runBench(): Promise<void> {
  // 跑前打印 header（含时间戳、环境信息），保证终端 / 日志重定向都能看到
  const startedAt = new Date();
  const cpuModel = os.cpus()?.[0]?.model ?? 'unknown';
  const cpuCount = os.cpus()?.length ?? 0;
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `[bench] started at ${startedAt.toISOString()}`,
      `[bench] node=${process.version} platform=${process.platform} arch=${process.arch}`,
      `[bench] cpu="${cpuModel}" x${cpuCount}  totalMem=${totalMemMB} MB`,
      `[bench] sizes=${BENCH_SIZES.join(',')} dim=${BENCH_DIM} queryTimes=${QUERY_TIMES}` +
        (BENCH_LABEL ? `  label="${BENCH_LABEL}"` : ''),
      `[bench] intermediateDir=${BENCH_INTERMEDIATE_DIR ?? '(disabled)'}`,
      '',
    ].join('\n'),
  );

  const baseline = await readBaseline();
  if (baseline) {
    // eslint-disable-next-line no-console
    console.log(
      `[bench] baseline @ ${baseline.timestamp}` +
        (baseline.label ? ` label="${baseline.label}"` : '') +
        '\n',
    );
  }

  const dir = await mkdtemp(join(tmpdir(), 'tiny-rag-bench-'));
  const metricsList: BenchMetrics[] = [];

  try {
    for (const size of BENCH_SIZES) {
      const rssBefore = rssMB();

      // 1) 写盘耗时
      const { ms: writeMs, result: built } = await timed(() =>
        buildBenchStore(dir, size, BENCH_DIM),
      );

      // 2) 冷启动加载耗时
      const { ms: loadMs, result: store } = await timed(() =>
        loadVectorStore(embeddingConfig, {
          vectorStore: built.vectorStore,
          intermediateDir: BENCH_INTERMEDIATE_DIR,
        }),
      );

      const rssAfterLoad = rssMB();

      // 3) 构造一次 retriever（构建期开销）
      const { ms: retrieverMs, result: retriever } = await timed(() =>
        createLoadedRetriever(embeddingConfig, store, { topK: 4, perSourceLimit: 2 }),
      );

      // 4) 查询耗时（多次取均值，分别测试 keywordWeight=0 / 0.3）
      const rng = createRng(size + 7);
      const queryEmbedding = makeRandomVector(BENCH_DIM, rng);
      const queryText = '缓存策略 优化 cache index';

      let vectorOnlyTotal = 0;
      let hybridTotal = 0;
      for (let i = 0; i < QUERY_TIMES; i++) {
        const { ms: vMs } = await timed(() =>
          retriever.search(queryEmbedding, queryText, { keywordWeight: 0 }),
        );
        const { ms: hMs } = await timed(() =>
          retriever.search(queryEmbedding, queryText, { keywordWeight: 0.3 }),
        );
        vectorOnlyTotal += vMs;
        hybridTotal += hMs;
      }
      const vectorOnlyAvg = vectorOnlyTotal / QUERY_TIMES;
      const hybridAvg = hybridTotal / QUERY_TIMES;

      const m: BenchMetrics = {
        size,
        writeMs,
        loadMs,
        retrieverMs,
        vectorOnlyAvgMs: vectorOnlyAvg,
        hybridAvgMs: hybridAvg,
        rssBeforeMB: rssBefore,
        rssAfterMB: rssAfterLoad,
        recordsLoaded: store.records.length,
      };
      metricsList.push(m);

      // ----------------------------- 报表输出 -----------------------------
      // eslint-disable-next-line no-console
      console.log(`\n[bench] chunks=${size}`);
      const baseSame = baseline?.metrics.find((b) => b.size === size);
      if (baseSame) {
        // 有基线 → 输出 delta 表（同时保留绝对值）
        printDelta(m, baseSame);
        printRow('records loaded', String(m.recordsLoaded));
      } else {
        // 没有基线 → 只打印当前绝对值
        printRow('write store (ms)', writeMs.toFixed(1));
        printRow('cold load (ms)', loadMs.toFixed(1));
        printRow('build retriever (ms)', retrieverMs.toFixed(2));
        printRow('query vector-only avg (ms)', vectorOnlyAvg.toFixed(2));
        printRow('query hybrid avg (ms)', hybridAvg.toFixed(2));
        printRow('rss before / after (MB)', `${rssBefore} -> ${rssAfterLoad}`);
        printRow('records loaded', String(m.recordsLoaded));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // ----------------------------- 历史 / 基线落盘 -----------------------------
  const run: BenchRun = {
    timestamp: startedAt.toISOString(),
    label: BENCH_LABEL,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel,
    cpuCount,
    totalMemMB,
    params: {
      sizes: BENCH_SIZES,
      dim: BENCH_DIM,
      queryTimes: QUERY_TIMES,
      ...(BENCH_INTERMEDIATE_DIR ? { intermediateDir: BENCH_INTERMEDIATE_DIR } : {}),
    },
    metrics: metricsList,
  };

  if (!BENCH_NO_LOG) {
    await appendHistory(run);
    // eslint-disable-next-line no-console
    console.log(`\n[bench] history appended → ${HISTORY_FILE}`);
  }

  if (BENCH_BASELINE_SAVE) {
    await saveBaseline(run);
    // eslint-disable-next-line no-console
    console.log(`[bench] baseline saved   → ${BASELINE_FILE}`);
  } else if (!baseline) {
    // eslint-disable-next-line no-console
    console.log(
      `[bench] no baseline yet. Run with BENCH_BASELINE_SAVE=1 to save current run as baseline.`,
    );
  }
}

await runBench();
