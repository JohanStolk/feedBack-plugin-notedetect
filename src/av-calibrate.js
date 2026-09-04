// nd-carve-5 cut 5 — A/V auto-calibrate subsystem (K)
// Extracted from createNoteDetector() factory closure in src/main.js.
//
// Non-verbatim deltas vs. the original inline code:
//   1. All mutable factory-closure deps are passed as accessor functions
//      (getHw, getAutoCalibrate, ...) per the LIVE-ACCESSOR RULE, so the
//      module always reads the live value at call time, not the value that
//      was current when createAvCalibrate() was called.
//   2. calibrateOffsetMs + calibrationNotes passed as DI rather than
//      captured lexically (both defined at module scope in main.js and depend
//      on other module-scope helpers not yet extracted).
//   3. dispatchInstanceEvent is a function-declaration in main.js (hoisted),
//      passed directly as a stable function reference — no accessor wrapper
//      needed because it is never reassigned.

export function createAvCalibrate({
    getHw,
    getAutoCalibrate,
    getIsDefault,
    getDetectedMidi,
    getLatencyOffset,
    getDetectPreference,
    getCurrentArrangement,
    getCurrentStringCount,
    getTuningOffsets,
    getCapo,
    getTimingHitThreshold,
    getPitchTolerance,
    calibrationNotes,
    calibrateOffsetMs,
    dispatchInstanceEvent,
}) {
    // A/V auto-calibration: offset-free detections logged across a play
    // ({ bt: hw.getTime()-latencyOffset, m: detectedMidi }); swept on song-end.
    let _calDetections = [];
    const _CAL_MAX = 8000;          // ~ caps memory on a long take
    let _calDoneThisPlay = false;   // calibrate at most once per play
    // True between a song:pause and the next song:play, so song:play can tell
    // a resume (keep the take's detections) from a fresh start (reset them).
    let _calPaused = false;
    let _lastAvCalibration = null;  // { offsetMs, matched, total } for the UI

    let _calOnLoaded = null, _calOnEnded = null, _calOnPause = null, _calOnPlay = null, _calSubscribed = false;

    // Log one offset-free detection ({ bt: hw.getTime()-latencyOffset, m })
    // for the post-play sweep. Gated on the setting + the default singleton
    // (split panels / disabled-setting users don't accumulate) and a confident
    // pitch. Shared by matchNotes() and the engine-verifier poll, which returns
    // before matchNotes() and so must tap this directly.
    function logDetection() {
        if (getAutoCalibrate() && getIsDefault() && getDetectedMidi() >= 0 && _calDetections.length < _CAL_MAX) {
            _calDetections.push({ bt: getHw().getTime() - getLatencyOffset(), m: getDetectedMidi() });
        }
    }

    function runAutoCalibrate() {
        if (!getAutoCalibrate()) return 'autoCalibrate off';
        if (!getIsDefault()) return 'not default';
        // The cal listeners deliberately survive disable() (the host disables
        // detection at song-end, sometimes before song:ended fires), so guard
        // against a USER-initiated Detect-off here: detectPreference stays true
        // across a host disable() but flips false when the user turns Detect
        // off. Without this a late song:ended could move the global A/V offset
        // from a half-finished take after the user switched detection off.
        if (!getDetectPreference()) return 'detect off (user)';
        if (_calDoneThisPlay) return 'already done this play';
        if (typeof window.setAvOffsetMs !== 'function') return 'no window.setAvOffsetMs';
        const notes = calibrationNotes();
        if (!notes || !notes.length) return 'no notes';
        const arr = getCurrentArrangement(), sc = getCurrentStringCount();
        const geom = { arrangement: arr, stringCount: sc, offsets: getTuningOffsets(), capo: getCapo() };
        const win = getTimingHitThreshold(), tol = getPitchTolerance();
        const r = calibrateOffsetMs(_calDetections, notes, geom, win, tol, {});
        if (!r) return `sweep null (dets=${_calDetections.length}, notes=${notes.length}, arr=${arr}/${sc}, win=${win}, tol=${tol})`;
        _calDoneThisPlay = true;
        _lastAvCalibration = r;
        try {
            window.setAvOffsetMs(r.offsetMs);
            console.log(`[note_detect] A/V auto-calibrated to ${r.offsetMs} ms (${r.matched}/${r.total} notes matched)`);
            // Dispatch on the normal detector event path (window + instanceRoot),
            // matching notedetect:verify/notedetect:session, so consumers that
            // don't listen on the slopsmith bus still receive it.
            dispatchInstanceEvent('notedetect:calibrated', { offsetMs: r.offsetMs, matched: r.matched, total: r.total });
            if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
                window.slopsmith.emit('notedetect:calibrated', { offsetMs: r.offsetMs, matched: r.matched, total: r.total });
            }
        } catch (e) { return 'setAvOffsetMs threw: ' + (e && e.message || e); }
        return 'OK ' + JSON.stringify(r);
    }

    function bindEvents() {
        if (!getIsDefault() || _calSubscribed) return;
        if (!window.slopsmith || typeof window.slopsmith.on !== 'function') return;
        // New song → clean slate (incl. the UI's last-result display).
        _calOnLoaded = () => {
            _calDetections = []; _calDoneThisPlay = false; _lastAvCalibration = null; _calPaused = false;
        };
        // song:play is either a fresh take or a resume after a pause. On a fresh
        // start, reset the take so a replay — or a stop that emitted no
        // song:ended — doesn't sweep the previous play's detections, and so the
        // once-per-play guard re-opens for the new take. On a resume, keep them.
        _calOnPlay = () => {
            if (_calPaused) { _calPaused = false; return; }   // resume — keep the take
            _calDetections = []; _calDoneThisPlay = false;
        };
        // Pause is resumable: just remember we're paused. Do NOT calibrate here —
        // a mid-song pause would lock in a partial-take offset and the
        // once-per-play guard would then suppress the real song:ended sweep
        // after the user resumes.
        _calOnPause = () => { _calPaused = true; };
        // Clean end of the take → sweep once. Clear _calPaused so a replay reads
        // as a fresh start (resets) rather than a resume.
        _calOnEnded = () => { runAutoCalibrate(); _calPaused = false; };
        try {
            window.slopsmith.on('song:loaded', _calOnLoaded);
            window.slopsmith.on('song:play',   _calOnPlay);
            window.slopsmith.on('song:ended',  _calOnEnded);
            window.slopsmith.on('song:pause',  _calOnPause);
            _calSubscribed = true;
        } catch (_) { unbindEvents(); }
    }

    function unbindEvents() {
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_calOnLoaded) { try { window.slopsmith.off('song:loaded', _calOnLoaded); } catch (_) {} }
            if (_calOnPlay)   { try { window.slopsmith.off('song:play',   _calOnPlay); } catch (_) {} }
            if (_calOnEnded)  { try { window.slopsmith.off('song:ended',  _calOnEnded); } catch (_) {} }
            if (_calOnPause)  { try { window.slopsmith.off('song:pause',  _calOnPause); } catch (_) {} }
        }
        _calOnLoaded = _calOnPlay = _calOnEnded = _calOnPause = null;
        _calSubscribed = false;
    }

    return {
        logDetection,
        runAutoCalibrate,
        bindEvents,
        unbindEvents,
        getLastCalibration: () => _lastAvCalibration,
        getState: () => ({ detections: _calDetections.length, done: _calDoneThisPlay, paused: _calPaused }),
        seedForTest: (n = 5) => { for (let i = 0; i < n; i++) _calDetections.push({ bt: i, m: 40 }); },
        detectionsDump: () => _calDetections.slice(),
        getDebug: () => {
            const h = getHw();
            return {
                detections: _calDetections.length,
                subscribed: _calSubscribed,
                autoCalibrate: getAutoCalibrate(),
                isDefault: getIsDefault(),
                notes: (h && h.getNotes) ? (h.getNotes() || []).length : -1,
            };
        },
    };
}
