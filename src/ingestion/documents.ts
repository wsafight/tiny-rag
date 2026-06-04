import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DOCUMENT_EXTENSIONS } from '../constants/index';
import { invariant, runWithConcurrency } from '../utils/index';
import type { LoadDocumentsOptions, SourceDocument } from './types';

const DOCUMENT_READ_CONCURRENCY = 16;

export function normalizeDocumentExtensions(
  extensions: readonly string[] = DEFAULT_DOCUMENT_EXTENSIONS,
): string[] {
  const normalized = extensions
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

  const unique = [...new Set(normalized)];
  invariant(unique.length === 0, 'documentExtensions 至少需要包含一个扩展名');
  return unique;
}

function toPortableRelativePath(root: string, fullPath: string): string {
  const relative = path.relative(root, fullPath) || path.basename(fullPath);
  return relative.split(path.sep).join(path.posix.sep);
}

async function listDocumentFilesFromDirectory(
  dir: string,
  extensions: ReadonlySet<string>,
): Promise<string[]> {
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const parts = await Promise.all(
    entries.map((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listDocumentFilesFromDirectory(fullPath, extensions);
      }
      return extensions.has(path.extname(entry.name).toLowerCase()) ? [fullPath] : [];
    }),
  );
  return parts.flat();
}

export async function loadDocuments(
  dir: string,
  options: LoadDocumentsOptions = {},
): Promise<SourceDocument[]> {
  const extensions = new Set(normalizeDocumentExtensions(options.extensions));
  const sourceRoot = path.resolve(options.sourceRoot ?? dir);
  const excludeSources = new Set(
    (options.excludeSources ?? []).map((source) => source.split('\\').join('/')),
  );
  const files = await listDocumentFilesFromDirectory(path.resolve(dir), extensions);
  const tasks = files.map((fullPath) => async (): Promise<SourceDocument | undefined> => {
    const source = toPortableRelativePath(sourceRoot, path.resolve(fullPath));
    if (excludeSources.has(source)) return undefined;
    const content = await fs.readFile(fullPath, 'utf-8');
    const doc = { source, content };
    if (options.filterDocument && !options.filterDocument(doc)) return undefined;
    return doc;
  });
  const docs = await runWithConcurrency(tasks, DOCUMENT_READ_CONCURRENCY);
  return docs.filter((doc): doc is SourceDocument => doc !== undefined);
}
