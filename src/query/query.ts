import { performance } from 'node:perf_hooks';
import { buildContext, buildMessages, resolvePromptOptions } from './prompt';
import { resolveSearchOptions, searchVectorStore, selectDiverseHits } from './retrieval';
import { hasValidEmbedding, invariant, normalizeToFloat32 } from '../utils/index';
import type { QueryOptions, QueryResult, RetrieverSearchOptions, SearchHit } from './types';

function pickRetrieverSearchOptions(options: Required<RetrieverSearchOptions>): RetrieverSearchOptions {
  return {
    topK: options.topK,
    minScore: options.minScore,
    perSourceLimit: options.perSourceLimit,
    keywordWeight: options.keywordWeight,
    keywordHeadingWeight: options.keywordHeadingWeight,
  };
}

function buildResultBase(
  options: QueryOptions,
  values: {
    question: string;
    answer: string;
    llmConfig: QueryResult['llmConfig'];
    embeddingConfig: QueryResult['embeddingConfig'];
    meta: QueryResult['meta'];
    candidates: SearchHit[];
    hits: SearchHit[];
    context: string;
    embeddingElapsedMs: number;
    searchElapsedMs: number;
    retrievalElapsedMs: number;
    generationElapsedMs?: number;
    noAnswerReason?: QueryResult['noAnswerReason'];
  },
): QueryResult {
  return {
    question: values.question,
    answer: values.answer,
    llmConfig: values.llmConfig,
    embeddingConfig: values.embeddingConfig,
    meta: values.meta,
    ...(options.includeCandidates ?? true ? { candidates: values.candidates } : {}),
    hits: values.hits,
    ...(options.includeContext ?? true ? { context: values.context } : {}),
    embeddingElapsedMs: values.embeddingElapsedMs,
    searchElapsedMs: values.searchElapsedMs,
    retrievalElapsedMs: values.retrievalElapsedMs,
    ...(values.generationElapsedMs !== undefined
      ? { generationElapsedMs: values.generationElapsedMs }
      : {}),
    ...(values.noAnswerReason ? { noAnswerReason: values.noAnswerReason } : {}),
  };
}

/**
 * Take a question and return the full query result; does not print, read terminal input, or exit the process.
 */
export async function query(question: string, options: QueryOptions): Promise<QueryResult> {
  const trimmedQuestion = question.trim();
  invariant(!trimmedQuestion, '[query] no question provided');

  const searchOptions = resolveSearchOptions(options);
  const retrieverSearchOptions = pickRetrieverSearchOptions(searchOptions);
  const promptOptions = resolvePromptOptions(options.prompt);
  const llmConfig = options.llmConfig;
  const embConfig = searchOptions.embeddingConfig;

  const embeddingStartedAt = performance.now();
  const [questionRaw] = await options.embed([trimmedQuestion]);
  invariant(!hasValidEmbedding(questionRaw), '[query] question did not get a valid embedding');
  const questionEmbedding = normalizeToFloat32(questionRaw);
  const embeddingElapsedMs = performance.now() - embeddingStartedAt;

  const searchStartedAt = performance.now();
  const searchResult = options.retriever
    ? options.retriever.search(questionEmbedding, trimmedQuestion, retrieverSearchOptions)
    : await searchVectorStore(embConfig, questionEmbedding, trimmedQuestion, searchOptions);
  const searchElapsedMs = performance.now() - searchStartedAt;
  const meta = searchResult.meta;
  const candidates = searchResult.hits;
  const hits = selectDiverseHits(candidates, {
    perSourceLimit: searchOptions.perSourceLimit,
    maxTotal: searchOptions.topK,
  });
  const retrievalElapsedMs = embeddingElapsedMs + searchElapsedMs;
  options.onRetrieved?.({
    candidates,
    hits,
    embeddingElapsedMs,
    searchElapsedMs,
    retrievalElapsedMs,
  });

  if (hits.length === 0) {
    return buildResultBase(options, {
      question: trimmedQuestion,
      answer: promptOptions.unknownAnswer,
      llmConfig,
      embeddingConfig: embConfig,
      meta,
      candidates,
      hits,
      context: '',
      embeddingElapsedMs,
      searchElapsedMs,
      retrievalElapsedMs,
      noAnswerReason: 'no-hits',
    });
  }

  const context = buildContext(hits);
  const messages = options.buildMessages
    ? [...options.buildMessages(context, trimmedQuestion)]
    : buildMessages(context, trimmedQuestion, options.prompt);

  const generationStartedAt = performance.now();
  const answer = await options.chat(
    messages,
    options.stream ? { onToken: options.onToken ?? (() => {}) } : {},
  );
  const generationElapsedMs = performance.now() - generationStartedAt;

  return buildResultBase(options, {
    question: trimmedQuestion,
    answer,
    llmConfig,
    embeddingConfig: embConfig,
    meta,
    candidates,
    hits,
    context,
    embeddingElapsedMs,
    searchElapsedMs,
    retrievalElapsedMs,
    generationElapsedMs,
  });
}
