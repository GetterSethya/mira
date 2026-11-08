import { existsSync, readdirSync } from 'node:fs';
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

for (const page of docsPages) {
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
