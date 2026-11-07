/*
  The message the page should show when a workflow or activity fails.

  Temporal wraps that message: a workflow failure contains an activity failure,
  which contains the error the activity threw. The useful sentence is the
  innermost one. The fallback is the same text the in-process runner used when
  a provider response could not be read.
*/

const FALLBACK = 'The provider response could not be processed. Please retry.';

export function failureText(error: unknown): string {
  let message = FALLBACK;
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message) message = current.message;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return message;
}
