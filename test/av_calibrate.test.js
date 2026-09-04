// A/V auto-calibration tests — the offset sweep that picks the av-offset
// maximizing matched notes (the harness objective, in-app). Pure function,
// so we feed synthetic offset-free detections with a known true offset and
// assert it's recovered, plus robustness to off-pitch noise and thin data.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// Standard 4-string bass: string 1 (A1) fret 5 -> MIDI 38 (D2) — matches the
// real Gasoline / Why'd-You-Only-Call data (s=1 f=5 -> expected 38).
function bassGeom() { return { arrangement: 'bass', stringCount: 4, offsets: [0, 0, 0, 0], capo: 0 }; }

test('recovers a known +60 ms A/V offset from offset-free detections', () => {
    const core = loadDetectionCore();
    const trueMs = 60, off = trueMs / 1000;
    const notes = [], dets = [];
    for (let i = 0; i < 40; i++) {
        const t = 1 + i * 0.4;
        notes.push({ t, s: 1, f: 5 });
        dets.push({ bt: t - off, m: 38 });   // judged_t = bt + off === t at the true offset
    }
    const r = core.calibrateOffsetMs(dets, notes, bassGeom(), 0.1, 60, { stepMs: 5 });
    assert.ok(r, 'returns a result');
    assert.equal(r.matched, 40, 'matches every note at the right offset');
    assert.ok(Math.abs(r.offsetMs - trueMs) <= 5, `offsetMs ${r.offsetMs} ≈ ${trueMs}`);
});

test('recovers a negative offset and ignores off-pitch detections', () => {
    const core = loadDetectionCore();
    const trueMs = -80, off = trueMs / 1000;
    const notes = [], dets = [];
    for (let i = 0; i < 30; i++) {
        const t = 1 + i * 0.5;
        notes.push({ t, s: 1, f: 5 });
        dets.push({ bt: t - off, m: 38 });        // correct
        dets.push({ bt: t - off, m: 41 });        // +300c (not an octave) — must NOT match
    }
    const r = core.calibrateOffsetMs(dets, notes, bassGeom(), 0.1, 60, { stepMs: 5 });
    assert.ok(r);
    assert.equal(r.matched, 30, 'off-pitch detections do not inflate the match count');
    assert.ok(Math.abs(r.offsetMs - trueMs) <= 5, `offsetMs ${r.offsetMs} ≈ ${trueMs}`);
});

test('prefers the offset with more matches over a wrong-but-tempting one', () => {
    const core = loadDetectionCore();
    const notes = [], dets = [];
    // True offset 0: a detection at each note's time.
    for (let i = 0; i < 50; i++) { const t = 1 + i * 0.3; notes.push({ t, s: 1, f: 5 }); dets.push({ bt: t, m: 38 }); }
    // A decoy cluster shifted +150 ms that would match a handful if it won.
    for (let i = 0; i < 8; i++) { dets.push({ bt: 1 + i * 0.3 - 0.150, m: 38 }); }
    const r = core.calibrateOffsetMs(dets, notes, bassGeom(), 0.1, 60, { stepMs: 10 });
    assert.ok(r);
    assert.ok(Math.abs(r.offsetMs) <= 10, `picked the high-recall offset, got ${r.offsetMs}`);
});

test('returns null without enough evidence', () => {
    const core = loadDetectionCore();
    const r = core.calibrateOffsetMs([{ bt: 1, m: 38 }], [{ t: 1, s: 1, f: 5 }], bassGeom(), 0.1, 60, {});
    assert.equal(r, null);
});

// ── Lifecycle (reset / resume / once-per-play) ────────────────────────
// The sweep above is pure; these cover the song-event wiring that feeds it:
// a fresh play must reset the take (so a replay / stop-without-song:ended
// re-calibrates), a resume after pause must KEEP it, and pause must not run
// calibration (which would lock in a partial-take offset).

test('lifecycle: fresh play resets the take; resume after pause keeps it', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det._bindCalEvents();
    det._calSeedForTest(5);
    assert.equal(det._calState().detections, 5);
    // pause → play is a RESUME: the take is preserved.
    core.slopsmith._fire('song:pause', {});
    assert.equal(det._calState().paused, true);
    core.slopsmith._fire('song:play', {});
    assert.equal(det._calState().paused, false);
    assert.equal(det._calState().detections, 5, 'resume keeps the take');
    // a play NOT preceded by a pause is a FRESH start: the take is reset.
    core.slopsmith._fire('song:play', {});
    assert.equal(det._calState().detections, 0, 'fresh play resets the take');
    det.destroy();
});

test('lifecycle: pause does not calibrate or mark the take done', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det._bindCalEvents();
    det._calSeedForTest(5);
    core.slopsmith._fire('song:pause', {});
    const st = det._calState();
    assert.equal(st.done, false, 'pause must not mark the take calibrated');
    assert.equal(st.detections, 5, 'pause must not drop the take');
    assert.equal(st.paused, true);
    det.destroy();
});

test('lifecycle: song:loaded clears the take and the paused flag', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det._bindCalEvents();
    det._calSeedForTest(5);
    core.slopsmith._fire('song:pause', {});
    core.slopsmith._fire('song:loaded', { filename: 'x.archive' });
    const st = det._calState();
    assert.equal(st.detections, 0);
    assert.equal(st.done, false);
    assert.equal(st.paused, false);
    det.destroy();
});

test('lifecycle: binds loaded/play/ended/pause once; unbind removes all', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det._bindCalEvents();
    for (const ev of ['song:loaded', 'song:play', 'song:ended', 'song:pause'])
        assert.equal(core.slopsmith._listenerCount(ev), 1, ev);
    det._bindCalEvents(); // idempotent
    assert.equal(core.slopsmith._listenerCount('song:play'), 1, 'still one after re-bind');
    det._unbindCalEvents();
    for (const ev of ['song:loaded', 'song:play', 'song:ended', 'song:pause'])
        assert.equal(core.slopsmith._listenerCount(ev), 0, ev);
    det.destroy();
});

test('lifecycle: non-default instance never binds calibrate listeners', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector(); // isDefault:false
    det._bindCalEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 0, 'splitscreen panel does not calibrate');
    det.destroy();
});

// ── LIVE-ACCESSOR RULE regression (cut 5, strengthened after Creed r1) ──────
//
// Creed r1 proved TWO gaps in the original property-mutation-only test:
//
//   Mutation 1 — IIFE capture: `getHw: (() => { const c=hw; return ()=>c; })()`
//     Original test: mutates getNotes on the SAME object → still visible to
//     the captured reference → all tests green, yet the real contract breaks
//     (construct with window.highway=null, install after, enable → _calDebug()
//     notes:-1, logDetection throws null.getTime at av-calibrate.js:52).
//     Fixed by test (a) below: uses null-at-construction + enable() path.
//
//   Mutation 2 — omit getDetectPreference from DI:
//     No test drove runAutoCalibrate() far enough to call getDetectPreference()
//     → suite green, but det._runAutoCalibrate() throws TypeError immediately.
//     Fixed by test (b) below: fires song:ended which calls runAutoCalibrate()
//     through all three pre-sweep guards, including getDetectPreference().

// (a) null-at-construction liveness — mirrors hud_lazy_hw.test.js pattern.
//     IIFE-capture regression: hw=null captured forever → notes=-1 → RED.
//     Correct () => hw: resolveHw() during enable() updates hw → notes=3 → GREEN.
test('getHw: null at construction, hw installed before enable(), _calDebug reflects late stub', async () => {
    const noop = () => {};
    const audioNode = {
        connect: noop, disconnect: noop,
        gain: { value: 1 }, channelCount: 1,
        fftSize: 0, smoothingTimeConstant: 0,
        getFloatTimeDomainData: noop,
    };
    const fakeAudioCtx = {
        sampleRate: 44100, state: 'running', destination: {},
        createMediaStreamSource: () => audioNode,
        createGain:              () => audioNode,
        createAnalyser:          () => audioNode,
        createScriptProcessor:   () => audioNode,
    };
    const fakeStream = { getTracks: () => [] };

    // 1. Load with no highway in the sandbox.
    const core = loadDetectionCore({ sandboxBeforeRun: (sb) => { sb.highway = null; } });
    const sandboxRef = core._sandbox;

    // 2. Construct detector while hw=null (factory: let hw = window.highway || null → null).
    const det = sandboxRef.createNoteDetector({
        isDefault: true, audioStream: fakeStream, audioCtx: fakeAudioCtx,
    });

    // 3. Install highway stub AFTER construction — the meaningful moment.
    sandboxRef.highway = {
        getTime: () => 0, getAvOffset: () => 0,
        getNotes:         () => [1, 2, 3],
        getChords:        () => [],
        getFilteredNotes: () => [1, 2, 3],
        getFilteredChords: () => [],
        getSongInfo:      () => ({}), getStringCount: () => 6,
        isDefaultRenderer: () => true, hasPhraseData: () => false,
        getMastery:       () => 0, getSections: () => [],
        addDrawHook: noop, removeDrawHook: noop,
    };

    // 4. enable() → resolveHw() finds the stub → hw updated in factory closure.
    const ok = await det.enable();
    assert.ok(ok, 'enable() must succeed with the audio mock');

    // 5. _calDebug() calls getHw(); with live `() => hw`, hw is now the stub.
    //    With IIFE-captured null: notes=-1. With correct accessor: notes=3.
    assert.equal(det._calDebug().notes, 3,
        'getHw is live: _calDebug().notes must reflect the late-installed stub, not captured null');

    det.destroy();
});

// (b) DI-shape via pre-sweep guards: song:ended → runAutoCalibrate() reaches
//     getDetectPreference() (3rd guard). Missing getter → TypeError → RED.
//     With correct DI → guards pass, returns 'no window.setAvOffsetMs' → GREEN.
test('DI-shape: song:ended drives runAutoCalibrate through getDetectPreference without throw', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det._bindCalEvents();
    // song:ended → _calOnEnded → runAutoCalibrate() → getDetectPreference() (3rd guard)
    // → returns 'no window.setAvOffsetMs' (setAvOffsetMs absent in vm) without throwing.
    // Missing getDetectPreference: TypeError propagates through _fire → test fails.
    assert.doesNotThrow(
        () => core.slopsmith._fire('song:ended', {}),
        'all DI getters must be callable via song:ended → runAutoCalibrate (incl. getDetectPreference)'
    );
    assert.equal(det._calState().done, false,
        'done stays false when setAvOffsetMs absent (sweep guard fires before _calDoneThisPlay = true)');
    det.destroy();
});

// (c) DI-shape via completed sweep: exercises all 6 sweep-accessor DI params
//     (getCurrentArrangement, getCurrentStringCount, getTuningOffsets, getCapo,
//     getTimingHitThreshold, getPitchTolerance) plus calibrationNotes and
//     calibrateOffsetMs. Creed r2: deleting getCapo kept all tests green.
//
//     Recipe: guitar string 0 fret 0 = E2 = MIDI 40; _calSeedForTest seeds m:40.
//     At offset 0 ms all 12 detections land exactly at their note times → sweep
//     returns {offsetMs:0, matched:12, total:12} → setAvOffsetMs called → done=true.
//
//     With any missing sweep accessor: TypeError during _ndCalibrateOffsetMs
//     geometry construction or sweep → runAutoCalibrate returns early → done=false →
//     assert fails (RED).
test('DI-shape: completed sweep exercises all 6 sweep-accessor DI params (Creed r2 — getCapo)', () => {
    const core = loadDetectionCore();
    const sandboxRef = core._sandbox;

    // Install setAvOffsetMs spy BEFORE creating detector (otherwise the setAvOffsetMs
    // guard in runAutoCalibrate fires and the sweep never runs).
    let calledWithMs;
    sandboxRef.setAvOffsetMs = (ms) => { calledWithMs = ms; };

    const det = core.createNoteDetector({ isDefault: true });

    // 12 chart notes: guitar string 0 fret 0 → MIDI 40 (matches seeded m:40).
    // hw already present (standard loadDetectionCore), so hw is non-null; override
    // getFilteredNotes so _ndCalibrationNotes() returns these 12 notes.
    const chartNotes = Array.from({ length: 12 }, (_, i) => ({ t: i, s: 0, f: 0 }));
    core.highway.getFilteredNotes = () => chartNotes;

    // Seed 12 detections: { bt:i, m:40 } for i=0..11. At offset 0 ms:
    //   bt + 0 = i = note.t → matched; |_ndNearestOctaveCents(40,40)|=0 < 50 cents.
    det._calSeedForTest(12);

    // Fire the sweep directly (no audio pipeline needed).
    det._runAutoCalibrate();

    // If any sweep DI accessor is missing (e.g. getCapo deleted): calibrateOffsetMs
    // throws TypeError building the geom object → caught → done stays false → RED.
    assert.equal(det._calState().done, true,
        'sweep must complete: _calDoneThisPlay=true after a 12/12 note match');
    assert.equal(typeof calledWithMs, 'number',
        'setAvOffsetMs must be called with a number (sweep result.offsetMs)');

    det.destroy();
});
