/** Cancellation and native finalization take precedence at the call site.
 * Adapters without a child process may legitimately omit an exit code.
 */
export function legacyAdapterOutcome(result: {
  timedOut?: boolean;
  signal?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
}): "succeeded" | "failed" | "timed_out" {
  if (result.timedOut) return "timed_out";
  if (result.signal || (result.exitCode ?? 0) !== 0 || result.errorMessage) return "failed";
  return "succeeded";
}
