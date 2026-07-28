// Subsequence fuzzy match; higher score = better, null = no match. Shared by
// the command palette (sessions + files) and the composer's slash/@ menus.
export function fuzzyScore(query, target) {
  let score = 0;
  let si = 0;
  let prevHit = -2;
  for (const ch of query) {
    const hit = target.indexOf(ch, si);
    if (hit === -1) return null;
    score += 1;
    if (hit === prevHit + 1) score += 2;
    if (hit === 0 || " /\\-_.:".includes(target[hit - 1])) score += 3;
    prevHit = hit;
    si = hit + 1;
  }
  return score - target.length / 100;
}
