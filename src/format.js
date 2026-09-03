// Pure text/URL formatting utilities.
//
// Extracted from main.js (nd-carve-3-leaves step 2). No module-level mutable
// state — all functions are pure input→output.

// Minimal HTML escaper for chart-sourced strings (section names) that get
// interpolated into summary innerHTML.
export function _ndEscapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// Human label for an arrangement string (the "instrument / track" played).
// getSongInfo().arrangement is a free-form chart label ('Lead', 'Bass',
// 'rhythm', …) — title-case the leading word so it reads on the card.
export function _ndInstrumentLabel(arrangement) {
    if (!arrangement) return '';
    const s = String(arrangement).trim();
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// Same-origin album-art URL for a song filename. Mirrors the host's
// quote(filename, safe='/') so nested DLC paths (a/b.sloppak) resolve, and
// stays same-origin so the share canvas isn't tainted. '' when no filename.
// Returns 404 for art-less songs — callers must handle the load failure.
export function _ndSongArtUrl(filename) {
    if (!filename) return '';
    return '/api/song/' + String(filename).split('/').map(encodeURIComponent).join('/') + '/art';
}

// Clipboard text fallback (when image copy + download both fail).
export function _ndShareCardText(data) {
    const d = data || {};
    const what = d.title || 'My run';
    const inst = d.instrument ? ` (${d.instrument})` : '';
    const tail = [`${d.accuracy}%`, `${d.score} pts`];
    if (d.fullCombo) tail.push('Full Combo');
    return `fee[dB]ack — ${what}${inst}\n${tail.join(' · ')}`;
}

// Download filename — slugged from the song title.
export function _ndShareCardFilename(data) {
    const d = data || {};
    const base = String(d.title || 'score-card')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'score-card';
    return `feedback-${base}.png`;
}

// Auto-save filename: "Artist - Title - YYYY-MM-DD HHMM.png" so a folder of
// cards sorts by song and every take is kept (the server never overwrites an
// auto-saved card — it appends a counter on a clash). Artist is omitted when
// unknown. The server sanitises the name (spaces survive) and de-dupes.
export function _ndAutoSaveFilename(data) {
    const d = data || {};
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate())
        + ' ' + p2(now.getHours()) + p2(now.getMinutes());
    // Turn any path separators into hyphens up front so the server's basename
    // guard doesn't drop the part before a slash (e.g. artist "AC/DC").
    const clean = (s) => String(s == null ? '' : s).replace(/[\\/]/g, '-').trim();
    const title = clean(d.title) || 'Song';
    const artist = clean(d.artist);
    return (artist ? artist + ' - ' + title : title) + ' - ' + stamp + '.png';
}
