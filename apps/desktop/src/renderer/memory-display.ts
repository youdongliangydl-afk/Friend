/**
 * Memory display helpers shared by the Memory Center list and the run panel.
 *
 * These helpers only shorten how a record is shown. They never rewrite the
 * record: the full content stays available in the detail drawer / expanded row.
 */
const text = (value: unknown) => typeof value === 'string' ? value : '';

/**
 * One-line gist: keep whole sentences until roughly `target` characters, then
 * clamp to `max`. A gist is a display preview, not a generated conclusion.
 */
export function memoryGist(content: unknown, max = 80, target = 40): string {
  const raw = text(content).replace(/^#+\s*/u, '').replace(/\s+/gu, ' ').trim();
  if (!raw) return '';
  let gist = '';
  for (const sentence of raw.split(/(?<=[。！？!?])/u)) {
    gist += sentence;
    if (Array.from(gist.trim()).length >= target) break;
  }
  const chars = Array.from((gist || raw).trim());
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('').replace(/[，；、：,;:\s]+$/u, '') + '…';
}

/** Relative time for lists; the absolute value stays in the element title. */
export function memoryRelativeTime(value: unknown, now = Date.now()): string {
  const raw = text(value).trim();
  if (!raw) return '未记录';
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return raw;
  const diff = time - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  if (abs < 60_000) return future ? '即将' : '刚刚';
  const units: [number, string][] = [
    [31_536_000_000, '年'],
    [2_592_000_000, '个月'],
    [604_800_000, '周'],
    [86_400_000, '天'],
    [3_600_000, '小时'],
    [60_000, '分钟'],
  ];
  for (const [size, label] of units) {
    if (abs >= size) {
      const count = Math.floor(abs / size);
      return future ? `${count} ${label}后` : `${count} ${label}前`;
    }
  }
  return future ? '即将' : '刚刚';
}

/** Local calendar date (YYYY-MM-DD) for validity lines; invalid values stay raw. */
export function memoryDateText(value: unknown): string {
  const raw = text(value).trim();
  if (!raw) return '';
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return raw;
  const date = new Date(time);
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
