// Null-at-construction DI regression tests for createRecordingCapture
// (nd-carve-7 cut 7).
//
// Contract: every mutable factory dep is an accessor read LIVE at call time,
// never captured at construction. Proof pattern — object-swap:
//   1. Construct with accessor-A returning value-A.
//   2. Swap accessor-A to return value-B.
//   3. Call the API that reads that dep.
//   4. Assert value-B is observed (captured = still sees value-A → test fails).
//
// Mutation proof: change any `getX()` call in recording-capture.js to a
// captured `const _x = getX()` at construction → the matching test fails.
// Revert → green.
//
// 20 DI params total:
//   TESTED HERE (8 live accessors):
//     getEnabled, getDiagCatalog, getTuningMode, getAutoRecord,
//     getDetectPreference, getHw, getUsingDesktopBridge, getSelectedDeviceId
//
//   HONEST GAPS (8 live accessors — getUserMedia or full song:ended chain):
//     getSelectedChannel   — read only inside _startParallelTrainingCapture()
//                            after getUserMedia succeeds (needs a live MediaStream).
//     getInputGain         — same; both are captured inside onaudioprocess closure
//                            that executes only once the stream+AudioContext are live.
//     getCurrentFilename   — read inside _buildAndUploadTrainingBundle() which
//                            is called asynchronously from _recOnEnded; wiring
//                            the full chain requires mocking fetch, _showTrainingConsentModal,
//                            and the slopsmith event system in strict serialisation.
//     getSummaryUi         — called in _recOnEnded after save; same chain.
//     getDetectionMethod, getLatencyOffset, getTimingTolerance,
//     getTimingHitThreshold, getPitchTolerance — all read inside the training-
//                            bundle metadata builder (_buildAndUploadTrainingBundle).
//                            Same full-chain requirement as getCurrentFilename.
//
//   STABLE (not live accessors — correctly captured at construction):
//     isDefault            — constant bool, intended capture, no test needed.
//     openInstrumentStream — factory-level function ref; documented stable.
//     getTrainingChartSnapshot — same.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

// ── vm loader ─────────────────────────────────────────────────────────────────
// Runs recording-capture.js in an isolated vm context with NO factory globals —
// all mutable deps must come through DI.  `emit` lets tests fire slopsmith events
// to drive the auto-record handler paths.
function loadModule(ctxOverrides = {}) {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'recording-capture.js'), 'utf8');
    // Strip export keywords so the declarations are plain vm-local.
    const stripped = src.replace(/^export\s+/gm, '');

    const handlers = {};
    const slop = {
        on:  (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
        off: (ev, fn) => {
            if (handlers[ev]) handlers[ev] = handlers[ev].filter(h => h !== fn);
        },
    };
    const emit = (ev, ...args) => (handlers[ev] || []).slice().forEach(h => h(...args));

    const base = {
        window: {
            slopsmith: slop,
            feedBack: { on: () => {}, off: () => {} },
            AudioContext: null,
            webkitAudioContext: null,
        },
        navigator: { mediaDevices: null },
        localStorage: { getItem: () => null, setItem: () => {} },
        fetch: () => Promise.resolve({
            ok: true, json: () => Promise.resolve({ relative_path: '/rec.wav' }),
        }),
        Date, Math, JSON, Error, Array, Map, Set, Promise, console,
        setTimeout: (fn) => { fn(); return 0; },  // fake-instant so armRecordingForTraining resolves
        clearTimeout: () => {},
        ArrayBuffer, DataView, Float32Array,       // needed by _ndEncodeWavPcm16
    };

    // ctxOverrides can replace top-level keys (e.g. fetch, navigator).
    // Merge nested window separately so a partial override doesn't wipe
    // the whole window object.
    const windowOverride = ctxOverrides.window || {};
    delete ctxOverrides.window;
    const ctx = vm.createContext({
        ...base,
        window: { ...base.window, ...windowOverride },
        ...ctxOverrides,
    });
    vm.runInContext(stripped, ctx);
    const { createRecordingCapture } = vm.runInContext('({ createRecordingCapture })', ctx);
    return { createRecordingCapture, emit };
}

// ── Minimal stubs ─────────────────────────────────────────────────────────────
function makeDiagStub() {
    return {
        setLiveLastSessionId: () => {},
        liveBindEvents:       () => {},
        liveUnbindEvents:     () => {},
        startLiveSession:     () => {},
        flushLiveJudgments:   () => Promise.resolve(),
    };
}

function makeAcc(overrides = {}) {
    return {
        getHw:                    () => null,
        getSelectedChannel:       () => 'mono',
        getSelectedDeviceId:      () => null,
        getInputGain:             () => 1,
        getLatencyOffset:         () => 0,
        getTuningMode:            () => false,
        getAutoRecord:            () => true,
        getDetectPreference:      () => true,
        isDefault:                true,
        getCurrentFilename:       () => '',
        getDiagCatalog:           () => makeDiagStub(),
        getSummaryUi:             () => ({ runDeferredSummary: () => {} }),
        getDetectionMethod:       () => 'yin',
        getTimingTolerance:       () => 0.1,
        getTimingHitThreshold:    () => 0.07,
        getPitchTolerance:        () => 50,
        getUsingDesktopBridge:    () => false,
        getEnabled:               () => false,
        openInstrumentStream:     () => Promise.resolve(null),
        getTrainingChartSnapshot: () => null,
        ...overrides,
    };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

// 1. getEnabled() — read live in getRecordingState()
test('getEnabled() live: detectEnabled field reflects swapped value', () => {
    const { createRecordingCapture } = loadModule();
    let enabled = false;
    const rec = createRecordingCapture(makeAcc({ getEnabled: () => enabled }));

    assert.equal(rec.getRecordingState().detectEnabled, false,
        'baseline: detectEnabled should be false');

    enabled = true;
    assert.equal(rec.getRecordingState().detectEnabled, true,
        'must read getEnabled() live — captured value would still be false');
});

// 2. getDiagCatalog() — discardRecording calls the swapped catalog's liveUnbindEvents
test('getDiagCatalog() live: discardRecording uses the swapped catalog', () => {
    const { createRecordingCapture } = loadModule();
    let catACalls = 0, catBCalls = 0;
    const catA = { ...makeDiagStub(), liveUnbindEvents: () => catACalls++ };
    const catB = { ...makeDiagStub(), liveUnbindEvents: () => catBCalls++ };
    let catalog = catA;

    const rec = createRecordingCapture(makeAcc({ getDiagCatalog: () => catalog }));
    rec.armRecording();

    // Swap BEFORE the call that reads the dep.
    catalog = catB;
    rec.discardRecording();

    assert.equal(catACalls, 0,
        'original catalog liveUnbindEvents must not be called after swap');
    assert.equal(catBCalls, 1,
        'swapped catalog liveUnbindEvents must be called (live read)');
});

// 3. getTuningMode() — gates getDiagCatalog().liveUnbindEvents in disarm paths
test('getTuningMode() live: discardRecording skips liveUnbindEvents when tuningMode=true', () => {
    const { createRecordingCapture } = loadModule();
    let unbindCalls = 0;
    const catalog = { ...makeDiagStub(), liveUnbindEvents: () => unbindCalls++ };
    let tuningMode = false;

    const rec = createRecordingCapture(makeAcc({
        getDiagCatalog: () => catalog,
        getTuningMode: () => tuningMode,
    }));

    // tuningMode=false → liveUnbindEvents fires
    rec.armRecording();
    rec.discardRecording();
    assert.equal(unbindCalls, 1, 'liveUnbindEvents must fire when tuningMode=false');

    // Swap to true → liveUnbindEvents skipped
    unbindCalls = 0;
    tuningMode = true;
    rec.armRecording();
    rec.discardRecording();
    assert.equal(unbindCalls, 0,
        'liveUnbindEvents must be skipped when getTuningMode() returns true (live read)');
});

// 4. getAutoRecord() — read live inside the song:play auto-record handler
test('getAutoRecord() live: song:play does not arm when getAutoRecord() swapped to false', () => {
    const { createRecordingCapture, emit } = loadModule();
    let autoRecord = true;

    const rec = createRecordingCapture(makeAcc({ getAutoRecord: () => autoRecord }));
    rec.bindAutoRecord();

    // autoRecord=true → arms on song:play
    emit('song:play');
    assert.ok(rec.isArmed(), 'must arm when autoRecord=true');

    rec.discardRecording();

    // Swap to false → no arm
    autoRecord = false;
    emit('song:play');
    assert.ok(!rec.isArmed(),
        'must NOT arm when getAutoRecord() returns false (live read)');
});

// 5. getDetectPreference() — same handler, independent gate
test('getDetectPreference() live: song:play does not arm when getDetectPreference() swapped to false', () => {
    const { createRecordingCapture, emit } = loadModule();
    let pref = true;

    const rec = createRecordingCapture(makeAcc({ getDetectPreference: () => pref }));
    rec.bindAutoRecord();

    emit('song:play');
    assert.ok(rec.isArmed(), 'must arm when detectPreference=true');

    rec.discardRecording();

    // Swap to false → no arm
    pref = false;
    emit('song:play');
    assert.ok(!rec.isArmed(),
        'must NOT arm when getDetectPreference() returns false (live read)');
});

// 6. getHw() — read live in saveRecordingNow() to derive the filename slug
test('getHw() live: saveRecordingNow uses swapped hw title in fetch URL', async () => {
    let fetchUrl = null;
    const { createRecordingCapture } = loadModule({
        fetch: (url) => {
            fetchUrl = url;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ relative_path: '/r.wav' }),
            });
        },
    });
    let hw = null;
    const rec = createRecordingCapture(makeAcc({ getHw: () => hw }));

    rec.armRecording();
    rec.injectChunkForTest(128);

    // Swap hw BEFORE saveRecordingNow — it must be read at call time.
    hw = { getSongInfo: () => ({ title: 'LiveTitle' }) };
    await rec.saveRecordingNow();

    assert.ok(
        fetchUrl && fetchUrl.includes('LiveTitle'),
        `fetch URL must contain LiveTitle slug — got: ${fetchUrl}`,
    );
});

// 7. getUsingDesktopBridge() — gates _startParallelTrainingCapture in armRecordingForTraining.
//    openInstrumentStream is the stable DI function ref wrapping getUserMedia — stub it here.
//    navigator.mediaDevices must exist with a .getUserMedia function so the guard in
//    _startParallelTrainingCapture passes; openInstrumentStream is what actually runs after.
test('getUsingDesktopBridge() live: armRecordingForTraining only attempts parallel capture when true', async () => {
    // navigator.mediaDevices stub: guard passes, actual stream comes from openInstrumentStream.
    const { createRecordingCapture } = loadModule({
        navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('direct-stub'); } } },
    });
    let openStreamCalled = false;
    let useDesktop = false;
    const rec = createRecordingCapture(makeAcc({
        getUsingDesktopBridge: () => useDesktop,
        getDiagCatalog: () => makeDiagStub(),
        openInstrumentStream: async () => {
            openStreamCalled = true;
            throw new Error('stub-no-stream');
        },
    }));

    // false → openInstrumentStream must NOT be called
    await rec.armRecordingForTraining().catch(() => {});
    assert.equal(openStreamCalled, false,
        'openInstrumentStream must not be called when bridge is inactive');

    rec.disarmRecording();
    openStreamCalled = false;

    // Swap to true → openInstrumentStream IS called (stub throws → arm rolls back)
    useDesktop = true;
    await rec.armRecordingForTraining().catch(() => {});
    assert.equal(openStreamCalled, true,
        'openInstrumentStream must be called when bridge is active (live read of getUsingDesktopBridge)');
});

// 8. getSelectedDeviceId() — read inside _startParallelTrainingCapture and forwarded to
//    openInstrumentStream via constraints.  Spy on openInstrumentStream (the stable DI ref)
//    to capture constraints; navigator.mediaDevices stub makes the guard pass.
test('getSelectedDeviceId() live: _startParallelTrainingCapture passes swapped deviceId to openInstrumentStream', async () => {
    const { createRecordingCapture } = loadModule({
        navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('direct-stub'); } } },
    });
    let capturedConstraints = null;
    let deviceId = 'device-A';
    const rec = createRecordingCapture(makeAcc({
        getUsingDesktopBridge: () => true,
        getSelectedDeviceId: () => deviceId,
        getDiagCatalog: () => makeDiagStub(),
        openInstrumentStream: async (constraints) => {
            capturedConstraints = constraints;
            throw new Error('stub-no-stream');
        },
    }));

    await rec.armRecordingForTraining().catch(() => {});
    assert.equal(
        capturedConstraints && capturedConstraints.audio && capturedConstraints.audio.deviceId && capturedConstraints.audio.deviceId.exact,
        'device-A',
        'first call: deviceId must be device-A',
    );

    // Arm rolled back by stub throw — safe to re-arm
    deviceId = 'device-B';
    capturedConstraints = null;
    await rec.armRecordingForTraining().catch(() => {});
    assert.equal(
        capturedConstraints && capturedConstraints.audio && capturedConstraints.audio.deviceId && capturedConstraints.audio.deviceId.exact,
        'device-B',
        'must pass swapped deviceId device-B (live read)',
    );
});
