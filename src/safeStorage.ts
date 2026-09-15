export function readStoredJson<T>(
  key: string,
  fallback: T,
  validate: (value: unknown) => value is T,
): T {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return fallback;
  }
  if (raw == null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (validate(parsed)) return parsed;
  } catch {
    // Remove malformed state below so every read does not fail again.
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  return fallback;
}

export function writeStoredJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    const reason = error instanceof Error && error.name === "QuotaExceededError"
      ? "Local storage is full. Remove unused workflows or browser data and try again."
      : "Local storage is unavailable. Check this app's site-storage permissions and try again.";
    throw new Error(reason, { cause: error });
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
