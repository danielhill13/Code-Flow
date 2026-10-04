// How often something repeats, as config writes it: a number and a unit (m, h, d), or "off".

/** "6h" → 21,600,000 ms; "off" → Infinity; anything else → NaN. */
export function everyMs(text: string): number {
  if (text === "off") return Number.POSITIVE_INFINITY;
  const match = /^(\d+)([mhd])$/.exec(text);
  if (!match) return Number.NaN;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
  return Number(match[1]) * unit;
}
