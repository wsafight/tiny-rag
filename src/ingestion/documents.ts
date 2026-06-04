import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DOCUMENT_EXTENSIONS } from '../constants/index';
import { invariant } from '../utils/index';
import type { LoadDocumentsOptions, SourceDocument } from './types';

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

async function loadDocumentsFromDirectory(
  dir: string,
  sourceRoot: string,
  extensions: ReadonlySet<string>,
  excludeSources: ReadonlySet<string>,
  filterDocument?: (document: SourceDocument) => boolean,
): Promise<SourceDocument[]> {
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const docs: SourceDocument[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      docs.push(
        ...(await loadDocumentsFromDirectory(
          fullPath,
          sourceRoot,
          extensions,
          excludeSources,
          filterDocument,
        )),
      );
    } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      const content = await fs.readFile(fullPath, 'utf-8');
      const doc = { source: toPortableRelativePath(sourceRoot, path.resolve(fullPath)), content };
      if (excludeSources.has(doc.source)) continue;
      if (filterDocument && !filterDocument(doc)) continue;
      docs.push(doc);
    }
  }
  return docs;
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
  return loadDocumentsFromDirectory(
    path.resolve(dir),
    sourceRoot,
    extensions,
    excludeSources,
    options.filterDocument,
  );
}
