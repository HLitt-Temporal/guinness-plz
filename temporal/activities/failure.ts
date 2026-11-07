/*
  What every activity shares: turning a thrown error into a Temporal failure,
  and opening a headless browser for one activity.

  A thrown WorkflowError keeps its sentence, because that sentence is what the
  page shows. A missing API key is not retried. A timeout is retried, within
  the attempt limit on the workflow's activity proxy, because the next try may
  be a transient provider failure.
*/

import { ApplicationFailure } from '@temporalio/activity';
import { createHeadlessMaps } from '../../headless-maps.ts';
import { WorkflowError } from '../../workflow.ts';

export type Maps = Awaited<ReturnType<typeof createHeadlessMaps>>;

export function toActivityFailure(error: unknown): never {
  if (error instanceof ApplicationFailure) throw error;
  if (error instanceof WorkflowError) {
    throw ApplicationFailure.create({
      message: error.message,
      type: 'WorkflowError',
      nonRetryable: error.message.includes('OPENAI_API_KEY'),
    });
  }
  if (error instanceof Error && error.message) {
    throw ApplicationFailure.create({ message: error.message });
  }
  throw ApplicationFailure.create({
    message: 'The provider response could not be processed. Please retry.',
  });
}

// Each map activity gets its own browser, closed when the activity ends, so a
// retry does not reuse a page from a crashed attempt.
export async function withMaps<T>(run: (maps: Maps) => Promise<T>): Promise<T> {
  let maps: Maps | undefined;
  try {
    maps = await createHeadlessMaps();
    return await run(maps);
  } catch (error) {
    throw toActivityFailure(error);
  } finally {
    await maps?.close().catch(() => {});
  }
}
