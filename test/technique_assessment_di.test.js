// Null-at-construction DI regression tests for createTechniqueAssessment
// (nd-carve-9 cut 9).
//
// Contract: every mutable factory dep is an accessor read LIVE at call time,
// never captured at construction. Proof pattern — object-swap:
//   1. Construct with accessor-A returning value-A.
//   2. Swap accessor-A to return value-B.
//   3. Call the API that reads that dep.
//   4. Assert value-B is observed (captured = still sees value-A → test fails).
//
//   TESTED HERE (report-path accessors, exercised via getCalibrationReport()):
//     getLatencyOffset       — report.settings.latency_offset_s
//     getInputGain           — report.settings.input_gain
//     getDetectionMethod     — report.settings.method
//     getCurrentStringCount  — report.per_string length
//     getPitchTolerance      — report.settings.pitch_tolerance_cents
//     getTimingTolerance     — report.settings.timing_tolerance_s
//     (null-at-ctor variants for getLatencyOffset and getCurrentStringCount)
//
//   HONEST GAPS (need DOM + full audio pipeline):
//     getChordHitRatio — only read in _calLabRunScoreProbe() as minHitRatio,
//       which fires from DOM button clicks during an active probe step.
//     getCapo / getCurrentArrangement / getTuningOffsets — same probe path;
//       cannot reach without a real probe flow.
//     getSelectedChannel — read in _calLabRefreshLive's live-step state;
//       needs live DOM step.
//     getEnabled + getUsingDesktopBridge — gate in _calLabCanProbe(), only
//       reached from _calLabRunScoreProbe(); needs DOM button click flow.
//     getNdUsingEngineVerifier — read in _calLabRefreshLive 200ms tick;
//       tick fires only when _calLabEl.isConnected in a real document.
//
//   STABLE (not live accessors — correctly captured at construction):
//     ndVersion, ndVerifyHarmonicSnr, ndVerifyPitchCents,
//     diagCatalog, ndBridgeScoreAvailable, ndBridgeScoreChord,
//     ndMidiFromStringFret, ndMidiToName, calibrationFormatLevel,
//     getCalibrationSnapshot.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

// ── vm loader ─────────────────────────────────────────────────────────────────
function loadModule(ctxOverrides = {}) {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'technique-assessment.js'), 'utf8');
    const stripped = src.replace(/^export\s+/gm, '');

    // Minimal stable-ref stubs
    const defaultDiagCatalog = { getDiagDetector: () => null };
    const defaultSnap = {
        sampleRateHz: 48000, channel: 0, source: 'default',
        avOffsetMs: 0, inputLevelPct: 0, inputPeakPct: 0,
    };

    const baseCtx = {
        // stable refs
        ndVersion:             'test-version',
        ndVerifyHarmonicSnr:   10,
        ndVerifyPitchCents:    50,
        diagCatalog:           defaultDiagCatalog,
        ndBridgeScoreAvailable: () => false,
        ndBridgeScoreChord:    async () => null,
        ndMidiFromStringFret:  () => 40,
        ndMidiToName:          (m) => String(m),
        calibrationFormatLevel: () => '0%',
        getCalibrationSnapshot: () => defaultSnap,
        // live accessors
        getUsingDesktopBridge:  () => false,
        getDetectionMethod:     () => 'hps',
        getSelectedChannel:     () => 0,
        getInputGain:           () => 1.0,
        getCurrentArrangement:  () => 0,
        getCurrentStringCount:  () => 6,
        getTuningOffsets:       () => [0, 0, 0, 0, 0, 0],
        getLatencyOffset:       () => 0,
        getEnabled:             () => false,
        getNdUsingEngineVerifier: () => false,
        getCapo:                () => 0,
        getPitchTolerance:      () => 50,
        getTimingTolerance:     () => 0.150,
        getChordHitRatio:       () => 0.40,
        ...ctxOverrides,
    };

    // Build fake document/DOM
    const makeEl = () => {
        const el = {
            className: '', textContent: '', innerHTML: '', style: {},
            dataset: {}, hidden: false, isConnected: true,
            onclick: null, onchange: null,
            appendChild: () => {}, remove: () => {},
            closest: () => null,
            getAttribute: () => null,
            setAttribute: () => {},
            classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
            querySelector: () => null,
            querySelectorAll: () => [],
            insertAdjacentHTML: () => {},
        };
        return el;
    };

    const document = {
        createElement: () => makeEl(),
        body: {
            appendChild: () => {},
            querySelector: () => null,
            querySelectorAll: () => [],
        },
    };

    const context = vm.createContext({
        ...baseCtx,
        document,
        window: {},
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        URL: { createObjectURL: () => 'blob:', revokeObjectURL: () => {} },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        console,
    });

    vm.runInContext(stripped, context);
    return context;
}

// Open the lab in a context that provides a capturable DOM overlay
function openLabAndGetState(ctx) {
    // Override document.body.appendChild to capture the overlay element
    let capturedOverlay = null;
    const makeEl = () => {
        let _html = '';
        const el = {
            className: '', textContent: '', style: {}, dataset: {},
            hidden: false, isConnected: true,
            onclick: null, onchange: null,
            appendChild: () => {}, remove: () => {},
            closest: () => null,
            getAttribute: () => null,
            setAttribute: () => {},
            classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
            insertAdjacentHTML: () => {},
            get innerHTML() { return _html; },
            set innerHTML(v) { _html = v; },
            querySelector: () => makeEl(),
            querySelectorAll: () => [],
        };
        return el;
    };
    ctx.document = {
        createElement: () => makeEl(),
        body: {
            appendChild: (el) => { capturedOverlay = el; },
            querySelector: () => null,
            querySelectorAll: () => [],
        },
    };
    ctx.createTechniqueAssessment({
        getUsingDesktopBridge:  ctx.getUsingDesktopBridge,
        getDetectionMethod:     ctx.getDetectionMethod,
        getSelectedChannel:     ctx.getSelectedChannel,
        getInputGain:           ctx.getInputGain,
        getCurrentArrangement:  ctx.getCurrentArrangement,
        getCurrentStringCount:  ctx.getCurrentStringCount,
        getTuningOffsets:       ctx.getTuningOffsets,
        getLatencyOffset:       ctx.getLatencyOffset,
        getEnabled:             ctx.getEnabled,
        getNdUsingEngineVerifier: ctx.getNdUsingEngineVerifier,
        getCapo:                ctx.getCapo,
        getPitchTolerance:      ctx.getPitchTolerance,
        getTimingTolerance:     ctx.getTimingTolerance,
        getChordHitRatio:       ctx.getChordHitRatio,
        ndVersion:              ctx.ndVersion,
        ndVerifyHarmonicSnr:    ctx.ndVerifyHarmonicSnr,
        ndVerifyPitchCents:     ctx.ndVerifyPitchCents,
        diagCatalog:            ctx.diagCatalog,
        ndBridgeScoreAvailable: ctx.ndBridgeScoreAvailable,
        ndBridgeScoreChord:     ctx.ndBridgeScoreChord,
        ndMidiFromStringFret:   ctx.ndMidiFromStringFret,
        ndMidiToName:           ctx.ndMidiToName,
        calibrationFormatLevel: ctx.calibrationFormatLevel,
        getCalibrationSnapshot: ctx.getCalibrationSnapshot,
    });
    return capturedOverlay;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeStub() {
    let _html = '';
    const stub = {
        className: '', textContent: '', style: {}, dataset: {},
        isConnected: true, onclick: null, onchange: null,
        appendChild: () => {}, remove: () => {},
        closest: () => null, getAttribute: () => null, setAttribute: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
        insertAdjacentHTML: () => {},
        get innerHTML() { return _html; }, set innerHTML(v) { _html = v; },
        querySelector: () => makeStub(),    // always return a stub — overlay wires onclick here
        querySelectorAll: () => [],
    };
    return stub;
}

function makeInstance(overrides = {}) {
    const ctx = loadModule(overrides);
    let latencyOffset = 0, inputGain = 1.0, detectionMethod = 'hps', stringCount = 6;

    // Open the lab to set _calLabState (non-null) before building the instance
    // so getCalibrationReport() will call _calLabBuildReport().
    ctx.document = {
        createElement: () => makeStub(),
        body: { appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [] },
    };

    const inst = ctx.createTechniqueAssessment({
        getUsingDesktopBridge:  () => false,
        getDetectionMethod:     () => detectionMethod,
        getSelectedChannel:     () => 0,
        getInputGain:           () => inputGain,
        getCurrentArrangement:  () => 0,
        getCurrentStringCount:  () => stringCount,
        getTuningOffsets:       () => new Array(stringCount).fill(0),
        getLatencyOffset:       () => latencyOffset,
        getEnabled:             () => false,
        getNdUsingEngineVerifier: () => false,
        getCapo:                () => 0,
        getPitchTolerance:      () => 50,
        getTimingTolerance:     () => 0.150,
        getChordHitRatio:       () => 0.40,
        ndVersion:              'test-version',
        ndVerifyHarmonicSnr:    10,
        ndVerifyPitchCents:     50,
        diagCatalog:            { getDiagDetector: () => null },
        ndBridgeScoreAvailable: () => false,
        ndBridgeScoreChord:     async () => null,
        ndMidiFromStringFret:   () => 40,
        ndMidiToName:           (m) => String(m),
        calibrationFormatLevel: () => '0%',
        getCalibrationSnapshot: () => ({
            sampleRateHz: 48000, channel: 0, source: 'default',
            avOffsetMs: 0, inputLevelPct: 0, inputPeakPct: 0,
        }),
        ...overrides,
    });
    inst.openInstrumentCalibrationLab();

    return {
        inst,
        setLatencyOffset: (v) => { latencyOffset = v; },
        setInputGain:     (v) => { inputGain = v; },
        setDetectionMethod: (v) => { detectionMethod = v; },
        setStringCount:   (v) => { stringCount = v; },
    };
}

// ── tests ──────────────────────────────────────────────────────────────────────

// Test 1: module loads and exports createTechniqueAssessment
test('createTechniqueAssessment is exported', () => {
    const ctx = loadModule();
    assert.equal(typeof ctx.createTechniqueAssessment, 'function');
});

// Test 2: factory returns all 5 public API methods
test('factory returns the 5 public API methods', () => {
    const ctx = loadModule();
    const inst = ctx.createTechniqueAssessment({
        getUsingDesktopBridge: () => false, getDetectionMethod: () => 'hps',
        getSelectedChannel: () => 0, getInputGain: () => 1, getCurrentArrangement: () => 0,
        getCurrentStringCount: () => 6, getTuningOffsets: () => [], getLatencyOffset: () => 0,
        getEnabled: () => false, getNdUsingEngineVerifier: () => false, getCapo: () => 0,
        getPitchTolerance: () => 50, getTimingTolerance: () => 0.15, getChordHitRatio: () => 0.4,
        ndVersion: 'test', ndVerifyHarmonicSnr: 10, ndVerifyPitchCents: 50,
        diagCatalog: { getDiagDetector: () => null }, ndBridgeScoreAvailable: () => false,
        ndBridgeScoreChord: async () => null, ndMidiFromStringFret: () => 40,
        ndMidiToName: (m) => String(m), calibrationFormatLevel: () => '0%',
        getCalibrationSnapshot: () => ({}),
    });
    for (const fn of ['openInstrumentCalibrationLab', 'calibrationLabClose',
                      'calibrationLabNext', 'calibrationLabBack', 'getCalibrationReport',
                      'downloadCalibrationReport']) {
        assert.equal(typeof inst[fn], 'function', `missing ${fn}`);
    }
});

// Test 3: getCalibrationReport returns null when lab has never opened
test('getCalibrationReport returns null before lab is opened', () => {
    const ctx = loadModule();
    const inst = ctx.createTechniqueAssessment({
        getUsingDesktopBridge: () => false, getDetectionMethod: () => 'hps',
        getSelectedChannel: () => 0, getInputGain: () => 1, getCurrentArrangement: () => 0,
        getCurrentStringCount: () => 6, getTuningOffsets: () => [], getLatencyOffset: () => 0,
        getEnabled: () => false, getNdUsingEngineVerifier: () => false, getCapo: () => 0,
        getPitchTolerance: () => 50, getTimingTolerance: () => 0.15, getChordHitRatio: () => 0.4,
        ndVersion: 'test', ndVerifyHarmonicSnr: 10, ndVerifyPitchCents: 50,
        diagCatalog: { getDiagDetector: () => null }, ndBridgeScoreAvailable: () => false,
        ndBridgeScoreChord: async () => null, ndMidiFromStringFret: () => 40,
        ndMidiToName: (m) => String(m), calibrationFormatLevel: () => '0%',
        getCalibrationSnapshot: () => ({}),
    });
    assert.equal(inst.getCalibrationReport(), null);
});

// Test 4: getLatencyOffset is read live from getCalibrationReport()
test('getLatencyOffset: live swap — report reflects swapped value', () => {
    const { inst, setLatencyOffset } = makeInstance();
    setLatencyOffset(0.042);
    const report = inst.getCalibrationReport();
    assert.ok(report, 'report must be non-null after lab opened');
    assert.equal(report.settings.latency_offset_s, 0.042,
        'getLatencyOffset swap not reflected — value was captured at construction');
});

// Test 5: getInputGain is read live from getCalibrationReport()
test('getInputGain: live swap — report reflects swapped value', () => {
    const { inst, setInputGain } = makeInstance();
    setInputGain(2.5);
    const report = inst.getCalibrationReport();
    assert.ok(report);
    assert.equal(report.settings.input_gain, 2.5,
        'getInputGain swap not reflected — value was captured at construction');
});

// Test 6: getDetectionMethod is read live from getCalibrationReport()
test('getDetectionMethod: live swap — report reflects swapped value', () => {
    const { inst, setDetectionMethod } = makeInstance();
    setDetectionMethod('ml');
    const report = inst.getCalibrationReport();
    assert.ok(report);
    assert.equal(report.settings.method, 'ml',
        'getDetectionMethod swap not reflected — value was captured at construction');
});

// Test 7: getCurrentStringCount is read live — per_string length
test('getCurrentStringCount: live swap — per_string length reflects swapped value', () => {
    const { inst, setStringCount } = makeInstance();
    setStringCount(4);
    const report = inst.getCalibrationReport();
    assert.ok(report);
    assert.equal(report.per_string.length, 4,
        'getCurrentStringCount swap not reflected — value was captured at construction');
});

// Test 8: null-at-construction guard — getLatencyOffset null at ctor, swapped before use
test('getLatencyOffset null-at-construction → swap before report → observed', () => {
    let latencyOffset = null;
    const ctx = loadModule();
    ctx.document = {
        createElement: () => makeStub(),
        body: { appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [] },
    };
    const inst = ctx.createTechniqueAssessment({
        getUsingDesktopBridge: () => false, getDetectionMethod: () => 'hps',
        getSelectedChannel: () => 0, getInputGain: () => 1, getCurrentArrangement: () => 0,
        getCurrentStringCount: () => 6, getTuningOffsets: () => [],
        getLatencyOffset: () => latencyOffset,
        getEnabled: () => false, getNdUsingEngineVerifier: () => false, getCapo: () => 0,
        getPitchTolerance: () => 50, getTimingTolerance: () => 0.15, getChordHitRatio: () => 0.4,
        diagCatalog: { getDiagDetector: () => null }, ndBridgeScoreAvailable: () => false,
        ndBridgeScoreChord: async () => null, ndMidiFromStringFret: () => 40,
        ndMidiToName: (m) => String(m), calibrationFormatLevel: () => '0%',
        getCalibrationSnapshot: () => ({
            sampleRateHz: 48000, channel: 0, source: 'default', avOffsetMs: 0,
        }),
    });
    inst.openInstrumentCalibrationLab();
    // Swap after construction — if captured, still null
    latencyOffset = 0.099;
    const report = inst.getCalibrationReport();
    assert.ok(report);
    assert.equal(report.settings.latency_offset_s, 0.099,
        'getLatencyOffset was captured at construction (null-at-ctor bug)');
});

// Test 9: null-at-construction guard — getCurrentStringCount null at ctor
test('getCurrentStringCount null-at-construction → swap before report → observed', () => {
    let stringCount = null;
    const ctx = loadModule();
    ctx.document = {
        createElement: () => makeStub(),
        body: { appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [] },
    };
    const inst = ctx.createTechniqueAssessment({
        getUsingDesktopBridge: () => false, getDetectionMethod: () => 'hps',
        getSelectedChannel: () => 0, getInputGain: () => 1, getCurrentArrangement: () => 0,
        getCurrentStringCount: () => stringCount,
        getTuningOffsets: () => new Array(Math.max(0, stringCount || 0)).fill(0),
        getLatencyOffset: () => 0,
        getEnabled: () => false, getNdUsingEngineVerifier: () => false, getCapo: () => 0,
        getPitchTolerance: () => 50, getTimingTolerance: () => 0.15, getChordHitRatio: () => 0.4,
        diagCatalog: { getDiagDetector: () => null }, ndBridgeScoreAvailable: () => false,
        ndBridgeScoreChord: async () => null, ndMidiFromStringFret: () => 40,
        ndMidiToName: (m) => String(m), calibrationFormatLevel: () => '0%',
        getCalibrationSnapshot: () => ({
            sampleRateHz: 48000, channel: 0, source: 'default', avOffsetMs: 0,
        }),
    });
    inst.openInstrumentCalibrationLab();
    // Swap after construction
    stringCount = 5;
    const report = inst.getCalibrationReport();
    assert.ok(report);
    assert.equal(report.per_string.length, 5,
        'getCurrentStringCount was captured at construction (null-at-ctor bug)');
});

// Test 10: report per_string has per-string structure (array of objects with .string index)
test('report per_string entries have string indices 0..N-1', () => {
    const { inst, setStringCount } = makeInstance();
    setStringCount(4);
    const report = inst.getCalibrationReport();
    assert.ok(report);
    assert.equal(report.per_string.length, 4);
    for (let i = 0; i < 4; i++) {
        assert.equal(report.per_string[i].string, i);
    }
});

// Test 11: report has schema field
test('report.schema is the expected constant', () => {
    const { inst } = makeInstance();
    const report = inst.getCalibrationReport();
    assert.ok(report);
    assert.ok(typeof report.schema === 'string' && report.schema.startsWith('note_detect.'),
        `unexpected schema: ${report.schema}`);
});

// Test 12: getPitchTolerance is read live from getCalibrationReport()
test('getPitchTolerance: live swap — report reflects swapped value', () => {
    let pitchTol = 50;
    const ctx = loadModule();
    ctx.document = {
        createElement: () => makeStub(),
        body: { appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [] },
    };
    const inst = ctx.createTechniqueAssessment({
        getUsingDesktopBridge: () => false, getDetectionMethod: () => 'hps',
        getSelectedChannel: () => 0, getInputGain: () => 1, getCurrentArrangement: () => 0,
        getCurrentStringCount: () => 6, getTuningOffsets: () => [],
        getLatencyOffset: () => 0, getEnabled: () => false,
        getNdUsingEngineVerifier: () => false, getCapo: () => 0,
        getPitchTolerance: () => pitchTol,
        getTimingTolerance: () => 0.15, getChordHitRatio: () => 0.4,
        ndVersion: 'test', ndVerifyHarmonicSnr: 10, ndVerifyPitchCents: 50,
        diagCatalog: { getDiagDetector: () => null }, ndBridgeScoreAvailable: () => false,
        ndBridgeScoreChord: async () => null, ndMidiFromStringFret: () => 40,
        ndMidiToName: (m) => String(m), calibrationFormatLevel: () => '0%',
        getCalibrationSnapshot: () => ({
            sampleRateHz: 48000, channel: 0, source: 'default', avOffsetMs: 0,
        }),
    });
    inst.openInstrumentCalibrationLab();
    // Swap after construction — if captured, still sees 50
    pitchTol = 75;
    const report = inst.getCalibrationReport();
    assert.ok(report);
    assert.equal(report.settings.pitch_tolerance_cents, 75,
        'getPitchTolerance swap not reflected — value was captured at construction');
});

// Test 13: getTimingTolerance is read live from getCalibrationReport()
test('getTimingTolerance: live swap — report reflects swapped value', () => {
    let timingTol = 0.150;
    const ctx = loadModule();
    ctx.document = {
        createElement: () => makeStub(),
        body: { appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [] },
    };
    const inst = ctx.createTechniqueAssessment({
        getUsingDesktopBridge: () => false, getDetectionMethod: () => 'hps',
        getSelectedChannel: () => 0, getInputGain: () => 1, getCurrentArrangement: () => 0,
        getCurrentStringCount: () => 6, getTuningOffsets: () => [],
        getLatencyOffset: () => 0, getEnabled: () => false,
        getNdUsingEngineVerifier: () => false, getCapo: () => 0,
        getPitchTolerance: () => 50, getTimingTolerance: () => timingTol,
        getChordHitRatio: () => 0.4,
        ndVersion: 'test', ndVerifyHarmonicSnr: 10, ndVerifyPitchCents: 50,
        diagCatalog: { getDiagDetector: () => null }, ndBridgeScoreAvailable: () => false,
        ndBridgeScoreChord: async () => null, ndMidiFromStringFret: () => 40,
        ndMidiToName: (m) => String(m), calibrationFormatLevel: () => '0%',
        getCalibrationSnapshot: () => ({
            sampleRateHz: 48000, channel: 0, source: 'default', avOffsetMs: 0,
        }),
    });
    inst.openInstrumentCalibrationLab();
    // Swap after construction — if captured, still sees 0.150
    timingTol = 0.200;
    const report = inst.getCalibrationReport();
    assert.ok(report);
    assert.equal(report.settings.timing_tolerance_s, 0.200,
        'getTimingTolerance swap not reflected — value was captured at construction');
});

// Test 14 (CLASS-KILLER): real ESM import — no vm, no injected globals.
// Any free identifier in technique-assessment.js that is neither a DI param
// nor a local declaration will throw ReferenceError here, exactly as it would
// in a browser ESM context.
//
// Red-proof (e297b37): with the vm globals still injected, the module loaded
// via vm and the test below would have passed even though `_ND_VERSION` etc.
// were free. On e297b37, deleting those vm globals from the context caused the
// vm tests to pass (globals still present) — the false environment was the vm
// context itself. On this commit the real import path is the ground truth:
// if a free identifier exists, `import()` throws synchronously and
// getCalibrationReport() would throw inside _calLabBuildReport().
test('real ESM import: getCalibrationReport returns non-null with plugin_version (class-killer)', async () => {
    const modPath = path.join(__dirname, '..', 'src', 'technique-assessment.js');
    const { createTechniqueAssessment } = await import(modPath);

    // Minimal document stub so openInstrumentCalibrationLab() can mount its overlay
    const makeStubEl = () => {
        const el = {
            className: '', textContent: '', style: {}, dataset: {},
            isConnected: true, onclick: null, onchange: null, hidden: false,
            appendChild: () => {}, remove: () => {},
            closest: () => null, getAttribute: () => null, setAttribute: () => {},
            classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
            insertAdjacentHTML: () => {},
            get innerHTML() { return this._html || ''; },
            set innerHTML(v) { this._html = v; },
            querySelector: () => makeStubEl(),
            querySelectorAll: () => [],
        };
        return el;
    };
    global.document = {
        createElement: () => makeStubEl(),
        body: { appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [] },
    };

    // Declare inst outside try so the finally can call calibrationLabClose()
    // to clearInterval(_calLabTick) — openInstrumentCalibrationLab starts a
    // setInterval that keeps the event loop alive; without the close call the
    // node --test process never exits.
    let inst;
    try {
        inst = createTechniqueAssessment({
            getUsingDesktopBridge: () => false, getDetectionMethod: () => 'hps',
            getSelectedChannel: () => 0, getInputGain: () => 1, getCurrentArrangement: () => 0,
            getCurrentStringCount: () => 6, getTuningOffsets: () => [0,0,0,0,0,0],
            getLatencyOffset: () => 0, getEnabled: () => false,
            getNdUsingEngineVerifier: () => false, getCapo: () => 0,
            getPitchTolerance: () => 50, getTimingTolerance: () => 0.15,
            getChordHitRatio: () => 0.4,
            ndVersion: '1.33.0',
            ndVerifyHarmonicSnr: 3.0,
            ndVerifyPitchCents: 50,
            diagCatalog: { getDiagDetector: () => null },
            ndBridgeScoreAvailable: () => false,
            ndBridgeScoreChord: async () => null,
            ndMidiFromStringFret: () => 40,
            ndMidiToName: (m) => String(m),
            calibrationFormatLevel: () => '0%',
            getCalibrationSnapshot: () => ({
                sampleRateHz: 48000, channel: 0, source: 'default',
                avOffsetMs: 0, inputLevelPct: 0, inputPeakPct: 0,
            }),
        });
        inst.openInstrumentCalibrationLab();
        const report = inst.getCalibrationReport();
        assert.ok(report !== null, 'getCalibrationReport() returned null — _calLabBuildReport threw (free identifier?)');
        assert.equal(typeof report.plugin_version, 'string',
            'report.plugin_version not a string — ndVersion free identifier not resolved');
        assert.equal(report.plugin_version, '1.33.0',
            'report.plugin_version did not receive ndVersion DI param');
    } finally {
        inst && inst.calibrationLabClose(); // clearInterval(_calLabTick) — prevents hang
        delete global.document;
    }
});
