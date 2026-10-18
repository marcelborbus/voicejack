/** UTC calendar day `YYYY-MM-DD` of an epoch-ms timestamp. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
