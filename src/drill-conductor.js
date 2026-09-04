// nd-carve-5 cut 3 — drill-conductor subsystem extracted from createNoteDetector factory.
//
// Non-verbatim deltas vs main.js:
//   1. resolveHw()         → getHw()      (DI law: live accessor, never captured at construction)
//   2. audioCtx            → getAudioCtx() (lazily-initialised; only in _drillScheduleDueClicks)
//   3. _ndChartNotes(x)    → getChartNotes(x)  (DI — stays in main.js alongside hw helpers)
//   4. _ndChartChords(x)   → getChartChords(x) (same)
//   5. _drillClearWindow(  → clearWindow(  (DI — stays in main.js; accesses noteResults/sus maps)
//   6. _drillClearWindow function definition removed (stays in main.js)
//   7. _ndPerfNow, _ndMmSs, _CLICK_LOOKAHEAD_S, DRILL_MAX_ITERATIONS — hoisted into
//      the factory closure (were factory-level consts in main.js)
//   8. Auto-drill + iter block from recordJudgment → onJudgment() method
//   9. Auto-drill resets from resetScoring() → resetForSong() method
//  10. _autoDrillMisses write from settings handler → setAutoDrillMisses(n) method
//  11. getConductorState / getDrillStats inline lambdas in public API → module methods
//  12. _ndAutoDrillMissesSetting() call → getAutoDrillMissesSetting() DI accessor
//  13. getChartOnsets(hw)   → getChartOnsets(hw)  (DI — stays in main.js)
//  14. enabled / enable()   → getEnabled() / enable() DI accessors (used in startDrill cold-start)
//  15. noteResults           → getNoteResults()   (DI — iteration-score Map in main.js closure)

import {
    _ND_DRILL_LEAD_IN_SEC, _ND_DRILL_FIRST_NOTE_RUNWAY_SEC,
    _ND_DRILL_DEFAULT_GOAL, _ND_DRILL_DEFAULT_LADDER, _ND_DRILL_FULLSPEED_REPS,
    _ndDrillRampDecision, _ndDrillPassScore, _ndAutoDrillShouldTrigger,
    _ndAutoDrillRange, _ndDescribeMiss, _ndSummarizeWindowMisses,
} from './drill-math.js';
import { _ndEscapeHtml } from './format.js';

export function createDrillConductor({
    getHw,                      // () => resolveHw() — live accessor (DI law)
    getAudioCtx,                // () => audioCtx — lazily initialised
    instanceRoot,               // Element — for _drillRender DOM queries
    clearWindow,                // (a, b) — _drillClearWindow stays in main.js
    getChartNotes,              // (hw?) => array — wraps _ndChartNotes in main.js
    getChartChords,             // (hw?) => array — wraps _ndChartChords in main.js
    getAutoDrillMissesSetting,  // () => _ndAutoDrillMissesSetting()
    getChartOnsets,             // (hw?) => getChartOnsets(hw) — note onset times in the active chart
    getEnabled,                 // () => enabled — live detection-on flag
    enable,                     // async () => void — turn detection on (for cold-start count-in)
    getNoteResults,             // () => noteResults Map — current frame's judgment ledger
}) {
    // ── Drill iteration state ─────────────────────────────────────────────
    let drillEnabled = false;       // mirrors slopsmith.getLoop() having both bounds
    let drillIterations = [];       // captured snapshots, oldest first
    let drillIterStartT = null;     // chartTime at the current iteration's start (loopA)
    let drillIterHits = 0;
    let drillIterMisses = 0;
    let drillIterStreak = 0;
    let drillIterBestStreak = 0;
    let drillSubscribed = false;    // gate the slopsmith.on / .off pair
    let drillOnLoopRestartFn = null;
    let drillOnSongChangedFn = null;
    let drillOnLoopChangedFn = null;
    let drillActiveLoopA = null;
    let drillActiveLoopB = null;
    let drillNextIdx = 1;
    const DRILL_MAX_ITERATIONS = 50;
    let drillDirty = true;

    // ── Drill conductor state (speed/goal orchestrator) ───────────────────
    let drillConductorActive = false;
    let drillConductorLadder = null;
    let drillConductorRung = 0;
    let drillConductorGoal = _ND_DRILL_DEFAULT_GOAL;
    let drillConductorBest = 0;
    let drillConductorFailStreak = 0;
    let drillConductorTopClears = 0;
    let drillConductorFocus = null;
    let drillConductorLabel = null;
    let drillConductorSavedSpeed = null;
    let drillConductorRange = null;
    let drillConductorExpandsLeft = 0;
    let drillConductorOnWrapFn = null;
    let _drillHudRemoveTimer = null;
    let _ndDrillLastChartT = 0;
    let _ndDrillLastScoredPerf = 0;

    // ── Beat-locked metronome ─────────────────────────────────────────────
    let _drillBeatTimes = [];
    let _drillBeatIdx = 0;
    const _CLICK_LOOKAHEAD_S = 0.12;

    // ── Auto-drill ────────────────────────────────────────────────────────
    let _autoDrillMisses = getAutoDrillMissesSetting();
    let _autoDrillMissStreak = 0;
    let _autoDrillFirstMissT = NaN;
    let _autoDrillLastMissT = NaN;
    let _autoDrillCooldownUntil = 0;

    // ── Local consts (moved from factory closure) ─────────────────────────
    // ponytail: defined here, not DI'd — tiny lambdas only used inside drill functions
    const _ndPerfNow = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const _ndMmSs = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

    function _drillCurrentLoop() {
        const fallback = { loopA: null, loopB: null };
        if (!window.slopsmith || typeof window.slopsmith.getLoop !== 'function') {
            return fallback;
        }
        // Guard the host call — a misbehaving slopsmith bus shouldn't
        // take down updateHUD / recordJudgment scoring with it.
        let result;
        try {
            result = window.slopsmith.getLoop();
        } catch (e) {
            return fallback;
        }
        // Require an actual object so destructuring `{ loopA, loopB }`
        // gets meaningful values. A truthy non-object (e.g. `true`,
        // `''`, `42`) would destructure to undefined and let
        // _drillSyncFromLoopState read a malformed shape — better to
        // return the inactive fallback so drill stays off.
        if (!result || typeof result !== 'object') return fallback;
        return result;
    }

    // ── Drill conductor (ported from slopsmith 1.39.1) ────────────────
    function _hostGetSpeed() {
        // The speed slider is the host's source of truth for current
        // speed (setSpeed writes it); fall back to the audio element.
        try {
            const slider = document.getElementById('speed-slider');
            if (slider && Number.isFinite(Number(slider.value))) return Number(slider.value) / 100;
        } catch (_) {}
        const audio = document.getElementById('audio');
        return (audio && Number.isFinite(audio.playbackRate)) ? audio.playbackRate : 1;
    }

    function _hostSetSpeed(mul) {
        if (!Number.isFinite(mul) || mul <= 0) return false;
        if (typeof window.setSpeed === 'function') { window.setSpeed(mul); return true; }
        const audio = document.getElementById('audio');
        if (audio) { audio.playbackRate = mul; return true; }
        return false;
    }

    // Called from recordJudgment() on every conceded miss. When the contiguous-
    // miss streak reaches the configured threshold, drop the player straight into
    // a drill loop on the run they just fluffed — no need to finish the song and
    // read the post-play summary. Fires the drill OFF the scoring hot path (this
    // runs inside checkMisses/matchNotes) via a microtask, and cools down so one
    // bad run doesn't immediately re-trigger.
    function _maybeAutoDrill() {
        const playing = !!(window.slopsmith && window.slopsmith.isPlaying);
        if (!_ndAutoDrillShouldTrigger(_autoDrillMissStreak, _autoDrillMisses, drillConductorActive, playing)) return;
        if (_ndPerfNow() < _autoDrillCooldownUntil) return;
        const first = _autoDrillFirstMissT;
        const last = _autoDrillLastMissT;
        const n = _autoDrillMissStreak;
        _autoDrillMissStreak = 0;                       // consume the run
        _autoDrillCooldownUntil = _ndPerfNow() + 4000;  // ~4 s guard against re-fire
        Promise.resolve().then(() => {
            try {
                if (Number.isFinite(first) && Number.isFinite(last)) {
                    const { start, end } = _ndAutoDrillRange(first, last);
                    startDrill(start, end, { expandContext: true, label: 'Missed run', focus: `${n} missed in a row` });
                } else {
                    startDrillHere(null, { expandContext: true, label: 'Missed run' });
                }
            } catch (_) { /* a failed auto-drill is a no-op; play continues */ }
        });
    }

    async function startDrill(startSec, endSec, opts = {}) {
        const {
            label = null,
            focus = null,
            goal = _ND_DRILL_DEFAULT_GOAL,
            speedLadder = _ND_DRILL_DEFAULT_LADDER,
            expandContext = false,          // widen the loop each side once nailed
            maxExpansions = 2,              // how many bar-each-side widenings
        } = opts || {};

        const _hw = getHw();
        const songInfo = (_hw && _hw.getSongInfo && _hw.getSongInfo()) || {};
        const audio = document.getElementById('audio');
        const totalDuration = Number.isFinite(songInfo.duration)
            ? songInfo.duration
            : (audio && Number.isFinite(audio.duration) ? audio.duration : null);
        if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
            console.warn('[note_detect] startDrill: no song duration available — aborting');
            return false;
        }

        const requestedStart = Math.max(0, Number(startSec));
        const judgeEnd = Math.min(totalDuration - 0.05, Number(endSec));
        if (!Number.isFinite(requestedStart) || !Number.isFinite(judgeEnd)
                || judgeEnd - requestedStart < 0.5) {
            console.warn(`[note_detect] startDrill: range too short/invalid (${requestedStart}–${judgeEnd}) — aborting`);
            return false;
        }

        // Validate the ladder; fall back to the default on junk input.
        // Sort ascending so rung 0 is always the slowest.
        const ladder = (Array.isArray(speedLadder) && speedLadder.length
            && speedLadder.every(v => Number.isFinite(v) && v > 0))
            ? speedLadder.slice().sort((a, b) => a - b)
            : _ND_DRILL_DEFAULT_LADDER.slice();

        // First-note runway: pull judgeStart back so the first scored
        // note always has reaction time, even when the cluster boundary
        // lands right on it.
        const firstOnset = getChartOnsets(_hw)
            .find(t => t >= requestedStart && t <= judgeEnd);
        const judgeStart = Number.isFinite(firstOnset)
            ? Math.max(0, Math.min(requestedStart, firstOnset - _ND_DRILL_FIRST_NOTE_RUNWAY_SEC))
            : requestedStart;
        const loopStart = Math.max(0, judgeStart - _ND_DRILL_LEAD_IN_SEC);
        const loopEnd = judgeEnd;

        // Commit conductor state before any await so a loop:restart that
        // races in mid-setup sees an active drill.
        drillConductorSavedSpeed = _hostGetSpeed();
        drillConductorActive = true;
        // Starting a drill consumes the contiguous-miss run — the misses inside
        // the drill loop must not accumulate toward another auto-drill trigger.
        _autoDrillMissStreak = 0;
        _autoDrillFirstMissT = NaN;
        _autoDrillLastMissT = NaN;
        drillConductorLadder = ladder;
        drillConductorRung = 0;
        drillConductorGoal = Number.isFinite(goal) ? Math.max(0, Math.min(1, goal)) : _ND_DRILL_DEFAULT_GOAL;
        drillConductorBest = 0;
        drillConductorFailStreak = 0;
        drillConductorTopClears = 0;
        drillConductorFocus = focus;
        drillConductorLabel = label || `${judgeStart.toFixed(1)}–${judgeEnd.toFixed(1)}s`;
        drillConductorRange = { loopStart, loopEnd, judgeStart, judgeEnd };
        drillConductorExpandsLeft = expandContext ? Math.max(0, maxExpansions) : 0;
        // Wipe any judgments already sitting in this window from the initial
        // playthrough — otherwise the first wrap re-scores those stale hits and
        // the loop "graduates" without the player touching it.
        clearWindow(judgeStart, judgeEnd);
        _ndDrillLastChartT = 0;          // reset wrap detector for this drill
        _ndDrillLastScoredPerf = 0;
        // Window-level flag the host's loop-wrap handler reads to skip its
        // count-in during drill iterations (we own the lead-in).
        window._ndAnyDrillActive = true;

        // NB: do NOT force preservesPitch — real-time time-stretch is CPU-heavy
        // and was implicated in laggy/buffering playback. Let the host's
        // setSpeed decide; if no time-stretch, slowing just lowers pitch
        // (cheap), which is fine for a drill.
        _hostSetSpeed(ladder[0]);

        // Arm the loop (seeks to loopStart but does NOT auto-play), then
        // start playback so the lead-in is actually audible.
        let looped = false;
        try {
            if (window.slopsmith && typeof window.slopsmith.setLoop === 'function') {
                looped = await window.slopsmith.setLoop(loopStart, loopEnd, { reason: 'note_detect-drill' });
            }
        } catch (e) {
            console.warn('[note_detect] startDrill: setLoop threw:', e);
        }
        if (!looped) {
            console.warn('[note_detect] startDrill: setLoop unavailable/failed — aborting');
            endDrill('setloop-failed');
            return false;
        }
        if (audio) {
            try { await audio.play(); } catch (_) { /* autoplay may reject; the loop still runs once playing */ }
        }

        // Drill is pointless without detection running — and the count-in
        // click is scheduled on the detection AudioContext, so enable BEFORE
        // playing it. On a cold start (detection off, e.g. right after the
        // song-end auto-disable) the context doesn't exist yet, so a count-in
        // here would be silently dropped — the "lead not there" bug.
        if (!getEnabled()) { try { await enable(); } catch (_) {} }

        // Compute the loop's beat grid; the HUD tick fires a click on each beat
        // the playhead crosses (lead-in included). Playhead-driven so a pause
        // silences it and there's no stutter from re-scheduling.
        _drillInitBeats();

        // Bind our OWN loop:restart listener so each pass is scored even if
        // the foundation's drillEnabled sync doesn't flip for a plugin loop.
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            // Re-entrant start (e.g. the HUD loop-nudge re-arms an active drill
            // via _drillAdjustLoop → startDrill, without going through endDrill):
            // drop the prior loop:restart registration first so exactly one stays
            // bound. On a bus that doesn't dedupe (event, fn) pairs, skipping this
            // stacks handlers and each wrap double-scores the (already-cleared)
            // window → bogus fail-streak/slowdown.
            if (drillConductorOnWrapFn && typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('loop:restart', drillConductorOnWrapFn); } catch (_) {}
            }
            drillConductorOnWrapFn = _drillConductorOnWrap;
            try { window.slopsmith.on('loop:restart', drillConductorOnWrapFn); } catch (_) {}
        }

        _drillConductorShowHud();
        console.log(`[note_detect] Drill "${drillConductorLabel}" loop=${loopStart.toFixed(1)}–${loopEnd.toFixed(1)}s judge=${judgeStart.toFixed(1)}–${judgeEnd.toFixed(1)}s ladder=${ladder.map(r => Math.round(r * 100) + '%').join('→')} goal=${Math.round(drillConductorGoal * 100)}%`);
        return true;
    }

    // Center-anchored drill entry: "point at the hard part, drill around it".
    // Takes the current playhead (or an explicit center time), picks the bar
    // under it as a tight starting window (snapped to chart downbeats, falling
    // back to ±1.5 s with no grid), and hands it to the conductor with
    // context-expansion ON so the region grows outward each side as it's
    // earned. This is the entry the hotspot/saved-loop paths lacked — you no
    // longer need a pre-existing range or a detected weakness to start a drill.
    function startDrillHere(centerSec = null, opts = {}) {
        const _hw = getHw();
        const audio = document.getElementById('audio');
        // Playhead: the <audio> element is ground truth on the web path; fall
        // back to the chart clock (JUCE mode parks <audio>), then an explicit
        // arg. (Reading the chart clock first was the "jumped to 0" bug — it
        // reads 0 when paused/not-yet-anchored.)
        let center = Number(centerSec);
        if (!Number.isFinite(center)) {
            const at = (audio && Number.isFinite(audio.currentTime)) ? audio.currentTime : NaN;
            const chartT = (_hw && typeof _hw.getTime === 'function') ? _hw.getTime() : NaN;
            center = Number.isFinite(at) ? at : chartT;
        }
        if (!Number.isFinite(center) || center < 0) {
            console.warn('[note_detect] startDrillHere: no playhead time — aborting');
            return Promise.resolve(false);
        }

        // A drill window with no notes can never clear the goal, so it loops
        // forever — the "stuck 2s loop at the intro" bug. Require notes.
        const noteTimes = getChartOnsets(_hw);
        if (!noteTimes.length) {
            console.warn('[note_detect] startDrillHere: chart has nothing to play — aborting');
            return Promise.resolve(false);
        }

        const beats = (_hw && _hw.getBeats) ? _hw.getBeats() : null;
        const downbeats = (Array.isArray(beats) ? beats : [])
            .filter(b => b && b.measure >= 0 && Number.isFinite(b.time))
            .map(b => b.time).sort((x, y) => x - y);
        const prevDb = (t) => { let r = null; for (const x of downbeats) { if (x <= t + 0.02) r = x; else break; } return r; };
        const nextDb = (t) => { for (const x of downbeats) if (x > t + 0.02) return x; return null; };
        const barAround = (t) => {
            let lo = prevDb(t), hi = nextDb(t);
            if (lo === null || hi === null) { lo = Math.max(0, t - 1.5); hi = t + 1.5; }
            if (hi - lo < 0.5) hi = lo + 0.5;   // startDrill needs a sane minimum span
            return [lo, hi];
        };

        // Tight initial window = the bar under the playhead — but only if it
        // actually holds notes. Over an empty stretch (intro/rest), anchor on
        // the nearest note so the drill lands on something playable.
        let [a, b] = barAround(center);
        const hasNote = (lo, hi) => noteTimes.some(t => t >= lo && t <= hi);
        if (!hasNote(a, b)) {
            let anchor = noteTimes[0], best = Math.abs(anchor - center);
            for (const t of noteTimes) { const d = Math.abs(t - center); if (d < best) { best = d; anchor = t; } }
            [a, b] = barAround(anchor);
        }

        const {
            goal = _ND_DRILL_DEFAULT_GOAL,
            speedLadder = _ND_DRILL_DEFAULT_LADDER,
            expandContext = true,
            maxExpansions = 3,
            label = `Drill @ ${_ndMmSs((a + b) / 2)}`,
        } = opts || {};
        return startDrill(a, b, { goal, speedLadder, expandContext, maxExpansions, label });
    }

    // Goal-gate one finished iteration. `snap` is the foundation's
    // snapshot {idx, hits, misses, accuracy, ...}; accuracy is 0..100.
    // One finished loop pass. Scores DIRECTLY from this pass's judgments in
    // the drill window — self-contained, not gated behind the foundation's
    // drillEnabled/getLoop sync (which wasn't reliably flipping for a
    // plugin-set loop, so the HUD never refreshed). noteResults is keyed by
    // chart note (time_s_f), so each pass overwrites the prior verdict — at
    // wrap time the window holds exactly this pass's results.

    // A drill is just a chunk the MAIN looper owns: re-derive the drill's
    // range from the live host loop each pass so editing the loop bounds
    // (A/B buttons, the player's numeric loop inputs, a saved loop) live-
    // resizes what gets drilled — scoring window, lead-in run-in, and the
    // beat-click grid all follow. Returns true when the bounds changed.
    // judgeStart is re-derived as loopStart + the lead-in (the run-in before
    // scoring begins); the conductor never re-arms setLoop itself, so an
    // external edit is authoritative.
    function _drillSyncRangeFromLoop() {
        if (!drillConductorActive || !drillConductorRange) return false;
        const lp = _drillCurrentLoop();
        if (!lp || !Number.isFinite(lp.loopA) || !Number.isFinite(lp.loopB)
                || lp.loopB - lp.loopA < 0.5) return false;
        const r = drillConductorRange;
        // Ignore sub-frame jitter; only react to a real edit.
        if (Math.abs(lp.loopA - r.loopStart) < 0.02 && Math.abs(lp.loopB - r.loopEnd) < 0.02) return false;
        const loopStart = Math.max(0, lp.loopA);
        const loopEnd = lp.loopB;
        const judgeStart = Math.min(loopEnd - 0.25, loopStart + _ND_DRILL_LEAD_IN_SEC);
        drillConductorRange = { loopStart, loopEnd, judgeStart, judgeEnd: loopEnd };
        drillConductorLabel = `${judgeStart.toFixed(1)}–${loopEnd.toFixed(1)}s`;
        _drillInitBeats();   // beat-click grid follows the resized loop
        return true;
    }

    // Widen the drilled loop by ~one bar each side (snapped to chart downbeats,
    // falling back to ±2 s with no beat grid), re-arm it, and back off a rung so
    // the wider passage is re-earned. Returns false when there's no room to grow.
    function _drillExpandLoop() {
        if (!drillConductorRange) return false;
        const _hw = getHw();
        const songInfo = (_hw && _hw.getSongInfo && _hw.getSongInfo()) || {};
        const audioEl = document.getElementById('audio');
        const dur = Number.isFinite(songInfo.duration) ? songInfo.duration
            : (audioEl && Number.isFinite(audioEl.duration) ? audioEl.duration : null);
        const cur = drillConductorRange;
        const beats = (_hw && _hw.getBeats) ? _hw.getBeats() : null;
        const downbeats = (Array.isArray(beats) ? beats : [])
            .filter(b => b && b.measure >= 0 && Number.isFinite(b.time))
            .map(b => b.time).sort((a, b) => a - b);
        const prevDb = (t) => { let r = null; for (const x of downbeats) { if (x < t - 0.05) r = x; else break; } return r; };
        const nextDb = (t) => { for (const x of downbeats) if (x > t + 0.05) return x; return null; };
        let newStart = prevDb(cur.loopStart);
        let newEnd = nextDb(cur.loopEnd);
        if (newStart === null) newStart = Math.max(0, cur.loopStart - 2);
        if (newEnd === null) newEnd = Number.isFinite(dur) ? Math.min(dur - 0.05, cur.loopEnd + 2) : cur.loopEnd + 2;
        newStart = Math.min(newStart, cur.loopStart);
        newEnd = Math.max(newEnd, cur.loopEnd);
        // No actual room to grow on either side → let the drill finish.
        if (newStart >= cur.loopStart - 0.05 && newEnd <= cur.loopEnd + 0.05) return false;

        const judgeStart = Math.min(newEnd - 0.25, newStart + _ND_DRILL_LEAD_IN_SEC);
        drillConductorRange = { loopStart: newStart, loopEnd: newEnd, judgeStart, judgeEnd: newEnd };
        drillConductorLabel = `${judgeStart.toFixed(1)}–${newEnd.toFixed(1)}s +context`;
        // Re-earn the wider passage: back off a rung, clear streak/consolidation.
        if (Array.isArray(drillConductorLadder) && drillConductorLadder.length) {
            drillConductorRung = Math.max(0, drillConductorRung - 1);
            _hostSetSpeed(drillConductorLadder[drillConductorRung] || 1);
        }
        drillConductorBest = 0;
        drillConductorFailStreak = 0;
        drillConductorTopClears = 0;
        try {
            if (window.slopsmith && typeof window.slopsmith.setLoop === 'function') {
                window.slopsmith.setLoop(newStart, newEnd, { reason: 'note_detect-drill-expand' });
            }
        } catch (e) { console.warn('[note_detect] drill expand setLoop threw:', e); }
        _drillInitBeats();
        _drillConductorUpdateHud({ expanded: true });
        clearWindow(judgeStart, newEnd);
        return true;
    }

    // How many CHART notes (singles + chords) fall in [a, b] — the true
    // denominator for a drill pass. Same source startDrill uses for the runway.
    function _drillChartedCount(a, b) {
        const _hw = getHw();
        if (!_hw) return 0;
        const inWin = (item) => {
            const t = Number.isFinite(item && item.t) ? item.t
                : (item && Number.isFinite(item.time) ? item.time : null);
            return t != null && t >= a && t <= b;
        };
        let n = 0;
        const notes = getChartNotes(_hw);
        for (const x of notes) if (inWin(x)) n++;
        const chords = getChartChords(_hw);
        for (const x of chords) if (inWin(x)) n++;
        return n;
    }

    // _drillClearWindow stays in main.js (accesses noteResults/sus/chord maps);
    // passed as clearWindow(a, b) DI param. (nd-carve-5 cut 3)

    function _drillConductorOnWrap() {
        if (!drillConductorActive || !drillConductorRange) return;
        // Follow any live edit to the loop bounds before scoring this pass, so
        // the drill stays in lock-step with what the player sees/hears.
        _drillSyncRangeFromLoop();
        _ndDrillLastScoredPerf = _ndPerfNow();  // stamp so the chart-tick detector won't double-fire
        const { judgeStart, judgeEnd } = drillConductorRange;
        const arr = [];
        for (const v of getNoteResults().values()) arr.push(v);
        // Denominator = the notes the CHART asks for in the judge window, NOT
        // just the ones the detector happened to hear. Grading against "heard"
        // notes let a pass where you played little or nothing collapse to 0/0
        // (skipped, so it never failed) or read a couple of stray hits as 100%
        // — so an empty loop climbed the ladder and "graduated". Grade against
        // the chart: no play, no pass. (Pairs with the bass miss-rescue, which
        // pulls most low notes out of the blind spot so they're hittable.)
        const charted = _drillChartedCount(judgeStart, judgeEnd);
        // Count hits at the SAME granularity as the denominator: each note and
        // each chord is worth 1. For a chord, noteResults holds BOTH the
        // chord-level verdict (key `<t>_chord`, chord:true) AND one entry per
        // constituent string (no chord flag, same noteTime) — so iterating every
        // value would credit a hit chord as 1 verdict + N strings while
        // _drillChartedCount counts the chord once, inflating the score past
        // 100%. Count the verdict, skip the per-string members (non-`_chord`
        // entries sharing a chord's time). `arr` above stays intact for the miss
        // summary, which wants the per-string detail.
        const chordTimeKeys = new Set();
        for (const key of getNoteResults().keys()) {
            const s = String(key);
            if (s.endsWith('_chord')) chordTimeKeys.add(s.slice(0, -6));
        }
        let hits = 0;
        for (const [key, j] of getNoteResults()) {
            const t = Number.isFinite(j && j.noteTime) ? j.noteTime : null;
            if (t == null || t < judgeStart || t > judgeEnd) continue;
            if (!String(key).endsWith('_chord') && chordTimeKeys.has(t.toFixed(3))) continue;
            if (j.hit) hits++;
        }
        // Nothing charted here yet (chart still loading, or a rest-only window)
        // — not a real attempt, so no score and no window clear.
        const score = _ndDrillPassScore(hits, charted);
        if (score == null) return;
        if (score > drillConductorBest) drillConductorBest = score;
        // Clear this pass's judgments so the NEXT iteration scores only what the
        // player does next time. `arr` above is a snapshot, so the per-note miss
        // summary below still works. See _drillClearWindow.
        clearWindow(judgeStart, judgeEnd);

        const decision = _ndDrillRampDecision(
            score, drillConductorGoal, drillConductorRung, drillConductorLadder.length,
            drillConductorTopClears, _ND_DRILL_FULLSPEED_REPS);
        if (decision.action === 'graduate') {
            // "Into it & out of it": if opted in and there's room, widen the loop
            // by a bar each side and re-earn it instead of finishing — so the
            // hard passage gets practiced IN CONTEXT, not just in isolation.
            if (drillConductorExpandsLeft > 0 && _drillExpandLoop()) {
                drillConductorExpandsLeft--;
                return;
            }
            drillConductorTopClears++;
            _drillConductorUpdateHud({ lastScore: score, graduated: true });
            endDrill('graduated');
            return;
        }
        if (decision.action === 'consolidate') {
            // Cleared the goal at full speed, but stay on the drill and lock it
            // in — the user often didn't KNOW this hotspot until now, so a few
            // full-speed reps reinforce it before returning to the song.
            drillConductorTopClears++;
            drillConductorFailStreak = 0;
            const repsLeft = Math.max(0, _ND_DRILL_FULLSPEED_REPS - drillConductorTopClears);
            _drillConductorUpdateHud({ lastScore: score, consolidate: true, repsLeft });
        } else if (decision.action === 'advance') {
            // Step up one rung: faster playback, fresh best for the new
            // speed (the goal must be re-earned at the harder tempo).
            drillConductorRung = decision.nextRung;
            drillConductorBest = 0;
            drillConductorFailStreak = 0;
            drillConductorTopClears = 0;   // not consolidating until we're at the top
            const toPct = Math.round((drillConductorLadder[drillConductorRung] || 1) * 100);
            _hostSetSpeed(drillConductorLadder[drillConductorRung]);
            _drillConductorUpdateHud({ lastScore: score, advanced: true, toPct });
        } else {
            // Missed the goal — a full-speed flub breaks the consolidation streak.
            drillConductorTopClears = 0;
            // Held below the goal. Struggling for 3 straight passes → SLOW DOWN
            // (the user asked for this): step back to a slower rung if we
            // advanced too soon, or extend the ladder below the floor (down to
            // 40%) if already at the slowest. Meet the player where they are.
            drillConductorFailStreak++;
            if (drillConductorFailStreak >= 3) {
                if (drillConductorRung > 0) {
                    drillConductorRung--;                       // back off a premature advance
                } else {
                    const cur = drillConductorLadder[0] || 1;
                    const slower = Math.max(0.4, Math.round((cur - 0.15) * 100) / 100);
                    if (slower < cur - 1e-6) drillConductorLadder.unshift(slower);  // rung stays 0 → now slower
                }
                const sp = drillConductorLadder[drillConductorRung] || 1;
                drillConductorBest = 0;
                drillConductorFailStreak = 0;
                _hostSetSpeed(sp);
                _drillConductorUpdateHud({ lastScore: score, slowedToPct: Math.round(sp * 100) });
            } else {
                // Show WHICH notes were missed this pass and HOW.
                _drillConductorUpdateHud({ lastScore: score, misses: _ndSummarizeWindowMisses(arr, judgeStart, judgeEnd) });
            }
        }
        // Click cursor resets in _drillConductorTick on the playhead's backward
        // jump — no scheduling here (the tick owns the metronome now).
    }

    // Detect a loop wrap from the chart clock (a backward jump) — the
    // reliable trigger, since the host's loop:restart event doesn't reach
    // us on this loop path. Called every HUD tick while drilling. Deduped
    // against _drillConductorOnWrap's own stamp so if loop:restart DID fire
    // we don't score twice.
    function _drillConductorTick() {
        if (!drillConductorActive) return;
        const _hw = getHw();
        if (!_hw || !_hw.getTime) return;
        const ct = _hw.getTime();
        if (_ndDrillLastChartT > 0 && ct >= 0 && ct < _ndDrillLastChartT - 1.0) {
            // Backward jump = wrap. Reset the click cursor to the loop start so
            // the metronome re-fires across the new iteration.
            _drillBeatIdx = 0;
            // Skip if a loop:restart already scored it.
            if (_ndPerfNow() - _ndDrillLastScoredPerf > 1200) _drillConductorOnWrap();
        } else {
            // Steady playback (incl. lead-in): fire any beats now due. On pause
            // the playhead freezes → nothing crosses → no click (no backlog).
            const speed = (drillConductorLadder && drillConductorLadder[drillConductorRung]) || 1;
            _drillScheduleDueClicks(ct, speed);
        }
        _ndDrillLastChartT = ct;
    }

    // ── Beat-locked drill metronome (PLAYHEAD-DRIVEN) ──────────────────
    // A click on every beat across the whole loop (lead-in included). Driven
    // by the chart playhead via _drillConductorTick, NOT pre-scheduled on the
    // audio clock — the previous schedule-ahead version kept clicking through
    // a pause (audio clock runs while playback is stopped) and stuttered when
    // re-scheduled each wrap (overlapping click trains). Playhead-driven fixes
    // both: when playback pauses the playhead freezes, so no beat is crossed
    // and no click fires; each beat is scheduled exactly once via a cursor.

    function _drillInitBeats() {
        _drillBeatTimes = [];
        _drillBeatIdx = 0;
        if (!drillConductorRange) return;
        const _hw = getHw();
        const { loopStart, loopEnd, judgeStart } = drillConductorRange;
        const beats = (_hw && _hw.getBeats) ? _hw.getBeats() : null;
        if (Array.isArray(beats) && beats.length) {
            for (const b of beats) {
                const bt = (typeof b === 'number') ? b : (b && Number.isFinite(b.time) ? b.time : null);
                if (bt != null && bt >= loopStart - 1e-6 && bt <= loopEnd) _drillBeatTimes.push(bt);
            }
        }
        if (!_drillBeatTimes.length) {   // no beat grid — fall back to even spacing at the local tempo
            const bpm = (_hw && _hw.getBPM) ? _hw.getBPM(judgeStart) : 100;
            const beat = 60 / (Number.isFinite(bpm) && bpm > 0 ? bpm : 100);
            for (let bt = loopStart; bt <= loopEnd; bt += beat) _drillBeatTimes.push(bt);
        }
    }

    // Schedule any beats now due (within the look-ahead) as single clicks at
    // their exact future audio time = now + (beatChartTime − playhead)/speed.
    // Called every HUD tick with the current playhead + drill speed.
    function _drillScheduleDueClicks(ct, speed) {
        if (!getAudioCtx() || !_drillBeatTimes.length) return;
        const sp = (Number.isFinite(speed) && speed > 0) ? speed : 1;
        while (_drillBeatIdx < _drillBeatTimes.length
               && _drillBeatTimes[_drillBeatIdx] <= ct + _CLICK_LOOKAHEAD_S) {
            const bt = _drillBeatTimes[_drillBeatIdx];
            const at = getAudioCtx().currentTime + Math.max(0, (bt - ct) / sp);
            const accent = (_drillBeatIdx % 4 === 0);   // approximate downbeat (4/4)
            try {
                const osc = getAudioCtx().createOscillator();
                const g = getAudioCtx().createGain();
                osc.frequency.value = accent ? 1320 : 880;
                g.gain.setValueAtTime(0.0001, at);
                g.gain.exponentialRampToValueAtTime(accent ? 0.34 : 0.26, at + 0.004);
                g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
                osc.connect(g); g.connect(getAudioCtx().destination);
                osc.start(at); osc.stop(at + 0.06);
            } catch (_) { /* click is best-effort */ }
            _drillBeatIdx++;
        }
    }

    function endDrill(reason = 'user') {
        if (!drillConductorActive) return;
        drillConductorActive = false;
        // Misses scored inside the drill loop grew the contiguous-miss run;
        // clear it (and start a cooldown) so returning to the song doesn't
        // instantly auto-drill again on the next miss.
        _autoDrillMissStreak = 0;
        _autoDrillFirstMissT = NaN;
        _autoDrillLastMissT = NaN;
        _autoDrillCooldownUntil = _ndPerfNow() + 4000;
        const graduated = reason === 'graduated';
        const label = drillConductorLabel;
        const best = drillConductorBest;

        // Restore the pre-drill playback speed.
        if (Number.isFinite(drillConductorSavedSpeed)) _hostSetSpeed(drillConductorSavedSpeed);
        // Drop the A-B loop (unless the host already cleared it — e.g. a
        // song change, which routes here with reason 'song-changed').
        if (reason !== 'song-changed') {
            try {
                if (window.slopsmith && typeof window.slopsmith.clearLoop === 'function') {
                    window.slopsmith.clearLoop({ reason: 'note_detect-drill-end' });
                }
            } catch (e) {
                console.warn('[note_detect] endDrill: clearLoop threw:', e);
            }
        }
        window._ndAnyDrillActive = false;
        // Unbind our loop:restart listener.
        if (drillConductorOnWrapFn && window.slopsmith && typeof window.slopsmith.off === 'function') {
            try { window.slopsmith.off('loop:restart', drillConductorOnWrapFn); } catch (_) {}
        }
        drillConductorOnWrapFn = null;
        _drillConductorHideHud(graduated);

        // Notify listeners — the finder layer chains to the next hotspot
        // on graduation, and coaching can log the outcome.
        try {
            if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
                window.slopsmith.emit('notedetect:drill-ended', { reason, graduated, label, best });
            }
        } catch (_) {}

        drillConductorLadder = null;
        drillConductorRung = 0;
        drillConductorBest = 0;
        drillConductorFocus = null;
        drillConductorLabel = null;
        drillConductorSavedSpeed = null;
        drillConductorRange = null;
        console.log(`[note_detect] Drill ended (${reason})${graduated ? ` — graduated "${label}" at ${Math.round(best * 100)}%` : ''}`);
    }

    // ── Drill conductor HUD ───────────────────────────────────────────
    // Floating overlay on document.body (visible regardless of which
    // instance container owns the player) showing speed, goal, the last
    // iteration's score, and best-so-far at the current rung.
    function _drillConductorShowHud() {
        // A new drill's HUD supersedes any pending graduation fade-out — cancel
        // it so the stale timer can't remove THIS (reused-id) HUD out from under
        // the next drill.
        if (_drillHudRemoveTimer) { clearTimeout(_drillHudRemoveTimer); _drillHudRemoveTimer = null; }
        let hud = document.getElementById('nd-drill-hud');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'nd-drill-hud';
            hud.className = 'fixed top-3 left-1/2 -translate-x-1/2 z-[210] min-w-[330px] bg-dark-800 border-2 border-blue-700 rounded-xl shadow-2xl px-4 py-2 text-sm';
            document.body.appendChild(hud);
        }
        _drillConductorUpdateHud();
    }

    // Render the drill HUD. The message is the user's "way out" signal —
    // each pass it says either how far short of the goal you are (keep
    // going) or that you've earned a speed-up / graduated. Always shows an
    // obvious End button so the loop is never a trap.
    function _drillConductorUpdateHud(extra = {}) {
        const hud = document.getElementById('nd-drill-hud');
        if (!hud) return;
        const { lastScore = null, graduated = false, advanced = false, consolidate = false, repsLeft = null, toPct = null, slowedToPct = null, misses = null, expanded = false } = extra;
        const speedPct = drillConductorLadder
            ? Math.round((drillConductorLadder[drillConductorRung] || 1) * 100) : 100;
        const goalPct = Math.round((drillConductorGoal || 0) * 100);
        const bestPct = Math.round((drillConductorBest || 0) * 100);
        const lastPct = lastScore != null ? Math.round(lastScore * 100) : null;
        const atTop = drillConductorLadder
            ? drillConductorRung >= drillConductorLadder.length - 1 : true;

        let banner;
        if (graduated) {
            banner = `<div class="text-green-300 font-bold text-sm">✓ Nailed it at full speed — drill complete!</div>`;
        } else if (expanded) {
            banner = `<div class="text-green-300 font-bold text-sm">✓ Nailed! Now widening the loop — play into and out of it</div>`;
        } else if (advanced) {
            banner = `<div class="text-green-300 font-bold text-sm">▲ Time to go faster — now ${toPct != null ? toPct : speedPct}% speed</div>`;
        } else if (consolidate) {
            const n = repsLeft != null ? repsLeft : 0;
            banner = `<div class="text-green-300 font-bold text-sm">✓ Clean at full speed! ${n > 0 ? `Lock it in — ${n} more to graduate` : 'One more to graduate'}</div>`;
        } else if (slowedToPct != null) {
            banner = `<div class="text-blue-300 font-bold text-sm">▼ Slowing to ${slowedToPct}% — get it solid here first</div>`;
        } else if (lastPct != null) {
            const ok = lastPct >= goalPct;
            banner = ok
                ? `<div class="text-green-300 text-sm">Last pass <span class="font-bold">${lastPct}%</span> — clean!</div>`
                : `<div class="text-amber-200 text-sm">Last pass <span class="font-bold">${lastPct}%</span> — need <span class="font-bold">${goalPct}%</span> to speed up. Keep going.</div>`;
        } else {
            banner = `<div class="text-gray-300 text-sm">Play the loop — hit <span class="font-bold">${goalPct}%</span> clean to speed up.</div>`;
        }
        // drillConductorFocus / drillConductorLabel can come from the public
        // startDrill(start, end, { label, focus }) opts, so escape them before
        // interpolating into this innerHTML sink (consistent with the summary
        // card's handling of user-facing strings).
        const sub = `<div class="text-gray-500 text-[11px] mt-0.5">🎯 ${speedPct}% speed${atTop ? ' (full)' : ''} · best ${bestPct}%${drillConductorFocus ? ' · ' + _ndEscapeHtml(drillConductorFocus) : (drillConductorLabel ? ' · ' + _ndEscapeHtml(drillConductorLabel) : '')}</div>`;
        // Per-note "what you missed + how" for the pass just finished.
        const howColor = { missed: 'text-red-300', late: 'text-amber-300', early: 'text-amber-300', sharp: 'text-purple-300', flat: 'text-purple-300', wrong: 'text-red-300' };
        let missList = '';
        if (Array.isArray(misses) && misses.length) {
            const shown = misses.slice(0, 6).map((m) => {
                const pos = `S${(Number.isInteger(m.s) ? m.s + 1 : '?')}·${Number.isInteger(m.f) ? 'fr' + m.f : '?'}`;
                return `<div class="flex justify-between gap-3"><span class="text-gray-300">${pos}</span><span class="${howColor[m.how] || 'text-gray-400'}">${m.detail}</span></div>`;
            }).join('');
            const more = misses.length > 6 ? `<div class="text-gray-600 text-[10px]">+${misses.length - 6} more</div>` : '';
            missList = `<div class="mt-1.5 pt-1.5 border-t border-gray-700 text-[11px] font-mono leading-tight">`
                + `<div class="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">Missed this pass</div>${shown}${more}</div>`;
        }
        // Editable loop bounds — nudge start/end ±2s to carve exactly the
        // passage you want (e.g. trim past a note in the detector's blind
        // spot). Each nudge re-arms the drill on the new region.
        const _mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        const rng = drillConductorRange || {};
        const nb = (edge, d, t) => `<button class="nd-loop-nudge px-2 py-0.5 bg-dark-600 hover:bg-dark-500 rounded text-gray-300" data-edge="${edge}" data-d="${d}" title="${t}">${d < 0 ? '−' : '+'}</button>`;
        const loopRow = (Number.isFinite(rng.judgeStart) && Number.isFinite(rng.judgeEnd))
            ? `<div class="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-gray-700 text-[11px]">
                   <span class="text-gray-500">Loop</span>
                   ${nb('start', -2, 'Start 2s earlier')}<span class="text-gray-300 font-mono">${_mmss(rng.judgeStart)}</span>${nb('start', 2, 'Start 2s later')}
                   <span class="text-gray-600">–</span>
                   ${nb('end', -2, 'End 2s earlier')}<span class="text-gray-300 font-mono">${_mmss(rng.judgeEnd)}</span>${nb('end', 2, 'End 2s later')}
               </div>`
            : '';
        hud.innerHTML = `
            <div class="flex items-start gap-3">
                <div class="flex-1">${banner}${sub}${missList}${loopRow}</div>
                <button id="nd-drill-end" class="px-2.5 py-1 bg-dark-600 hover:bg-dark-500 text-gray-200 rounded-lg text-xs font-semibold whitespace-nowrap" title="End drill">✕ End</button>
            </div>`;
        const endBtn = hud.querySelector('#nd-drill-end');
        if (endBtn) endBtn.onclick = () => endDrill('user');
        hud.querySelectorAll('.nd-loop-nudge').forEach((b) => {
            b.onclick = () => _drillAdjustLoop(b.dataset.edge, Number(b.dataset.d));
        });
    }

    // Re-arm the current drill with the loop edge nudged by `d` seconds. Lets
    // the player carve the loop (the original auto-bounds are just a starting
    // point) — e.g. trim a low note the detector can't hear out of the region.
    function _drillAdjustLoop(edge, d) {
        if (!drillConductorActive || !drillConductorRange || !Number.isFinite(d)) return;
        let start = drillConductorRange.judgeStart;
        let end = drillConductorRange.judgeEnd;
        if (edge === 'start') start = Math.max(0, start + d);
        else end = end + d;
        if (!(end - start >= 0.5)) return;   // keep a sane minimum span
        // Fresh drill on the new region (resets the speed ladder — a new loop
        // earns its speed-up again); preserve the goal.
        startDrill(start, end, { goal: drillConductorGoal }).catch(() => {});
    }

    function _drillConductorHideHud(graduated) {
        const hud = document.getElementById('nd-drill-hud');
        if (!hud) return;
        if (graduated) {
            // Leave the graduation message up briefly, then fade. Capture THIS
            // node and store the timer id: on graduation the finder chains a new
            // startDrill within 3s that reuses the #nd-drill-hud id, so a blind
            // getElementById().remove() here would yank the NEXT drill's HUD
            // (incl. its ✕ End button). _drillConductorShowHud cancels this timer
            // when the next HUD appears; the isConnected guard is belt-and-braces.
            _drillConductorUpdateHud({ graduated: true });
            _drillHudRemoveTimer = setTimeout(() => {
                _drillHudRemoveTimer = null;
                if (hud.isConnected) hud.remove();
            }, 3000);
        } else {
            hud.remove();
        }
    }

    function _drillResetIteration(startT) {
        drillIterHits = 0;
        drillIterMisses = 0;
        drillIterStreak = 0;
        drillIterBestStreak = 0;
        // Reject NaN / Infinity — typeof===number is true for both and
        // they'd leak through into getDrillStats().current.startT and
        // poison any downstream arithmetic.
        drillIterStartT = Number.isFinite(startT) ? startT : null;
    }

    function _drillSnapshotIteration() {
        const total = drillIterHits + drillIterMisses;
        // Skip zero-judgment iterations so an idle loop wrap doesn't
        // pollute the scoreboard with empty rows.
        if (total === 0) return;
        const accuracy = Math.round((drillIterHits / total) * 100);
        // Iteration duration = loopB - loopA (the loop's length).
        // The wrap event's `detail.time` is loopA (the new
        // iteration's start), not the just-finished iteration's
        // endpoint — so we can't derive duration from event timing.
        // Using the cached active bounds is correct: the iteration
        // we're snapshotting played from loopA through loopB.
        const durationSec = (Number.isFinite(drillActiveLoopA) && Number.isFinite(drillActiveLoopB))
            ? Math.max(0, drillActiveLoopB - drillActiveLoopA)
            : null;
        drillIterations.push({
            idx: drillNextIdx++,
            hits: drillIterHits,
            misses: drillIterMisses,
            accuracy,
            bestStreak: drillIterBestStreak,
            durationSec,
            ts: Date.now(),
        });
        // Bound the array to the most recent N — long sessions
        // shouldn't grow memory unboundedly.
        if (drillIterations.length > DRILL_MAX_ITERATIONS) {
            drillIterations.splice(0, drillIterations.length - DRILL_MAX_ITERATIONS);
        }
        drillDirty = true;
    }

    function _drillOnLoopRestart(e) {
        const rawTime = (e && e.detail) ? e.detail.time : undefined;
        const wrapTime = Number.isFinite(rawTime) ? rawTime : null;
        // Snapshot the iteration that just ended (duration is derived
        // from the cached loop bounds, not the event payload — the
        // event's `time` is loopA, the new iteration's start).
        _drillSnapshotIteration();
        // Re-anchor at the new iteration's start (= loopA).
        _drillResetIteration(wrapTime);
    }

    function _drillOnSongChanged() {
        // A conductor drill belongs to the previous song's passage — end it
        // (drops the A-B loop, restores speed, removes the HUD, unbinds its
        // own loop:restart listener). reason 'song-changed' skips clearLoop
        // since the host already dropped the loop on the switch.
        if (drillConductorActive) endDrill('song-changed');
        // New song = different passage; stale iterations don't apply.
        // Also drop drillEnabled so getDrillStats() doesn't report
        // active=true between this event and the next HUD sync (which
        // may not happen at all if detection is disabled).
        drillIterations = [];
        _drillResetIteration(null);
        drillActiveLoopA = null;
        drillActiveLoopB = null;
        drillNextIdx = 1;
        drillEnabled = false;
        drillDirty = true;
    }

    function _drillBindEvents() {
        if (drillSubscribed) return;
        // Require both .on and .off so we never bind handlers we
        // can't tear down later — a host with on-only would leak
        // listeners across destroy() / re-mount.
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        // Register all three first; only set drillSubscribed after the
        // .on calls succeed. If any throws mid-registration we tear
        // down what landed so a retry on the next call is clean.
        const onLoopRestart = _drillOnLoopRestart;
        const onSongChanged = _drillOnSongChanged;
        // Loop set/clear notifications from the playback capability
        // (feedBack emits these on window.feedBack as
        // playback:loop-set / playback:loop-cleared). These make drill
        // activation event-driven; the updateHUD getLoop() poll is
        // only a throttled fallback for hosts without them.
        const onLoopChanged = () => _drillSyncFromLoopState();
        try {
            window.slopsmith.on('loop:restart', onLoopRestart);
            window.slopsmith.on('song:loaded', onSongChanged);
            window.slopsmith.on('song:ended', onSongChanged);
            window.slopsmith.on('playback:loop-set', onLoopChanged);
            window.slopsmith.on('playback:loop-cleared', onLoopChanged);
        } catch (e) {
            // Partial registration — unwind so we don't leak handlers.
            if (typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('loop:restart', onLoopRestart); } catch (_) {}
                try { window.slopsmith.off('song:loaded', onSongChanged); } catch (_) {}
                try { window.slopsmith.off('song:ended', onSongChanged); } catch (_) {}
                try { window.slopsmith.off('playback:loop-set', onLoopChanged); } catch (_) {}
                try { window.slopsmith.off('playback:loop-cleared', onLoopChanged); } catch (_) {}
            }
            return;
        }
        drillOnLoopRestartFn = onLoopRestart;
        drillOnSongChangedFn = onSongChanged;
        drillOnLoopChangedFn = onLoopChanged;
        drillSubscribed = true;
    }

    function _drillUnbindEvents() {
        if (!drillSubscribed) return;
        // destroy() calls this on teardown — a misbehaving host
        // throwing from .off() would otherwise crash destroy and
        // leave the instance partially torn down. Guard each call
        // independently so one bad listener doesn't block the rest.
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (drillOnLoopRestartFn) {
                try { window.slopsmith.off('loop:restart', drillOnLoopRestartFn); } catch (e) {}
            }
            if (drillOnSongChangedFn) {
                try { window.slopsmith.off('song:loaded', drillOnSongChangedFn); } catch (e) {}
                try { window.slopsmith.off('song:ended', drillOnSongChangedFn); } catch (e) {}
            }
            if (drillOnLoopChangedFn) {
                try { window.slopsmith.off('playback:loop-set', drillOnLoopChangedFn); } catch (e) {}
                try { window.slopsmith.off('playback:loop-cleared', drillOnLoopChangedFn); } catch (e) {}
            }
        }
        drillSubscribed = false;
        drillOnLoopRestartFn = null;
        drillOnSongChangedFn = null;
        drillOnLoopChangedFn = null;
    }

    // End-of-song summary, XP submission, deferred reveal, and event bind/unbind
    // moved to createSummaryUi (nd-carve-5 cut 2). Use _summaryUi.* to access.

    // Render the drill HUD panel — current iteration header (live
    // counter + accuracy) plus the last 5 completed iterations with
    // best/worst highlighting. Hides itself entirely when drill is
    // neither active nor has history. UI only; no state mutation.
    // Gated on drillDirty so we don't re-parse innerHTML on every
    // 33 ms HUD tick when nothing changed.
    function _drillRender() {
        if (!drillDirty) return;
        drillDirty = false;
        const panel = instanceRoot.querySelector('.nd-drill');
        if (!panel) return;
        // Hide entirely when neither active nor populated — keeps the
        // HUD compact in non-drill use.
        const hasHistory = drillIterations.length > 0;
        if (!drillEnabled && !hasHistory) {
            panel.classList.add('hidden');
            return;
        }
        panel.classList.remove('hidden');
        const headerEl = panel.querySelector('.nd-drill-header');
        const listEl = panel.querySelector('.nd-drill-list');
        if (headerEl) {
            if (drillEnabled) {
                const liveTotal = drillIterHits + drillIterMisses;
                const liveAcc = liveTotal > 0 ? Math.round((drillIterHits / liveTotal) * 100) : null;
                // Use the monotonic counter, NOT iterations.length + 1
                // — the array splices from the front at the truncation
                // cap, so `length + 1` would freeze at #51 forever.
                const num = drillNextIdx;
                headerEl.textContent = liveAcc !== null
                    ? `Drill #${num}: ${drillIterHits}/${liveTotal} (${liveAcc}%)`
                    : `Drill #${num}`;
            } else {
                // Drill stopped (loop cleared), but history is still
                // visible — label it so the user knows.
                headerEl.textContent = `Drill (last loop)`;
            }
        }
        if (listEl) {
            if (!hasHistory) {
                listEl.textContent = '';
            } else {
                // Show the last 5 iterations, oldest -> newest. Find
                // best/worst within the visible window for highlighting.
                const recent = drillIterations.slice(-5);
                let best = recent[0], worst = recent[0];
                for (const it of recent) {
                    if (it.accuracy > best.accuracy) best = it;
                    if (it.accuracy < worst.accuracy) worst = it;
                }
                const parts = recent.map((it) => {
                    const tag = it === best && recent.length > 1
                        ? ' <span style="color:#00ff88">★</span>'
                        : it === worst && recent.length > 1
                            ? ' <span style="color:#ff4444">·</span>'
                            : '';
                    return `#${it.idx} ${it.hits}/${it.hits + it.misses} ${it.accuracy}%${tag}`;
                });
                listEl.innerHTML = parts.join('<br>');
            }
        }
    }

    // Bridge slopsmith loop state into our drillEnabled flag and
    // detect mid-drill loop bounds changes (user picked a different
    // saved loop). Called from updateHUD every 33 ms and from
    // enable() once at activation. Cheap — one getLoop read + a
    // boolean compare.
    function _drillSyncFromLoopState() {
        const { loopA, loopB } = _drillCurrentLoop();
        // Require finite numbers, not just non-null. A malformed return
        // (e.g. {}, undefined fields) would otherwise activate drill
        // mode and start mutating per-iteration counters against bogus
        // bounds.
        const nowEnabled = Number.isFinite(loopA) && Number.isFinite(loopB);
        if (nowEnabled && !drillEnabled) {
            // Drill just (re)started. Treat re-activation after a
            // previously-cleared loop the same way as a mid-drill
            // bounds change: if the new bounds DIFFER from the last
            // active bounds (drillActiveLoopA/B kept across the
            // deactivation), the iteration history is from a
            // different passage and must be cleared. If they match
            // exactly, the user just reopened the same loop and the
            // history is comparable.
            const sameBounds = (loopA === drillActiveLoopA && loopB === drillActiveLoopB);
            if (!sameBounds) {
                drillIterations = [];
                drillNextIdx = 1;
            }
            drillActiveLoopA = loopA;
            drillActiveLoopB = loopB;
            // Anchor at loopA (the iteration's true start) rather
            // than hw.getTime(): the user might enable detection
            // mid-iteration, but the iteration we're starting to
            // track conceptually begins at A.
            _drillResetIteration(loopA);
            drillDirty = true;
        } else if (nowEnabled && drillEnabled) {
            // Loop bounds changed mid-drill — different passage.
            // Clear history so the iteration list isn't comparing
            // apples to oranges.
            if (loopA !== drillActiveLoopA || loopB !== drillActiveLoopB) {
                drillIterations = [];
                drillNextIdx = 1;
                drillActiveLoopA = loopA;
                drillActiveLoopB = loopB;
                _drillResetIteration(loopA);
                drillDirty = true;
            }
        } else if (!nowEnabled && drillEnabled) {
            // Loop cleared. Keep the iteration history visible for
            // the user to review; just stop counting.
            _drillResetIteration(null);
            drillDirty = true;
        }
        drillEnabled = nowEnabled;
    }

    return {
        // drillCallbacks contract for createHUD (nd-carve-5 cut 3)
        syncFromLoopState: _drillSyncFromLoopState,
        conductorTick: _drillConductorTick,
        render: _drillRender,
        // Public API
        startDrill,
        startDrillHere,
        endDrill,
        isDrilling: () => drillConductorActive,
        getConductorState: () => ({
            active: drillConductorActive,
            label: drillConductorLabel,
            focus: drillConductorFocus,
            goal: drillConductorGoal,
            best: drillConductorBest,
            rung: drillConductorRung,
            ladder: drillConductorLadder ? drillConductorLadder.slice() : null,
            speed: drillConductorLadder ? (drillConductorLadder[drillConductorRung] || null) : null,
            range: drillConductorRange ? { ...drillConductorRange } : null,
        }),
        getDrillStats() {
            // Sync inline so callers always see current loop state
            // even when detection is disabled (when updateHUD isn't ticking).
            _drillSyncFromLoopState();
            const liveTotal = drillIterHits + drillIterMisses;
            return {
                active: drillEnabled,
                current: {
                    hits: drillIterHits,
                    misses: drillIterMisses,
                    streak: drillIterStreak,
                    bestStreak: drillIterBestStreak,
                    accuracy: liveTotal > 0 ? Math.round((drillIterHits / liveTotal) * 100) : 0,
                    startT: drillIterStartT,
                },
                iterations: drillIterations.map((it) => ({ ...it })),
            };
        },
        bindEvents: _drillBindEvents,
        unbindEvents: _drillUnbindEvents,
        // Called from recordJudgment for every scored note (hit OR miss).
        // Owns auto-drill tracking and per-iteration drill counters.
        onJudgment(judgment) {
            if (judgment.hit) {
                _autoDrillMissStreak = 0;
            } else {
                _autoDrillMissStreak++;
                if (Number.isFinite(judgment.noteTime)) {
                    if (_autoDrillMissStreak === 1) _autoDrillFirstMissT = judgment.noteTime;
                    _autoDrillLastMissT = judgment.noteTime;
                }
                _maybeAutoDrill();
            }
            if (drillEnabled) {
                if (judgment.hit) {
                    drillIterHits++;
                    drillIterStreak++;
                    if (drillIterStreak > drillIterBestStreak) drillIterBestStreak = drillIterStreak;
                } else {
                    drillIterMisses++;
                    drillIterStreak = 0;
                }
                drillDirty = true;
            }
        },
        setAutoDrillMisses(n) { _autoDrillMisses = n; },
        resetForSong() {
            _autoDrillMisses = getAutoDrillMissesSetting();
            _autoDrillMissStreak = 0;
            _autoDrillFirstMissT = NaN;
            _autoDrillLastMissT = NaN;
        },
    };
}
