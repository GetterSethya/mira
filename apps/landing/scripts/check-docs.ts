import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { docsPages } from '../src/lib/docs/nav.ts';

const packageRoot = process.cwd();
const repoRoot = join(packageRoot, '../..');
const contentDir = join(packageRoot, 'src/lib/docs/content');

const contentSlugs = new Set(
  readdirSync(contentDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -3))
);

const manifestSlugs = new Set(docsPages.map((page) => page.slug));
const errors: Array<string> = [];

const bannedLiterals: ReadonlyArray<{ literal: string; allowedIn: ReadonlyArray<string> }> = [
  { literal: 'PostCollection', allowedIn: [] },
  { literal: 'UserCollection', allowedIn: [] },
  { literal: 'PostsRules', allowedIn: [] },
  { literal: 'postRules', allowedIn: [] },
  { literal: 'localhost:3000', allowedIn: [] },
  { literal: '127.0.0.1:3000', allowedIn: [] },
  { literal: 'port: 3000', allowedIn: [] },
  { literal: '@gettersethya/mira-collection', allowedIn: ['api'] }
];

const linesOutsideFences = (source: string) => {
  const lines: Array<string> = [];
  let inFence = false;
  for (const line of source.split(/\r?\n/)) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) lines.push(line);
  }
  return lines;
};

for (const page of docsPages) {
  const contentPath = join(contentDir, `${page.slug}.md`);
  if (!contentSlugs.has(page.slug)) {
    errors.push(`missing content file: src/lib/docs/content/${page.slug}.md`);
  }

  for (const contract of page.contracts) {
    if (!existsSync(join(repoRoot, contract))) {
      errors.push(`${page.slug}: missing contract ${contract}`);
    }
  }

  for (const folder of page.sourceFolders) {
    if (!existsSync(join(repoRoot, folder))) {
      errors.push(`${page.slug}: missing source folder ${folder}`);
    }
  }

  if (page.summary.trim().split(/\s+/).length > 30) {
    errors.push(`${page.slug}: summary is longer than 30 words`);
  }

  if (!contentSlugs.has(page.slug)) continue;

  const source = readFileSync(contentPath, 'utf8');
  const lines = linesOutsideFences(source);
  const h1Index = lines.findIndex((line) => /^#\s+/.test(line));
  const firstBodyLine = lines.slice(h1Index + 1).find((line) => line.trim().length > 0);
  if (firstBodyLine === undefined) {
    errors.push(`${page.slug}: missing goal paragraph`);
  } else if (/^#{1,6}\s/.test(firstBodyLine)) {
    errors.push(`${page.slug}: first content line is a heading, expected the goal paragraph`);
  }

  const h2s = lines.filter((line) => /^##\s+/.test(line));
  if (h2s.length === 0 || h2s[h2s.length - 1]?.trim() !== '## Next') {
    errors.push(`${page.slug}: last H2 must be "## Next"`);
  }

  for (const { literal, allowedIn } of bannedLiterals) {
    if (source.includes(literal) && !allowedIn.includes(page.slug)) {
      errors.push(`${page.slug}: banned literal "${literal}"`);
    }
  }

  const linkPattern = /\]\((\.\.\/[^)\s#]+)(?:#[^)]*)?\)/g;
  for (const match of source.matchAll(linkPattern)) {
    const target = match[1];
    if (target === undefined || target.startsWith('../../')) continue;
    const slug = target.slice(3).split('/')[0];
    if (slug !== undefined && slug.length > 0 && !manifestSlugs.has(slug)) {
      errors.push(`${page.slug}: relative link target is not in the manifest: ${target}`);
    }
  }
}

for (const slug of contentSlugs) {
  if (!manifestSlugs.has(slug)) {
    errors.push(`unlisted content file: src/lib/docs/content/${slug}.md`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exitCode = 1;
} else {
  console.log(`docs manifest ok: ${docsPages.length} pages`);
}
