const DAY_MS = 24 * 60 * 60 * 1000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function localTimeAsUtc(timestamp: number, timeZone: string): number {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value;
  return Date.parse(
    `${part("year")?.padStart(4, "0")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}Z`,
  );
}

export function getResyLocalDate(timestamp: number, timeZone: string): string {
  return new Date(localTimeAsUtc(timestamp, timeZone)).toISOString().slice(0, 10);
}

function resolveLocalTime(wallTime: number, timeZone: string, after: number): number | null {
  // Sample both sides of a possible offset transition, then require an exact
  // round trip. Gaps are rejected; repeated clocks choose the first valid instant.
  const offsets = new Set<number>();
  for (const delta of [-DAY_MS, 0, DAY_MS]) {
    const sample = wallTime + delta;
    offsets.add(localTimeAsUtc(sample, timeZone) - Math.floor(sample / 1000) * 1000);
  }
  let result = Infinity;
  for (const offset of offsets) {
    const candidate = wallTime - offset;
    if (candidate > after && localTimeAsUtc(candidate, timeZone) === Math.floor(wallTime / 1000) * 1000) {
      result = Math.min(result, candidate);
    }
  }
  return Number.isFinite(result) ? result : null;
}

/** Parse Resy's ISO dates or local clocks without consulting the device timezone. */
export function parseResyTime(value: string, day: string | null, timeZone: string, after = -Infinity): number | null {
  const match = /^(?:(\d{4}-\d{2}-\d{2})[T ])?(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(
    value.trim(),
  );
  if (!match) {
    return null;
  }
  const date = match[1] ?? day;
  if (!date) {
    return null;
  }
  const local = `${date}T${match[2]}:${match[3]}:${match[4] ?? "00"}.${(match[5] ?? "0").slice(0, 3).padEnd(3, "0")}`;
  const wallTime = Date.parse(`${local}Z`);
  if (!Number.isFinite(wallTime) || new Date(wallTime).toISOString() !== `${local}Z`) {
    return null;
  }
  if (match[6]) {
    const timestamp = Date.parse(`${local}${match[6]}`);
    if (!match[1] && timestamp < after && timestamp + DAY_MS > after) {
      return timestamp + DAY_MS;
    }
    return Number.isFinite(timestamp) && timestamp > after ? timestamp : null;
  }
  const resolved = resolveLocalTime(wallTime, timeZone, after);
  if (resolved !== null) {
    return resolved;
  }
  // An end clock before the start may belong to tomorrow. Full dates never
  // roll forward, and daylight-saving gaps later that day remain invalid.
  if (!match[1] && Number.isFinite(after) && wallTime < localTimeAsUtc(after, timeZone)) {
    return resolveLocalTime(wallTime + DAY_MS, timeZone, after);
  }
  return null;
}
