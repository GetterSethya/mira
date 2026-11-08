import { renderMarkdown } from '$lib/docs/markdown';
import { quickstartSamples } from '$lib/quickstart-samples';

export const load = async () => ({
  samples: await Promise.all(
    quickstartSamples.map(async (sample) => ({
      ...sample,
      html: await renderMarkdown(`\`\`\`${sample.lang}\n${sample.code}\n\`\`\``)
    }))
  )
});
