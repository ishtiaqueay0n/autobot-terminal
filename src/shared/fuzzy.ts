/**
 * Optimal string alignment distance (Levenshtein plus adjacent swaps, so "gti" -> "git" is 1).
 * Stops early and returns `max + 1` once the distance is known to exceed `max`.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur.push(d);
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[cols - 1];
}

/** How many typos a word of this length may contain and still count as "probably meant X". */
export function allowedTypos(word: string): number {
  return word.length <= 2 ? 0 : word.length <= 4 ? 1 : 2;
}

/**
 * The candidate closest to `word` within the allowed typo budget, or null. Ties go to the higher `rank`
 * (e.g. how often you use it), then to the candidate sharing the first letter, then to the shorter one.
 */
export function closest(
  word: string,
  candidates: Iterable<string>,
  opts: { fold?: boolean; rank?: (candidate: string) => number } = {},
): string | null {
  const w = opts.fold ? word.toLowerCase() : word;
  const max = allowedTypos(w);
  if (max === 0) return null;
  let best: string | null = null;
  let bestKey: [number, number, number, number] | null = null;
  for (const c of candidates) {
    const cc = opts.fold ? c.toLowerCase() : c;
    if (cc === w) return null; // the word is valid
    const d = editDistance(w, cc, max);
    if (d > max) continue;
    const key: [number, number, number, number] = [d, -(opts.rank?.(c) ?? 0), cc[0] === w[0] ? 0 : 1, c.length];
    if (!bestKey || compare(key, bestKey) < 0) {
      best = c;
      bestKey = key;
    }
  }
  return best;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
