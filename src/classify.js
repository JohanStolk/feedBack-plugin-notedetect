// Pure timing/pitch classifiers and scoring helpers.
//
// Extracted from main.js (nd-carve-3-leaves step 2). No module-level mutable
// state — all functions are pure input→output.

// ── Timing / pitch classification ─────────────────────────────────────────

export function _ndClassifyTiming(timingErrorMs, timingThresholdMs, lateGraceMs) {
    if (!Number.isFinite(timingErrorMs)) return null;
    const grace = Number.isFinite(lateGraceMs) && lateGraceMs > 0 ? lateGraceMs : 0;
    // Asymmetric for sus-marked notes (caller passes grace > 0): the
    // EARLY side stays strict — playing before the note is always
    // wrong — but late detection within the sustain envelope is still
    // a hit, because the note is *audibly* the right one. Without this,
    // a player who plucks a few hundred ms after the chart time on a
    // half-note (which YIN may take ~100 ms to confidently lock) gets
    // a LATE miss even though they're hearing themselves play the
    // correct note over the strike-line ring.
    if (timingErrorMs < 0) {
        return Math.abs(timingErrorMs) <= timingThresholdMs ? 'OK' : 'EARLY';
    }
    return timingErrorMs <= timingThresholdMs + grace ? 'OK' : 'LATE';
}

export function _ndClassifyPitch(pitchErrorCents, pitchThresholdCents) {
    if (!Number.isFinite(pitchErrorCents)) return null;
    return Math.abs(pitchErrorCents) <= pitchThresholdCents
        ? 'OK'
        : (pitchErrorCents > 0 ? 'SHARP' : 'FLAT');
}

// ── Game-scoring layer: points / multiplier / grade ─────────────────────
// Pure helpers shared by the live HUD, the end-of-song summary, and the
// highway FX contract. Kept top-level (not in the factory closure) so the
// vm test loader can exercise them directly.

// Base point values per clean hit, before the streak multiplier.
export const ND_BASE_SINGLE = 50;
export const ND_BASE_CHORD  = 100;

// Streak-tier multiplier: ×1 → ×2 at 10, ×3 at 25, ×4 at 50.
export function _ndMultiplierForStreak(streak) {
    return streak >= 50 ? 4 : streak >= 25 ? 3 : streak >= 10 ? 2 : 1;
}

// Streak counts that warrant a celebration burst on the highway: the two
// upper tier boundaries, then every full hundred.
export function _ndIsStreakMilestone(streak) {
    return streak === 25 || streak === 50 || (streak >= 100 && streak % 100 === 0);
}

// Letter grade from accuracy percentage (0–100). Full combo is a separate
// badge (misses === 0), not a grade change.
export function _ndGradeFor(accuracy) {
    return accuracy >= 96 ? 'S'
        : accuracy >= 90 ? 'A'
        : accuracy >= 80 ? 'B'
        : accuracy >= 70 ? 'C'
        : accuracy >= 60 ? 'D'
        : 'F';
}

// "Beat your best" delta for the results card — compares this run's accuracy to
// the stored personal best for the same song+arrangement. Pure; localStorage
// I/O lives in _ndReadSongBest/_ndWriteSongBest. `prev` is null/undefined on a
// first clear (caller renders nothing then — you can't beat a best you don't
// have yet). Guilt guard: it only reports the positive/neutral facts (a gain,
// a tie, or your standing best); the caller never renders a red "−N%".
export function _ndComputeBestDelta(prev, cur) {
    const a = Math.round(Number(cur && cur.accuracy) || 0);
    if (!prev) return { first: true, newBest: true, accDelta: 0, bestAcc: a };
    const pa = Math.round(Number(prev.accuracy) || 0);
    return { first: false, newBest: a > pa, accDelta: a - pa, bestAcc: Math.max(a, pa) };
}

// ── Hero CTA selection ────────────────────────────────────────────────────

// Contextual hero CTA — which action gets the emphasised (primary) slot on the
// results card, chosen from the SHAPE of the result so the nudge points at the
// highest-value next step instead of always "retry the whole song". Deliberate-
// practice principle: when the failure is LOCALIZED to one section, drilling it
// beats grinding bars you already own. Pure + tunable; the caller resolves the
// section's loop range and renders. Everything stays a suggestion — nothing is
// gated, and Retry remains available even when it isn't the hero.
//   ctx: { accuracy, canRetry, sections: [{ name, acc|null }] }  (acc null = no
//   notes in that section — skipped). Returns { kind, sectionName?, reason }.
//     'practice-section' — one section is the clear weak outlier; drill it.
//     'retry'            — broadly rough / no clear outlier; replay the whole.
const _ND_HERO_SOLID_ACC = 80;     // overall must be at least this to localize
const _ND_HERO_SECTION_PASS = 90;  // ...and the outlier still below a clean pass
const _ND_HERO_SECTION_GAP = 15;   // ...and this many points under the overall
export function _ndPickHeroAction(ctx) {
    const acc = Math.round(Number(ctx && ctx.accuracy) || 0);
    const canRetry = !!(ctx && ctx.canRetry);
    const sections = (ctx && Array.isArray(ctx.sections)) ? ctx.sections : [];
    const fallback = {
        kind: 'retry',
        // Only nudge "run it back" when a retry is actually offered — otherwise
        // the reason line would tell the user to replay with no Retry button.
        reason: (canRetry && acc < 60) ? 'Run it back — try it a touch slower.' : '',
    };
    if (!canRetry || !sections.length) return fallback;
    let weakest = null;
    for (const s of sections) {
        if (!s || s.acc == null) continue;          // skip sections with no notes
        const a = Math.round(Number(s.acc) || 0);
        if (!weakest || a < weakest.acc) weakest = { name: s.name, acc: a };
    }
    if (weakest
        && acc >= _ND_HERO_SOLID_ACC
        && weakest.acc < _ND_HERO_SECTION_PASS
        && (acc - weakest.acc) >= _ND_HERO_SECTION_GAP) {
        return {
            kind: 'practice-section',
            sectionName: weakest.name,
            reason: `Your accuracy's strong — ${weakest.name} is the last rough patch.`,
        };
    }
    return fallback;
}

// ── Clean/loose hit grading ────────────────────────────────────────────────

// Classify a hit as "clean" (well within the tight coach window) or "loose"
// (hit window but outside the stricter clean band). The clean thresholds are
// always <= the hit thresholds (clamped on load), so the clean band lives
// strictly inside the hit window. `looseReason` names the offending axis so
// the coach can label the drill (tight timing vs intonation).
export function _ndGradeClean(hit, timingError, pitchError, cleanTimingMs, cleanPitchCents) {
    if (!hit) return { clean: false, looseReason: null };
    const tLoose = Number.isFinite(timingError) && Number.isFinite(cleanTimingMs)
        && Math.abs(timingError) > cleanTimingMs;
    const pLoose = Number.isFinite(pitchError) && Number.isFinite(cleanPitchCents)
        && Math.abs(pitchError) > cleanPitchCents;
    if (!tLoose && !pLoose) return { clean: true, looseReason: null };
    return { clean: false, looseReason: (tLoose && pLoose) ? 'both' : (tLoose ? 'timing' : 'pitch') };
}
