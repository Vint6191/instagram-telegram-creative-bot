export type InlineButton = { text: string; callback_data: string };

export function keyboard(rows: InlineButton[][]): Record<string, unknown> {
  const filtered = rows.filter((row) => row.length > 0);
  for (const row of filtered) {
    for (const button of row) {
      const bytes = new TextEncoder().encode(button.callback_data).byteLength;
      if (bytes < 1 || bytes > 64) {
        throw new Error(`Telegram callback_data must be 1..64 bytes, got ${bytes}`);
      }
    }
  }
  return { inline_keyboard: filtered };
}

export function pagerRow(prefix: string, page: number, total: number, pageSize: number): InlineButton[] {
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const row: InlineButton[] = [];
  if (page > 0) row.push({ text: "←", callback_data: `${prefix}:${page - 1}` });
  if (maxPage > 0) row.push({ text: `${page + 1}/${maxPage + 1}`, callback_data: `${prefix}:${page}` });
  if (page < maxPage) row.push({ text: "→", callback_data: `${prefix}:${page + 1}` });
  return row;
}

export function clampPage(page: number, total: number, pageSize: number): number {
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  return Number.isFinite(page) ? Math.max(0, Math.min(maxPage, Math.floor(page))) : 0;
}

export function parsePage(value: string | undefined): number {
  const page = Number(value);
  return Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0;
}

export function formatAge(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} мин.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч. ${rest} мин.` : `${hours} ч.`;
}

export function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { value: String(error) };
}
