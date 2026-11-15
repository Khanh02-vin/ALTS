// Export dialog default name. Titles are user-facing text and often Vietnamese,
// so keep accented letters: \p{L}/\p{N} instead of ASCII \w, which turned
// "Cảnh đẹp" into "C_nh_đ_p" (and a doubled backslash into `_w_`).
export function exportFileName(title: string, fallback: string): string {
  const safe = title.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");
  return `${safe || fallback}.mp4`;
}
