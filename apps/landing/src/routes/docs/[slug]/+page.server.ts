import { error } from '@sveltejs/kit';

import { assertContentParity, getContent } from '$lib/docs/content';
import { getDocsPage, getPrevNext, docsPages } from '$lib/docs/nav';
import { getHeadings, renderMarkdown } from '$lib/docs/markdown';

export const prerender = true;

export function entries() {
  return docsPages.map((page) => ({ slug: page.slug }));
}

export async function load({ params }) {
  assertContentParity();

  const page = getDocsPage(params.slug);
  if (!page) throw error(404, 'Not found');

  const source = getContent(page.slug);
  if (!source) throw error(404, 'Not found');

  const html = await renderMarkdown(source);
  const headings = getHeadings(html);
  const { prev, next } = getPrevNext(page.slug);

  return { page, html, headings, prev, next };
}
