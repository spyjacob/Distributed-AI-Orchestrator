/**
 * Usage accounting across every session.
 *
 * Two different things get called "usage" and they do not mix:
 *
 *  - What the harness observed. Tokens, time and tool calls summed from the
 *    transcripts it wrote. Always available, for every backend, but it only
 *    knows about work done through this app.
 *  - What the provider reports. A subscription's rolling-window utilisation,
 *    which counts everything on the account including sessions the harness
 *    never saw. Authoritative, but only some backends report it.
 *
 * Both are shown, labelled, and never added together.
 */

export const WINDOWS = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  all: Infinity,
};

/**
 * A provider's own rolling-window report, normalised for display.
 * Shape follows the `rate_limit_event` the claude CLI emits.
 */
export function normalizeProviderLimits(info) {
  if (!info) return null;
  const windows = Object.entries(info.unifiedWindows ?? {}).map(([name, w]) => ({
    name,
    pct: w.utilization ?? 0,
    resetsAt: w.resetsAt ? w.resetsAt * 1000 : null,
  }));
  return {
    status: info.status ?? null,
    kind: info.rateLimitType ?? null,
    usingOverage: Boolean(info.isUsingOverage),
    windows: windows.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
