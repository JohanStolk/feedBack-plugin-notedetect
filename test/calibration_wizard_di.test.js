// Null-at-construction DI regression tests for createCalibrationWizard
// (nd-carve-8 cut 8).
//
// Contract: every mutable factory dep is an accessor read LIVE at call time,
// never captured at construction. Proof pattern — object-swap:
//   1. Construct with accessor-A returning value-A.
//   2. Swap accessor-A to return value-B.
//   3. Call the API that reads that dep.
//   4. Assert value-B is observed (captured = still sees value-A → test fails).
//
// BINDING NOTE 2 — timer + listener hygiene test is test 1 below.
//
// 24 live accessors + 5 write-back callbacks total.
//
//   TESTED HERE (14 live accessors via getCalibrationSnapshot()):
//     getEnabled, getDiagCatalog, getInputLevel, getInputPeak,
//     getLatencyOffset, getHits, getMisses, getDetectionMethod,
//     getDetectedMidi, getDetectedConfidence, getDetectedString,
//     getDetectedDisplayMidi, getDetectionConfidenceMin, getSelectedChannel
//
//   TESTED HERE (write-back callbacks via launchCalibration + internal paths):
//     setCurrentArrangement  — launchCalibration({ instrument }) forces arrangement
//
//   HONEST GAPS (10 live accessors — require DOM interaction or full audio chain):
//     getInputGain          — read in _calWizardStartSignalCapture (signal-step
//                             auto-capture) and _calWizardBuildSafeRecommendations;
//                             requires DOM + signal-step flow.
//     getAudioCtx           — read inside _calWizardWizardAudioApi() and the
//                             step-1 render guard; reaching it needs the wizard open
//                             at step 1 with DOM interaction.
//     getBridgeSampleRate   — read in getCalibrationSnapshot() only when AudioContext
//                             sampleRate is absent; stubbing AudioContext.sampleRate
//                             shadows this. Declared honest gap.
//     getBridgeDesktop      — read inside _calWizardWizardAudioApi(), only when
//                             getUsingDesktopBridge() is true; needs real bridge stub.
//     getSelectedDeviceId   — read inside _calWizardAutoDetectInputChannel() which
//                             is triggered by a DOM button click at step 1.
//     getUsingDesktopBridge — same function; also the renderCalibrationWizard step-1
//                             engine-ok guard; needs DOM render at step 1.
//     getCurrentArrangement — read in _calWizardResolveNoteCheckContext, called from
//                             step-4 note-check timer; needs DOM + play flow.
//     getCurrentStringCount — same path.
//     getTuningOffsets      — same path.
//     getEngineInputGain    — read in _calWizardStartSignalCapture; DOM + step-4 flow.
//
//   WRITE-BACK GAPS (4 callbacks — need DOM flow to exercise):
//     setInputGain          — exercised in _calWizardApplySafeSettings at step 8 apply.
//     setLatencyOffset      — same step.
//     setEngineInputGain    — same step.
//     setSelectedChannel    — exercised in _calWizardApplyEngineInputChannel, called
//                             from _calWizardAutoDetectInputChannel (DOM step 1 button).
//
//   STABLE (not live accessors — correctly captured at construction):
//     resolveHw, enable, saveSettings, applyEngineGain, openInputSource,
//     closeInputSource, syncChartFromHw, resetCalibrationSamples, ndSetEngineGain,
//     ndResolveAudioBridge, ndMidiToName, ndMidiFromStringFret, ndStandardMidiFor,
//     ndNearestOctaveCents, ndFormatMs, ndEscapeHtml, ndHealthDetectedLine,
//     ndHealthInputChannelLabel, ndHealthDetectorPathLabel, formatLevel,
//     calRequester, restartAudio, openCalibrationLab.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

// ── vm loader ─────────────────────────────────────────────────────────────────
// Runs calibration-wizard.js in an isolated vm context with NO factory globals —
// all mutable deps must come through DI.
function loadModule(ctxOverrides = {}) {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'calibration-wizard.js'), 'utf8');
    // Strip export keywords so declarations are plain vm-local.
    const stripped = src.replace(/^export\s+/gm, '');

    const windowOverride = ctxOverrides.window || {};
    delete ctxOverrides.window;

    // Minimal DOM element stub: supports innerHTML, style, querySelector chain.
    function makeEl() {
        const el = {
            className: '', innerHTML: '', textContent: '', value: '',
            style: {}, dataset: {}, isConnected: true,
            onclick: null, onchange: null,
            appendChild:       () => {},
            remove:            () => {},
            closest:           () => null,
            querySelector:     () => makeEl(),
            querySelectorAll:  () => [],
        };
        return el;
    }

    const ctx = vm.createContext({
        Date, Math, JSON, Error, Array, Map, Set, Promise, console,
        Number, Boolean, String, Object, parseInt, parseFloat, isFinite,
        undefined,
        setTimeout:    (fn) => { fn(); return 0; },
        clearTimeout:  () => {},
        setInterval:   () => 0,
        clearInterval: () => {},
        document: {
            createElement: () => makeEl(),
            body: {
                appendChild:      () => {},
                querySelector:    () => makeEl(),
                querySelectorAll: () => [],
            },
        },
        window: {
            slopsmith: { on: () => {}, off: () => {}, isPlaying: false },
            feedBack: { on: () => {}, off: () => {} },
            tuner: null,
            ...windowOverride,
        },
        ...ctxOverrides,
    });

    vm.runInContext(stripped, ctx);
    const { createCalibrationWizard } = vm.runInContext('({ createCalibrationWizard })', ctx);
    return { createCalibrationWizard };
}

// ── Minimal stub factories ─────────────────────────────────────────────────────
function makeDiagStub() {
    return {
        buildDiagnosticPayload: () => ({
            timing_error_ms_hits: { median: null },
        }),
        resetTimingErrors: () => {},
    };
}

function makeHwStub() {
    return {
        getAvOffset: () => null,
        getTime: () => 0,
        getSongInfo: () => ({}),
    };
}

function makeAcc(overrides = {}) {
    return {
        // Live accessors
        getInputLevel:            () => 0,
        getInputPeak:             () => 0,
        getDetectedMidi:          () => -1,
        getDetectedConfidence:    () => 0,
        getDetectedString:        () => -1,
        getDetectedDisplayMidi:   () => -1,
        getDetectionConfidenceMin:() => 0.7,
        getLatencyOffset:         () => 0,
        getInputGain:             () => 1,
        getEngineInputGain:       () => 1,
        getEnabled:               () => false,
        getUsingDesktopBridge:    () => false,
        getAudioCtx:              () => null,
        getBridgeSampleRate:      () => null,
        getBridgeDesktop:         () => null,
        getSelectedDeviceId:      () => null,
        getSelectedChannel:       () => -1,
        getCurrentArrangement:    () => 'guitar',
        getCurrentStringCount:    () => 6,
        getTuningOffsets:         () => [0, 0, 0, 0, 0, 0],
        getHits:                  () => 0,
        getMisses:                () => 0,
        getDetectionMethod:       () => 'yin',
        // getLevelSamples: removed — unused DI param dropped in nd-carve-8
        getDiagCatalog:           () => makeDiagStub(),
        // Write-back callbacks
        setInputGain:             () => {},
        setLatencyOffset:         () => {},
        setEngineInputGain:       () => {},
        setCurrentArrangement:    () => {},
        setSelectedChannel:       () => {},
        // Stable fn refs
        resolveHw:                () => makeHwStub(),
        enable:                   () => {},
        saveSettings:             () => {},
        applyEngineGain:          () => {},
        openInputSource:          () => {},
        closeInputSource:         () => {},
        syncChartFromHw:          () => {},
        resetCalibrationSamples:  () => {},
        ndSetEngineGain:          () => {},
        ndResolveAudioBridge:     () => null,
        ndMidiToName:             (m) => `N${m}`,
        ndMidiFromStringFret:     () => 40,
        ndStandardMidiFor:        () => 40,
        ndNearestOctaveCents:     () => 0,
        ndFormatMs:               (ms) => `${ms}ms`,
        ndEscapeHtml:             (s) => s,
        ndHealthDetectedLine:     () => '—',
        ndHealthInputChannelLabel:() => 'mono',
        ndHealthDetectorPathLabel:() => 'yin',
        formatLevel:              (l, p) => `${l||0}%`,
        calRequester:             'note_detect:calibration',
        restartAudio:             () => {},
        openCalibrationLab:       () => {},
        ...overrides,
    };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

// ── Stable-selector DOM factory for hygiene tests ──────────────────────────────
// Elements returned by querySelector(selector) are stable (same ref for same selector
// on the same element), so onclick handlers set by renderCalibrationWizard() are
// callable from the test. Used only in the hygiene tests.
function makeStableEl() {
    const kids = new Map();
    const el = {
        className: '', innerHTML: '', textContent: '', value: '',
        style: {}, dataset: {}, isConnected: true,
        onclick: null, onchange: null,
        appendChild: () => {},
        remove: () => {},
        closest: () => null,
        getAttribute: () => null,
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        querySelectorAll: () => [],
        querySelector(sel) {
            if (!kids.has(sel)) kids.set(sel, makeStableEl());
            return kids.get(sel);
        },
    };
    return el;
}

// 1. BINDING NOTE 2 — timer + listener hygiene after calibrationWizardClose().
//    Three discriminating parts:
//    A) _calWizardTick setInterval cleared on minimal open→close.
//    B) song:play handler removed by close() when play-along was in 'waiting' phase.
//       Red-proof: removing slopsmith.off from _calWizardTeardownPlayAlongWait leaves
//       songPlayHandlers.length === 1 instead of 0 → assertion fails.
//    C) _calWizardPauseRetryTimers cleared by close() after a full play-along cycle.
//       Red-proof: removing _calWizardClearPauseRetries() from calibrationWizardClose()
//       leaves timeouts map with pause-retry IDs → assertion fails.

// Part A: tick interval cleared on minimal open→close.
test('hygiene(A): setInterval tick cleared on close (minimal open flow)', () => {
    const intervals = new Map();
    let nextIId = 1;

    const { createCalibrationWizard } = loadModule({
        setInterval:   (fn, ms) => { const id = nextIId++; intervals.set(id, fn); return id; },
        clearInterval: (id)     => { intervals.delete(id); },
    });

    const wiz = createCalibrationWizard(makeAcc());
    wiz.openCalibrationWizard();
    assert.ok(intervals.size > 0,
        'openCalibrationWizard() must register at least one setInterval (tick)');

    wiz.calibrationWizardClose();
    assert.equal(intervals.size, 0,
        'calibrationWizardClose() must clear all setInterval handles');
});

// Part B: song:play handler removed by close() when play-along waiting.
test('hygiene(B): close() removes song:play handler registered by timed play-along start', () => {
    const intervals = new Map();
    const timeouts = new Map();
    let nextIId = 1, nextTId = 1;
    const songPlayHandlers = [];
    const slop = {
        on:  (ev, fn) => { if (ev === 'song:play') songPlayHandlers.push(fn); },
        off: (ev, fn) => {
            if (ev !== 'song:play') return;
            const idx = songPlayHandlers.indexOf(fn);
            if (idx !== -1) songPlayHandlers.splice(idx, 1);
        },
        isPlaying: false,
    };

    // Track the overlay element created by document.createElement so we can
    // navigate to step-6 button onclicks.
    let overlay = null;

    const { createCalibrationWizard } = loadModule({
        setInterval:   (fn, ms) => { const id = nextIId++; intervals.set(id, fn); return id; },
        clearInterval: (id)     => { intervals.delete(id); },
        setTimeout:    (fn, ms) => { const id = nextTId++; timeouts.set(id, fn); return id; },
        clearTimeout:  (id)     => { timeouts.delete(id); },
        document: {
            createElement: () => { overlay = makeStableEl(); return overlay; },
            body: { appendChild: () => {}, querySelector: () => makeStableEl(), querySelectorAll: () => [] },
        },
        window: { slopsmith: slop, feedBack: { on: () => {}, off: () => {} }, tuner: null },
    });

    const wiz = createCalibrationWizard(makeAcc({ getEnabled: () => true }));
    wiz.openCalibrationWizard();

    // Advance to step 6 (timing step) — Next ×6, no guards in calibrationWizardNext().
    for (let i = 0; i < 6; i++) wiz.calibrationWizardNext();

    // Step-6 renderCalibrationWizard sets body.querySelector('[data-cal-start-playalong]').onclick.
    const startBtn = overlay.querySelector('.nd-cal-body').querySelector('.nd-cal-start-playalong');
    assert.ok(typeof startBtn.onclick === 'function',
        'step-6 render must set .nd-cal-start-playalong.onclick');

    // Invoke — _calWizardStartTimedPlayAlong: isPlaying=false → registers song:play handler.
    slop.isPlaying = false;
    startBtn.onclick();
    assert.equal(songPlayHandlers.length, 1,
        '_calWizardStartTimedPlayAlong must register exactly one song:play handler');

    // Close WITHOUT emitting song:play — close() must unregister the waiting handler.
    wiz.calibrationWizardClose();
    assert.equal(songPlayHandlers.length, 0,
        'calibrationWizardClose() must remove the song:play handler via _calWizardTeardownPlayAlongWait');
    // Red proof: if slopsmith.off is removed from _calWizardTeardownPlayAlongWait,
    // songPlayHandlers still has 1 entry → this assertion fails.
});

// Part C: _calWizardPauseRetryTimers cleared by close() after a full play-along duration cycle.
test('hygiene(C): _calWizardClearPauseRetries clears pause-retry setTimeout IDs on close', () => {
    const intervals = new Map();
    const timeouts = new Map();
    let nextIId = 1, nextTId = 1;
    const songPlayHandlers = [];
    const slop = {
        on:  (ev, fn) => { if (ev === 'song:play') songPlayHandlers.push(fn); },
        off: (ev, fn) => {
            if (ev !== 'song:play') return;
            const idx = songPlayHandlers.indexOf(fn);
            if (idx !== -1) songPlayHandlers.splice(idx, 1);
        },
        isPlaying: false,
    };

    let overlay = null;

    const { createCalibrationWizard } = loadModule({
        setInterval:   (fn, ms) => { const id = nextIId++; intervals.set(id, fn); return id; },
        clearInterval: (id)     => { intervals.delete(id); },
        setTimeout:    (fn, ms) => { const id = nextTId++; timeouts.set(id, fn); return id; },
        clearTimeout:  (id)     => { timeouts.delete(id); },
        document: {
            createElement: () => { overlay = makeStableEl(); return overlay; },
            body: { appendChild: () => {}, querySelector: () => makeStableEl(), querySelectorAll: () => [] },
        },
        window: { slopsmith: slop, feedBack: { on: () => {}, off: () => {} }, tuner: null },
    });

    const wiz = createCalibrationWizard(makeAcc({ getEnabled: () => true }));
    wiz.openCalibrationWizard();
    for (let i = 0; i < 6; i++) wiz.calibrationWizardNext();

    // Start play-along: isPlaying=false → wasPlayingAtArm=false, registers song:play.
    slop.isPlaying = false;
    overlay.querySelector('.nd-cal-body').querySelector('.nd-cal-start-playalong').onclick();
    assert.equal(songPlayHandlers.length, 1, 'play-along waiting: song:play registered');

    // Emit song:play → onPlayHandler → playbackSeen=true → _calWizardPollPlayAlongWait
    // → _calWizardBeginTimedPlayAlongCountdown (phase→running, unregisters song:play,
    //   sets pa.timerId + pa.intervalId via deferred setTimeout/setInterval).
    slop.isPlaying = true;
    songPlayHandlers[0](); // fire the waiting handler

    assert.equal(songPlayHandlers.length, 0,
        '_calWizardBeginTimedPlayAlongCountdown must unregister song:play handler');

    // pa.timerId is now in timeouts (deferred, not yet fired). It is the largest key
    // because waitTimeoutId was already cleared by _calWizardTeardownPlayAlongWait.
    assert.ok(timeouts.size > 0, 'play-along countdown must have pending timeouts');
    const durationTimerId = Math.max(...timeouts.keys());

    // Fire the duration timer → _calWizardFinishTimedPlayAlong(false)
    // → _calWizardMaybePauseAfterTimedPlayAlong({ wasPlayingAtArm: false })
    // → isPlaying=true → pushes setTimeout IDs to _calWizardPauseRetryTimers.
    const durationCb = timeouts.get(durationTimerId);
    timeouts.delete(durationTimerId); // simulate clearTimeout call from _calWizardStopTimedPlayAlong
    durationCb();

    // _CAL_WIZARD_PAUSE_RETRY_DELAYS_MS has 6 entries → 6 new deferred timeouts.
    const retryIds = new Set(timeouts.keys());
    assert.ok(retryIds.size >= 1,
        '_calWizardMaybePauseAfterTimedPlayAlong must have registered at least one pause-retry timer');

    // close() → _calWizardClearPauseRetries() → clearTimeout for each retry ID → removes from map.
    wiz.calibrationWizardClose();
    for (const id of retryIds) {
        assert.ok(!timeouts.has(id),
            `pause-retry timer ${id} must be cleared by calibrationWizardClose() via _calWizardClearPauseRetries`);
    }
    // Red proof: if _calWizardClearPauseRetries() is removed from calibrationWizardClose(),
    // timeouts still contains all retryIds → the assertions above fail.
});

// 4. Review key-mismatch regression (Creed r1 on cut 8).
//    Bug introduced by mechanical DI substitution: consider('getLatencyOffset()', ...)
//    → data-key="getLatencyOffset()" in the review checkbox → unchecking writes
//    applyChecked['getLatencyOffset()'] = false while applyChecked.latencyOffset
//    stays true → setLatencyOffset fires anyway.
//    Fix: consider('latencyOffset', ...).
//
//    Two discriminating tests:
//    4a: step-7 renders data-key="latencyOffset" in the checkbox HTML.
//        Red-proof against c1be48e: data-key="getLatencyOffset()" → assertion fails.
//    4b: uncheck latency via realistic onchange path → setLatencyOffset not called;
//        leave checked → called with 0.05.
//        Red-proof against c1be48e (bug): onchange writes applyChecked['getLatencyOffset()'],
//        applyChecked.latencyOffset stays true → setLatencyOffset fires → assert.equal(calls,0) fails.

// Helper: create an intercepting body element whose innerHTML setter captures
// the data-key value from rendered .nd-cal-apply-chk checkboxes, and whose
// querySelectorAll('.nd-cal-apply-chk') returns a mock checkbox wired to that key.
function makeInterceptingBodyAndCheckbox() {
    let checkboxKey = null;
    const mockChk = {
        getAttribute: (attr) => attr === 'data-key' ? checkboxKey : null,
        checked: true,
        onchange: null,
    };
    const bodyKids = new Map();
    const bodyEl = {
        className: '', textContent: '', value: '', style: {}, dataset: {},
        isConnected: true, onclick: null, onchange: null,
        appendChild: () => {}, remove: () => {}, closest: () => null,
        getAttribute: () => null,
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        get innerHTML() { return this._html || ''; },
        set innerHTML(v) {
            this._html = v;
            // capture the data-key attribute from the first rendered checkbox
            const m = v.match(/nd-cal-apply-chk[^>]*?data-key="([^"]+)"/);
            checkboxKey = m ? m[1] : null;
        },
        querySelectorAll(sel) {
            if (sel === '.nd-cal-apply-chk') return [mockChk];
            return [];
        },
        querySelector(sel) {
            if (!bodyKids.has(sel)) bodyKids.set(sel, makeStableEl());
            return bodyKids.get(sel);
        },
    };
    return { bodyEl, mockChk, getCheckboxKey: () => checkboxKey };
}

test('review key mismatch (4a): step-7 renders data-key="latencyOffset" not the accessor call string', () => {
    const { bodyEl, getCheckboxKey } = makeInterceptingBodyAndCheckbox();

    // Overlay element pre-wires bodyEl into .nd-cal-body slot
    const overlayKids = new Map();
    overlayKids.set('.nd-cal-body', bodyEl);
    const overlayEl = {
        ...makeStableEl(),
        querySelector(sel) {
            if (!overlayKids.has(sel)) overlayKids.set(sel, makeStableEl());
            return overlayKids.get(sel);
        },
    };

    // timingMedianMs=100, latencyOffset=0 → recommendation: latencyOffset=0.05
    const diagStub = {
        buildDiagnosticPayload: () => ({ timing_error_ms_hits: { median: 100, count: 30 } }),
        resetTimingErrors: () => {},
    };

    const { createCalibrationWizard } = loadModule({
        document: {
            createElement: () => overlayEl,
            body: { appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [] },
        },
    });

    const wiz = createCalibrationWizard(makeAcc({
        getEnabled:       () => true,
        getLatencyOffset: () => 0,
        getDiagCatalog:   () => diagStub,
    }));

    wiz.openCalibrationWizard();
    for (let i = 0; i < 7; i++) wiz.calibrationWizardNext();

    // step-7 renders review checkboxes; inspect captured data-key
    assert.equal(getCheckboxKey(), 'latencyOffset',
        'step-7 must render data-key="latencyOffset" — not the DI-accessor call string');
    // Red-proof: c1be48e has consider("getLatencyOffset()", ...) → data-key="getLatencyOffset()" → fails
});

test('review key mismatch (4b): uncheck latency → setLatencyOffset not called; leave checked → called', () => {
    // PART A: uncheck → NOT called
    const { bodyEl: bodyA, mockChk: chkA, getCheckboxKey: keyA } = makeInterceptingBodyAndCheckbox();
    const overlayKidsA = new Map();
    overlayKidsA.set('.nd-cal-body', bodyA);
    const overlayA = { ...makeStableEl(), querySelector(s) { if (!overlayKidsA.has(s)) overlayKidsA.set(s, makeStableEl()); return overlayKidsA.get(s); } };

    let createsA = 0;
    const diagStub = {
        buildDiagnosticPayload: () => ({ timing_error_ms_hits: { median: 100, count: 30 } }),
        resetTimingErrors: () => {},
    };
    const latencyCallsA = [];

    const { createCalibrationWizard: cwA } = loadModule({
        document: { createElement: () => overlayA, body: { appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [] } },
    });

    const wizA = cwA(makeAcc({
        getEnabled:       () => true,
        getLatencyOffset: () => 0,
        getDiagCatalog:   () => diagStub,
        setLatencyOffset: (v) => { latencyCallsA.push(v); },
    }));

    wizA.openCalibrationWizard();
    for (let i = 0; i < 7; i++) wizA.calibrationWizardNext();  // → step 7

    // step-7 wires chkA.onchange via querySelectorAll; simulate uncheck
    assert.equal(typeof chkA.onchange, 'function', 'chkA.onchange must be wired after step-7 render');
    chkA.checked = false;
    chkA.onchange();  // writes applyChecked[key] = false

    wizA.calibrationWizardNext();  // → step 8

    // click Apply Recommended Settings
    bodyA.querySelector('.nd-cal-apply-safe').onclick();

    assert.equal(latencyCallsA.length, 0,
        'unchecked latency: setLatencyOffset must NOT fire (key mismatch would leave applyChecked.latencyOffset=true)');
    // Red-proof: c1be48e → chkA.onchange writes applyChecked["getLatencyOffset()"],
    // applyChecked.latencyOffset stays true → setLatencyOffset fires → latencyCallsA.length===1 → fails

    // PART B: leave checked (default) → MUST be called with 0.05
    const { bodyEl: bodyB, mockChk: chkB } = makeInterceptingBodyAndCheckbox();
    const overlayKidsB = new Map();
    overlayKidsB.set('.nd-cal-body', bodyB);
    const overlayB = { ...makeStableEl(), querySelector(s) { if (!overlayKidsB.has(s)) overlayKidsB.set(s, makeStableEl()); return overlayKidsB.get(s); } };
    const latencyCallsB = [];

    const { createCalibrationWizard: cwB } = loadModule({
        document: { createElement: () => overlayB, body: { appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [] } },
    });

    const wizB = cwB(makeAcc({
        getEnabled:       () => true,
        getLatencyOffset: () => 0,
        getDiagCatalog:   () => diagStub,
        setLatencyOffset: (v) => { latencyCallsB.push(v); },
    }));

    wizB.openCalibrationWizard();
    for (let i = 0; i < 8; i++) wizB.calibrationWizardNext();  // step 7→8 without uncheck
    bodyB.querySelector('.nd-cal-apply-safe').onclick();

    assert.equal(latencyCallsB.length, 1,
        'checked latency (default): setLatencyOffset must be called exactly once');
    assert.equal(latencyCallsB[0], 0.05,
        'setLatencyOffset must receive the recommended value: 0.05 (delta=100ms*0.5=0.05s)');
});

// 2. getEnabled() — live in getCalibrationSnapshot() → snap.enabled
test('getEnabled() live: snapshot.enabled reflects swapped value', () => {
    const { createCalibrationWizard } = loadModule();
    let enabled = false;
    const wiz = createCalibrationWizard(makeAcc({ getEnabled: () => enabled }));

    assert.equal(wiz.getCalibrationSnapshot().enabled, false,
        'baseline: enabled must be false');

    enabled = true;
    assert.equal(wiz.getCalibrationSnapshot().enabled, true,
        'must read getEnabled() live — captured would still be false');
});

// 3. getDiagCatalog() — live in getCalibrationSnapshot() → calls buildDiagnosticPayload()
test('getDiagCatalog() live: snapshot.diagnostic comes from swapped catalog', () => {
    const { createCalibrationWizard } = loadModule();
    const catA = { buildDiagnosticPayload: () => ({ _source: 'A', timing_error_ms_hits: {} }), resetTimingErrors: () => {} };
    const catB = { buildDiagnosticPayload: () => ({ _source: 'B', timing_error_ms_hits: {} }), resetTimingErrors: () => {} };
    let catalog = catA;

    const wiz = createCalibrationWizard(makeAcc({ getDiagCatalog: () => catalog }));

    assert.equal(wiz.getCalibrationSnapshot().diagnostic._source, 'A',
        'baseline: diagnostic must come from catA');

    catalog = catB;
    assert.equal(wiz.getCalibrationSnapshot().diagnostic._source, 'B',
        'must read getDiagCatalog() live — captured would still return catA');
});

// 4. getInputLevel() — live in getCalibrationSnapshot() → inputLevelPct
test('getInputLevel() live: snapshot.inputLevelPct reflects swapped value', () => {
    const { createCalibrationWizard } = loadModule();
    let level = 0;
    const wiz = createCalibrationWizard(makeAcc({ getInputLevel: () => level }));

    assert.equal(wiz.getCalibrationSnapshot().inputLevelPct, 0, 'baseline');

    level = 0.65;
    assert.equal(wiz.getCalibrationSnapshot().inputLevelPct, 65,
        'must read getInputLevel() live (live: 65%, captured: 0%)');
});

// 5. getInputPeak() — live in getCalibrationSnapshot() → inputPeakPct
test('getInputPeak() live: snapshot.inputPeakPct reflects swapped value', () => {
    const { createCalibrationWizard } = loadModule();
    let peak = 0;
    const wiz = createCalibrationWizard(makeAcc({ getInputPeak: () => peak }));

    assert.equal(wiz.getCalibrationSnapshot().inputPeakPct, 0, 'baseline');

    peak = 0.80;
    assert.equal(wiz.getCalibrationSnapshot().inputPeakPct, 80,
        'must read getInputPeak() live');
});

// 6. getLatencyOffset() — live in getCalibrationSnapshot() → latencyOffsetMs
test('getLatencyOffset() live: snapshot.latencyOffsetMs reflects swapped value', () => {
    const { createCalibrationWizard } = loadModule();
    let offset = 0;
    const wiz = createCalibrationWizard(makeAcc({ getLatencyOffset: () => offset }));

    assert.equal(wiz.getCalibrationSnapshot().latencyOffsetMs, 0, 'baseline');

    offset = 0.05; // 50ms
    assert.equal(wiz.getCalibrationSnapshot().latencyOffsetMs, 50,
        'must read getLatencyOffset() live (live: 50ms, captured: 0ms)');
});

// 7. getHits() + getMisses() — live in getCalibrationSnapshot() → stats
test('getHits()/getMisses() live: snapshot.stats reflects swapped values', () => {
    const { createCalibrationWizard } = loadModule();
    let hits = 0, misses = 0;
    const wiz = createCalibrationWizard(makeAcc({
        getHits:   () => hits,
        getMisses: () => misses,
    }));

    let snap = wiz.getCalibrationSnapshot();
    assert.equal(snap.stats.hits, 0, 'baseline hits');
    assert.equal(snap.stats.total, 0, 'baseline total');
    assert.equal(snap.stats.accuracy, null, 'baseline accuracy: null when total=0');

    hits = 9; misses = 1;
    snap = wiz.getCalibrationSnapshot();
    assert.equal(snap.stats.hits, 9,  'live hits must be 9');
    assert.equal(snap.stats.total, 10, 'live total must be 10');
    assert.equal(snap.stats.accuracy, 90, 'live accuracy must be 90%');
});

// 8. getDetectionMethod() — live in getCalibrationSnapshot() → method
test('getDetectionMethod() live: snapshot.method reflects swapped value', () => {
    const { createCalibrationWizard } = loadModule();
    let method = 'yin';
    const wiz = createCalibrationWizard(makeAcc({ getDetectionMethod: () => method }));

    assert.equal(wiz.getCalibrationSnapshot().method, 'yin', 'baseline');

    method = 'crepe';
    assert.equal(wiz.getCalibrationSnapshot().method, 'crepe',
        'must read getDetectionMethod() live');
});

// 9. getDetectedMidi() + getDetectedConfidence() + getDetectionConfidenceMin() —
//    live in getCalibrationSnapshot() → rawMidi via _calWizardRawPitchFields()
test('getDetectedMidi() live: snapshot.rawMidi reflects swapped value when confidence passes', () => {
    const { createCalibrationWizard } = loadModule();
    let midi = -1, confidence = 0.9, confMin = 0.7;
    const wiz = createCalibrationWizard(makeAcc({
        getDetectedMidi:           () => midi,
        getDetectedConfidence:     () => confidence,
        getDetectionConfidenceMin: () => confMin,
    }));

    // confidence (0.9) > confMin (0.7) → confOk = true; but midi < 0 → rawMidi = null
    assert.equal(wiz.getCalibrationSnapshot().rawMidi, null,
        'baseline: midi < 0 → rawMidi null');

    midi = 64; // E4
    assert.equal(wiz.getCalibrationSnapshot().rawMidi, 64,
        'must read getDetectedMidi() live — captured would still be -1');
});

// 10. getDetectedConfidence() — confidence gate for rawMidi
test('getDetectedConfidence() live: rawMidi gated on swapped confidence', () => {
    const { createCalibrationWizard } = loadModule();
    let midi = 64, confidence = 0.5, confMin = 0.7;
    const wiz = createCalibrationWizard(makeAcc({
        getDetectedMidi:           () => midi,
        getDetectedConfidence:     () => confidence,
        getDetectionConfidenceMin: () => confMin,
    }));

    // confidence (0.5) < confMin (0.7) → confOk = false → rawMidi = null
    assert.equal(wiz.getCalibrationSnapshot().rawMidi, null,
        'baseline: low confidence → rawMidi null');

    confidence = 0.9;
    assert.equal(wiz.getCalibrationSnapshot().rawMidi, 64,
        'must read getDetectedConfidence() live — captured at 0.5 would keep rawMidi null');
});

// 11. getDetectionConfidenceMin() — confidence threshold gate
test('getDetectionConfidenceMin() live: rawMidi gated on swapped threshold', () => {
    const { createCalibrationWizard } = loadModule();
    let midi = 64, confidence = 0.6, confMin = 0.7;
    const wiz = createCalibrationWizard(makeAcc({
        getDetectedMidi:           () => midi,
        getDetectedConfidence:     () => confidence,
        getDetectionConfidenceMin: () => confMin,
    }));

    // confidence (0.6) < confMin (0.7) → null
    assert.equal(wiz.getCalibrationSnapshot().rawMidi, null, 'baseline: confMin 0.7 blocks');

    confMin = 0.5; // lower threshold — now confidence passes
    assert.equal(wiz.getCalibrationSnapshot().rawMidi, 64,
        'must read getDetectionConfidenceMin() live — captured at 0.7 would still block');
});

// 12. getDetectedString() + getDetectedDisplayMidi() — displayHeardNote path
test('getDetectedString() + getDetectedDisplayMidi() live: displayHeardNote uses swapped values', () => {
    const { createCalibrationWizard } = loadModule();
    let detStr = -1, dispMidi = -1, midi = 64, conf = 0.9, confMin = 0.7;
    const wiz = createCalibrationWizard(makeAcc({
        getDetectedMidi:           () => midi,
        getDetectedConfidence:     () => conf,
        getDetectionConfidenceMin: () => confMin,
        getDetectedString:         () => detStr,
        getDetectedDisplayMidi:    () => dispMidi,
    }));

    // detectedString < 0 → displayHeardNote = null
    assert.equal(wiz.getCalibrationSnapshot().displayHeardNote, null,
        'baseline: detectedString < 0 → displayHeardNote null');

    detStr = 0; dispMidi = 68;
    const snap = wiz.getCalibrationSnapshot();
    // displayNote is set when detStr >= 0 and confOk; uses dispMidi if valid
    assert.notEqual(snap.displayHeardNote, null,
        'must read getDetectedString() live — captured at -1 would leave displayHeardNote null');
});

// 13. setCurrentArrangement() write-back — via launchCalibration({ instrument })
test('setCurrentArrangement() write-back: launchCalibration forced arrangement calls setCurrentArrangement', () => {
    const { createCalibrationWizard } = loadModule();
    const arrangements = [];
    const wiz = createCalibrationWizard(makeAcc({
        setCurrentArrangement: (v) => arrangements.push(v),
        // launchCalibration reads getEnabled() to decide whether to enable; keep it true
        // so it proceeds without trying to call enable().
        getEnabled: () => true,
    }));

    // launchCalibration with instrument forces currentArrangement.
    // opts.instrument is the arrangement name ('guitar'|'bass'), not a config id.
    wiz.launchCalibration({ instrument: 'bass' });

    assert.ok(arrangements.length > 0,
        'setCurrentArrangement must be called when instrument is forced');
    assert.equal(arrangements[arrangements.length - 1], 'bass',
        'forced bass instrument must write arrangement "bass" via setCurrentArrangement');
});

// 14. resolveHw() stable ref — getCalibrationSnapshot() calls it; hw.getAvOffset used for avOffsetMs
test('resolveHw() stable ref: snapshot.avOffsetMs comes from the hw returned by resolveHw', () => {
    const { createCalibrationWizard } = loadModule();
    let avMs = 42;
    const wiz = createCalibrationWizard(makeAcc({
        resolveHw: () => ({ getAvOffset: () => avMs, getTime: () => 0 }),
    }));

    assert.equal(wiz.getCalibrationSnapshot().avOffsetMs, 42, 'avOffsetMs must come from resolveHw()');

    avMs = 99;
    assert.equal(wiz.getCalibrationSnapshot().avOffsetMs, 99,
        'resolveHw() is called at snapshot time; the returned hw.getAvOffset() reflects the new value');
});
