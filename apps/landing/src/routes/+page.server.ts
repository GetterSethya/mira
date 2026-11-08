import { highlightCode } from '$lib/highlight';
import { quickstartSamples } from '$lib/quickstart-samples';

export const load = async () => ({
  samples: await Promise.all(
    quickstartSamples.map(async (sample) => ({
      ...sample,
      html: await highlightCode(sample.code, sample.lang)
    }))
  )
});
