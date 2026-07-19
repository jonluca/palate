/** Format a Unix timestamp as its calendar date in the current locale. */
export function getLocalDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parse the manual date formats accepted by the visit form at local midnight. */
export function parseLocalDateInput(value: string): Date | null {
  const trimmed = value.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  const parts = isoMatch
    ? { year: Number(isoMatch[1]), month: Number(isoMatch[2]), day: Number(isoMatch[3]) }
    : usMatch
      ? { year: Number(usMatch[3]), month: Number(usMatch[1]), day: Number(usMatch[2]) }
      : null;

  if (!parts) {
    return null;
  }

  const parsed = new Date(parts.year, parts.month - 1, parts.day);
  if (parsed.getFullYear() !== parts.year || parsed.getMonth() !== parts.month - 1 || parsed.getDate() !== parts.day) {
    return null;
  }
  return parsed;
}
