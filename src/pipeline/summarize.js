export function formatMs(ms) {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function buildTranscript(utterances) {
  
  // var sorted = [...utterances].sort((a, b) => a.startMs - b.startMs);
  // var mapped = [...sorted].map((u) => `[${formatMs(u.startMs)}] ${u.displayName}: ${u.text}`);
  // var joined = [...mapped].join('\n');

  // console.log("utterances:", utterances.length);
  // console.log("sorted:", sorted.length);
  // console.log("mapped:", mapped.length);
  // console.log("joined length:", joined.length);

  // console.log(joined.slice(0, 1000));
  // console.log("---- END PREVIEW ----");
  // console.log(joined.slice(-1000));

  // console.log("line count in joined:", joined.split("\n").length);

  // console.log("char count:", joined.length);
  // console.log("rough tokens:", Math.round(joined.length / 4));

  return [...utterances]
    .sort((a, b) => a.startMs - b.startMs)
    .map((u) => `[${formatMs(u.startMs)}] ${u.displayName}: ${u.text}`)
    // .slice(0, 50)
    .join('\n');
}

export function computeTalkTime(utterances) {
  const by = new Map();
  for (const u of utterances) {
    const cur = by.get(u.displayName) || { displayName: u.displayName, ms: 0, words: 0 };
    cur.ms += Math.max(0, u.endMs - u.startMs);
    cur.words += u.text.trim() ? u.text.trim().split(/\s+/).length : 0;
    by.set(u.displayName, cur);
  }
  const stats = [...by.values()];
  const totalMs = stats.reduce((s, x) => s + x.ms, 0) || 1;
  for (const s of stats) s.pct = Math.round((s.ms / totalMs) * 100);
  return stats.sort((a, b) => b.ms - a.ms);
}
