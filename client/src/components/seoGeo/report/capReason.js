/**
 * Why a page's score is capped, in words. The server lists each blocking issue
 * under `cap.groups[].reason` (several can fire at once); there is no
 * `cap.reason`, which is why capped pages read "blocking issue: undefined" and
 * the "Blocking the score" box was empty.
 */
export function capReason(cap) {
  if (!cap) return '';
  const reasons = (cap.groups || []).map((g) => g?.reason).filter(Boolean);
  if (reasons.length) return reasons.join(' ');
  if (Array.isArray(cap.reasons) && cap.reasons.length) return cap.reasons.join(' ');
  return cap.reason || 'a blocking issue on the page.';
}
