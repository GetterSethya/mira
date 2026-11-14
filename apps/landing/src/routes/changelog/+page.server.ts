import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { slugify } from '$lib/docs/headings';
import { renderMarkdown } from '$lib/docs/markdown';

export const prerender = true;

const REPO = 'GetterSethya/mira';
const CHANGELOG_URL = `https://raw.githubusercontent.com/${REPO}/main/CHANGELOG.md`;
const CHANGELOG_PAGE = `https://github.com/${REPO}/blob/main/CHANGELOG.md`;

type RawSection = {
  readonly version: string;
  readonly date: string | null;
  readonly body: string;
  readonly unreleased: boolean;
  readonly url: string | null;
};

export type ChangelogEntry = RawSection & {
  readonly dateLabel: string | null;
  readonly html: string;
};

function parseChangelog(source: string): Array<RawSection> {
  const sections: Array<RawSection> = [];
  let current: RawSection | undefined;

  for (const line of source.split(/\r?\n/)) {
    const heading = /^##\s+\[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/.exec(line);

    if (heading) {
      if (current) sections.push(current);

      const version = heading[1];
      const unreleased = version.toLowerCase() === 'unreleased';

      current = {
        version,
        date: heading[2] ?? null,
        body: '',
        unreleased,
        url: unreleased
          ? null
          : `https://github.com/${REPO}/releases/tag/v${version}`
      };
      continue;
    }

    if (current) current = { ...current, body: `${current.body}${line}\n` };
  }

  if (current) sections.push(current);

  return sections
    .map((section) => ({ ...section, body: section.body.trim() }))
    .filter((section) => section.unreleased || section.body.length > 0);
}

async function readChangelog(fetch: typeof globalThis.fetch) {
  try {
    const response = await fetch(CHANGELOG_URL, {
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

    return {
      source: await response.text(),
      sourceUrl: CHANGELOG_PAGE,
      fetchedFromGitHub: true
    };
  } catch {
    const source = await readFile(join(process.cwd(), '../../CHANGELOG.md'), 'utf8');
    return { source, sourceUrl: CHANGELOG_PAGE, fetchedFromGitHub: false };
  }
}

function formatDate(date: string | null) {
  if (!date) return null;

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${date}T00:00:00Z`));
}

export async function load({ fetch }: { fetch: typeof globalThis.fetch }) {
  const { source, sourceUrl, fetchedFromGitHub } = await readChangelog(fetch);
  const entries: Array<ChangelogEntry> = await Promise.all(
    parseChangelog(source).map(async (section) => ({
      ...section,
      dateLabel: formatDate(section.date),
      html: await renderMarkdown(section.body, {
        anchorPrefix: `${slugify(section.version)}-`
      })
    }))
  );

  return { entries, sourceUrl, fetchedFromGitHub };
}
