// Pure drill conductor math helpers.
//
// Extracted from main.js (nd-carve-3-leaves step 2). No module-level mutable
// state — all functions are pure input→output. Consts are immutable data that
// move with the functions that reference them.

export const _ND_DRILL_LEAD_IN_SEC = 5.0;            // audible pre-roll before the judged window — enough runway to find the groove before the drilled notes (RS-style). A beat-locked click runs across the whole loop, lead-in included.
export const _ND_DRILL_FIRST_NOTE_RUNWAY_SEC = 1.0;  // min reaction time before the first scored note
export const _ND_DRILL_DEFAULT_GOAL = 0.85;          // iteration accuracy (0..1) needed to step up a rung
export const _ND_DRILL_DEFAULT_LADDER = [0.8, 0.9, 1.0];  // playback-speed rungs, slow → full (0.8 floor: slower time-stretches sound distorted)
export const _ND_DRILL_FULLSPEED_REPS = 3;           // consecutive full-speed clears required to graduate — the user often doesn't KNOW the hotspot until the drill, so reinforce it a few times at tempo before returning to the song instead of bailing on the first clean pass

// Pure goal-gate decision for one finished drill iteration. Given the
// iteration's accuracy `score` (0..1), the `goal` (0..1), the current
// ladder `rung`, and the ladder `length`, decide whether to hold at this
// speed, step up a rung, or graduate. No DOM/audio — unit-testable; the
// conductor's _drillConductorOnWrap applies the result.
//   - miss the goal                       → { action: 'hold',        nextRung: rung }
//   - clear it below full speed           → { action: 'advance',     nextRung: rung+1 }
//   - clear it at the top, more reps to go → { action: 'consolidate', nextRung: rung }
//   - clear it at the top for the Nth time → { action: 'graduate',    nextRung: rung }
// `topClears` = full-speed clears banked so far; `reps` = clears required to
// graduate (1 = old behaviour: graduate on the first full-speed clear).
export function _ndDrillRampDecision(score, goal, rung, ladderLength, topClears = 0, reps = 1) {
    const cleared = Number.isFinite(score) && Number.isFinite(goal) && score >= goal;
    if (!cleared) return { action: 'hold', nextRung: rung };
    const atTop = rung >= ladderLength - 1;
    if (atTop) {
        // Stay on the drill and reinforce at full speed before returning to the
        // song — graduate only once enough full-speed reps are banked.
        if (topClears + 1 >= Math.max(1, reps)) return { action: 'graduate', nextRung: rung };
        return { action: 'consolidate', nextRung: rung };
    }
    return { action: 'advance', nextRung: rung + 1 };
}

// Score one drill pass: fraction of the CHARTED notes in the judge window the
// player actually hit. Denominator is what the chart asks for, NOT just the
// notes the detector heard — otherwise a pass where you played little or
// nothing collapses to 0/0 and reads as "no attempt" (or a couple of stray
// hits read as 100%), which let an untouched loop climb the ladder. Returns
// null when nothing is charted (chart still loading / rest-only window) so the
// caller skips without scoring. Pure → node-testable.
export function _ndDrillPassScore(hits, charted) {
    if (!Number.isFinite(charted) || charted <= 0) return null;
    return Math.max(0, Number(hits) || 0) / charted;
}

// Auto-drill trigger. While learning a song there's no usable per-note feedback
// mid-play, and waiting for the post-play summary costs a whole run — so instead
// jump straight into a drill loop the moment the player fluffs a RUN of notes.
// Returns true when the contiguous-miss streak has reached the (configurable)
// threshold and a fresh drill may start. Pure → node-testable.
export function _ndAutoDrillShouldTrigger(missStreak, threshold, drilling, playing) {
    return threshold > 0 && !drilling && !!playing && missStreak >= threshold;
}

// The loop range for an auto-triggered drill: the chart-time span of the missed
// run, widened to a floor so the conductor's min-length + lead-in guards accept
// it (a tight cluster of fast notes can span < 0.5 s). Pure → node-testable.
export function _ndAutoDrillRange(firstMissT, lastMissT, minSpanSec = 1.5) {
    const start = Math.max(0, Number(firstMissT));
    const rawEnd = Number(lastMissT);
    const end = Math.max(Number.isFinite(rawEnd) ? rawEnd : start, start + minSpanSec);
    return { start, end };
}

// Describe HOW a missed note failed, from its judgment. Pure → testable.
// `how` is a short category (for colour-coding); `detail` is the human
// phrase shown per note in the drill HUD.
export function _ndDescribeMiss(j) {
    if (!j) return { how: 'missed', detail: 'no note' };
    // Open string rang in place of the charted fretted note — a real play
    // error (failed to fret/mute), distinct from "played nothing". Checked
    // before the detected-pitch branches: the fretted note itself wasn't
    // detected (detectedMidi is null), but the open string sounded.
    if (j.muteFail) return { how: 'mute', detail: 'open string rang — fret/mute fail' };
    const dm = j.detectedMidi;
    if (dm == null || !Number.isFinite(dm)) return { how: 'missed', detail: 'not played / not detected' };
    if (j.timingState === 'LATE') return { how: 'late', detail: Number.isFinite(j.timingError) ? `${Math.round(Math.abs(j.timingError))}ms late` : 'late' };
    if (j.timingState === 'EARLY') return { how: 'early', detail: Number.isFinite(j.timingError) ? `${Math.round(Math.abs(j.timingError))}ms early` : 'early' };
    if (j.pitchState === 'SHARP') return { how: 'sharp', detail: Number.isFinite(j.pitchError) ? `${Math.round(Math.abs(j.pitchError))}¢ sharp` : 'sharp' };
    if (j.pitchState === 'FLAT') return { how: 'flat', detail: Number.isFinite(j.pitchError) ? `${Math.round(Math.abs(j.pitchError))}¢ flat` : 'flat' };
    return { how: 'wrong', detail: 'wrong note' };
}

// Collect missed notes inside a drill's judge window from a flat list of
// judgments (noteResults values), tagged with where (string/fret) + how,
// sorted by chart time. Pure → testable; the conductor renders the result.
export function _ndSummarizeWindowMisses(judgments, startSec, endSec) {
    const out = [];
    for (const j of (judgments || [])) {
        if (!j || j.hit) continue;
        const t = Number.isFinite(j.noteTime) ? j.noteTime : null;
        if (t == null || t < startSec || t > endSec) continue;
        const note = j.note || j.chartNote || {};
        const d = _ndDescribeMiss(j);
        out.push({ s: note.s, f: note.f, t, how: d.how, detail: d.detail });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}
