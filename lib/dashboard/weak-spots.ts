export type Pips = { segments: number; filled: number };

// Segment pips for a weak-spot row: one pip per occurrence, at least three
// segments so a single occurrence still shows as "one of a few", capped at
// five so a chronic topic does not stretch the panel.
export function weakSpotPips(occurrences: number): Pips {
  const filled = Math.max(0, Math.min(occurrences, 5));
  return { segments: Math.max(filled, 3), filled };
}

export function isRecurring(occurrences: number): boolean {
  return occurrences >= 3;
}
