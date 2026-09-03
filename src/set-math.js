// End-of-set score log helpers.
//
// Extracted from main.js (nd-carve-4-statelift step 3). No module-level
// mutable state — both functions are pure input→output. _ndSetLog (the
// actual mutable array) stays in main.js with the factory code that owns it.

// Pure append-or-restart: a fresh set (first entry, a different queue
// length, or a position that doesn't advance the log) RESTARTS the log —
// that's how a new "Play All" run is detected without a queue session id.
// Positions may skip forward (a queued song with too few scored notes
// never cards, so it never logs); they just have to advance.
export function _ndSetLogAppend(log, entry) {
    if (!entry || !Number.isFinite(entry.pos)) return log;
    const last = log.length ? log[log.length - 1] : null;
    if (!last || entry.total !== last.total || entry.pos <= last.pos) return [entry];
    // A replay of the just-logged song re-fires the natural-end log — Retry /
    // Practice on the FINAL queued card infers pos = prev.pos + 1 (no peekNext
    // to anchor it), which would otherwise append a phantom entry and inflate
    // the set. Same file as the last logged song within a set → never re-count.
    // (Checked only in the append branch, so a genuine new run whose first song
    // equals the previous set's last song still restarts above.)
    if (entry.filename && entry.filename === last.filename) return log;
    return log.concat([entry]);
}

export function _ndSetLogAverage(log) {
    if (!log || !log.length) return 0;
    return Math.round(log.reduce((s, e) => s + (e.accuracy || 0), 0) / log.length);
}
