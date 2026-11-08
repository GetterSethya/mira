export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function plainHeadingText(value: string) {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_]/g, '')
    .trim();
}

export function extractHeadings(source: string) {
  const headings: Array<{ id: string; text: string; level: number }> = [];
  let inFence = false;

  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) continue;

    const match = /^(##|###)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;

    const text = plainHeadingText(match[2]);
    if (text) headings.push({ id: slugify(text), text, level: match[1].length });
  }

  return headings;
}

export function stripMarkdown(source: string) {
  return source
    .replace(/^```.*$/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
