import { extractHeadings, slugify, stripMarkdown } from './headings';
import { docsPages } from './nav';

const modules = import.meta.glob<string>('./content/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
});

const contentBySlug = new Map(
  Object.entries(modules).map(([file, source]) => {
    const name = file.slice(file.lastIndexOf('/') + 1, -3);
    return [name, source];
  })
);

export type DocsSearchEntry = {
  readonly slug: string;
  readonly pageTitle: string;
  readonly title: string;
  readonly context: string;
  readonly anchor: string | null;
  readonly text: string;
  readonly body: string;
  readonly order: number;
};

const searchIndex: Array<DocsSearchEntry> = [];

for (const [order, page] of docsPages.entries()) {
  const source = contentBySlug.get(page.slug) ?? '';

  searchIndex.push({
    slug: page.slug,
    pageTitle: page.title,
    title: page.title,
    context: page.summary,
    anchor: null,
    text: `${page.title} ${page.summary}`.toLowerCase(),
    body: '',
    order
  });

  const lines = source.split('\n');
  let inFence = false;
  let current: { id: string; text: string } | null = null;
  let body: Array<string> = [];

  const flush = () => {
    const text = body.join('\n').trim();
    body = [];
    if (stripMarkdown(text).length < 30) return;

    searchIndex.push({
      slug: page.slug,
      pageTitle: page.title,
      title: current?.text ?? page.title,
      context: page.title,
      anchor: current?.id ?? null,
      text: `${current?.text ?? ''} ${page.title} ${text}`.toLowerCase(),
      body: text,
      order
    });
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      body.push(line);
      continue;
    }

    if (!inFence) {
      const heading = /^(##|###)\s+(.+?)\s*$/.exec(line);
      if (heading) {
        flush();
        const text = heading[2]
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/[*_]/g, '')
          .trim();
        current = { id: slugify(text), text };
        continue;
      }
    }

    body.push(line);
  }

  flush();
}

export function getContent(slug: string) {
  return contentBySlug.get(slug);
}

export function assertContentParity() {
  const manifestSlugs = new Set(docsPages.map((page) => page.slug));
  const contentSlugs = new Set(contentBySlug.keys());

  const missing = [...manifestSlugs].filter((slug) => !contentSlugs.has(slug));
  const orphaned = [...contentSlugs].filter((slug) => !manifestSlugs.has(slug));

  if (missing.length > 0 || orphaned.length > 0) {
    const parts: Array<string> = [];
    if (missing.length > 0) parts.push(`missing content: ${missing.join(', ')}`);
    if (orphaned.length > 0) parts.push(`unlisted content: ${orphaned.join(', ')}`);
    throw new Error(`Docs manifest/content mismatch: ${parts.join('; ')}`);
  }
}

function snippetFor(source: string, needle: string) {
  const plain = stripMarkdown(source);
  let index = plain.toLowerCase().indexOf(needle);

  if (index === -1) {
    const firstTerm = needle.split(/\s+/).find(Boolean);
    if (!firstTerm) return null;
    index = plain.toLowerCase().indexOf(firstTerm);
  }

  if (index === -1) return null;

  const start = Math.max(0, plain.lastIndexOf(' ', Math.max(0, index - 45)));
  const end = Math.min(plain.length, index + needle.length + 90);
  return `${start > 0 ? '…' : ''}${plain.slice(start, end).trim()}${end < plain.length ? '…' : ''}`;
}

export function searchDocs(query: string) {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const terms = needle.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  return searchIndex
    .filter((entry) => terms.every((term) => entry.text.includes(term)))
    .map((entry) => {
      const title = entry.title.toLowerCase();
      const score = title.startsWith(needle)
        ? 0
        : title.includes(needle)
          ? 1
          : terms.every((term) => title.includes(term))
            ? 2
            : 3;
      const context = snippetFor(entry.body, needle) ?? entry.context;
      return { entry: { ...entry, context }, score };
    })
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.entry.order - b.entry.order ||
        a.entry.title.length - b.entry.title.length
    )
    .slice(0, 10)
    .map(({ entry }) => entry);
}
