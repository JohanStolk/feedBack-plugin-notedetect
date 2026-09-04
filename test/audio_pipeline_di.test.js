// DI contract tests for createAudioPipeline (nd-carve-10 cut 10).
//
// Contract: every mutable factory dep is an accessor read LIVE at call time,
// never captured at construction. Write-back callbacks are the only channel
// back to main.js state.
//
// Tests use native ES-module import() to load the module (ESM class-killer
// requirement — no vm, no injected globals at parse time).
//
// TESTED HERE:
//   ESM parse:           module imports cleanly, createAudioPipeline is a fn.
//   applyInputGain seam: no-throw when gainNode absent; updates gain.value present.
//   stopAudio teardown:  discriminating — all 7 independent obligations checked;
//                        removing any single clear/callback call makes the test fail.
//   processFrame writes: setDetectedMidi/Confidence/String/Fret/DisplayMidi on freq=0.
//   sessionGen bail:     processFrame writes nothing when gen changes after capture.
//   pushRescueBuf:       called for bass arrangement.
//   resetLevelSamples:   called when hw.getTime() seeks backward.
//   lifecycle write-backs: setAudioCtx(null) + setStream(null) on stopAudio.
//
// HONEST GAPS (require live browser APIs or device-gated paths):
//   detectInterval cleared — set inside startAudio's bridge loop (Path A) or
//     ScriptProcessor path (Path C); both require async bridge resolution or
//     a real AudioContext + getUserMedia. The stopAudio teardown test covers
//     bridgeLevelTimer (same pattern, same clearInterval call site); the
//     discriminating teardown below would catch a missing clearInterval for
//     detectInterval too if startAudio were run first.
//   setDetectedString/setDetectedFret (hit path) — those writes happen inside
//     matchNotes (passed as stable ref); testing requires a real matchNotes run.
//   onaudioprocess / onCbHeartbeat — ScriptProcessor callback; needs a live
//     AudioContext. Covered by the desktop-bridge integration tests.
//   startBridgeLevelMeter full flow — timer fires async IPC; getLevels is
//     device-gated. Timer installation + clearance IS covered in teardown.

'use strict';

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal, fully-populated DI object with write-capture side tables. */
function makeDI(overrides = {}) {
    const writes = {
        usingDesktopBridge: [],
        bridgeDesktop:      [],
        audioCtx:           [],
        stream:             [],
        inputLevel:         [],
        inputPeak:          [],
        bridgeSampleRate:   [],
        ndUsingEngineVerifier: [],
        usingNativeFrames:  [],
        detectedMidi:       [],
        detectedConfidence: [],
        detectedString:     [],
        detectedFret:       [],
        detectedDisplayMidi:[],
        bridgeLevelsUnavailable: [],
        inputLost:          [],
        healthTrack:        [],
        sourceId:           [],
        ndOwnsSource:       [],
        verifierStateResets: 0,
        cbHeartbeats:       [],
        rescueBufs:         [],
        levelSampleResets:  0,
    };

    const ndLevelSamples = [];

    const base = {
        // ── live accessors ──────────────────────────────────────────────────
        getEnabled:                () => true,
        getCurrentArrangement:     () => 'lead',
        getDetectionConfidenceMin: () => 0.5,
        getNativeDetection:        () => false,
        getFrameSize:              () => 2048,
        getAutoEnableTrial:        () => false,
        getInputGain:              () => 1.0,
        getSelectedChannel:        () => 0,
        getSelectedDeviceId:       () => null,
        getSessionGen:             () => 1,
        getSourceId:               () => null,
        getNdUsingEngineVerifier:  () => false,
        getNdHostChartSuspended:   () => false,
        getNdOtherOwnsOurSlot:     () => false,
        getNdVerifierChartSig:     () => '',
        getNdVerifyTarget:         () => null,
        getInputLost:              () => false,
        // ── write-back callbacks ────────────────────────────────────────────
        setUsingDesktopBridge:     (v) => writes.usingDesktopBridge.push(v),
        setBridgeDesktop:          (v) => writes.bridgeDesktop.push(v),
        setAudioCtx:               (v) => writes.audioCtx.push(v),
        setStream:                 (v) => writes.stream.push(v),
        setInputLevel:             (v) => writes.inputLevel.push(v),
        setInputPeak:              (v) => writes.inputPeak.push(v),
        setBridgeSampleRate:       (v) => writes.bridgeSampleRate.push(v),
        setNdUsingEngineVerifier:  (v) => writes.ndUsingEngineVerifier.push(v),
        setUsingNativeFrames:      (v) => writes.usingNativeFrames.push(v),
        setDetectedMidi:           (v) => writes.detectedMidi.push(v),
        setDetectedConfidence:     (v) => writes.detectedConfidence.push(v),
        setDetectedString:         (v) => writes.detectedString.push(v),
        setDetectedFret:           (v) => writes.detectedFret.push(v),
        setDetectedDisplayMidi:    (v) => writes.detectedDisplayMidi.push(v),
        setBridgeLevelsUnavailable:(v) => writes.bridgeLevelsUnavailable.push(v),
        setInputLost:              (v) => writes.inputLost.push(v),
        setHealthTrack:            (v) => writes.healthTrack.push(v),
        setSourceId:               (v) => writes.sourceId.push(v),
        setNdOwnsSource:           (v) => writes.ndOwnsSource.push(v),
        resetVerifierState:        () => { writes.verifierStateResets++; },
        onCbHeartbeat:             (now, gap) => writes.cbHeartbeats.push({ now, gap }),
        pushRescueBuf:             (buf, endT) => writes.rescueBufs.push({ buf, endT }),
        resetLevelSamples:         () => { writes.levelSampleResets++; },
        setNdVerifierChartSig:     () => {},
        // ── shared array ────────────────────────────────────────────────────
        ndLevelSamples,
        // ── stable refs ─────────────────────────────────────────────────────
        matchNotes:                async () => {},
        diagCatalog:               { setDiagDetector: () => {}, getLiveSessionId: () => null },
        recCapture:                { isArmed: () => false, isArmedOrTraining: () => false, pushFrame: () => {} },
        avCal:                     { logDetection: () => {}, logMiss: () => {} },
        settingsPanel:             { populateDevices: () => {}, drawSettingsVU: () => {} },
        openInstrumentStream:      async () => { throw new Error('no browser in test'); },
        ndOpenSelectedInputSource:  async () => {},
        ndSyncMlGate:              () => {},
        ndGateToken:               'test-gate-token',
        ndDesktopSourceApiReady:    () => false,
        ndFlushOrphanSources:       () => {},
        ndOrphanSourceIds:          [],
        ndPushChartToBridge:        async () => {},
        ndDrainEngineVerdicts:      async () => {},
        ndBridgeRawAudioFrame:      async () => null,
        ndBridgeRawPitch:           async () => null,
        ndBridgeRawFramesAvailable: () => false,
        ndBridgePitch:              async () => null,
        ndBridgeAudio:              () => null,
        ndApplyVerifierOffset:      () => {},
        ndWantOwnSource:            false,
        ndChannelIndex:             0,
        ndDeviceKey:                null,
        ndTryFreeSource:            () => true,
        ndMinAnalysisSamples:       () => 2048,
        ndEffectiveDetectionMethod: () => 'hps',
        ndFreqToMidi:               (f) => Math.round(12 * Math.log2(f / 440) + 69),
        ndYinDetect:                () => ({ freq: 0, confidence: 0 }),
        ndHpsDetect:                () => ({ freq: 0, confidence: 0 }),
        ndCrepeDetect:              async () => ({ freq: 0, confidence: 0 }),
        ndShared:                   {},
        ndUpdateMlGate:             () => {},
        ndChartSignature:           () => '',
        runVerifyTarget:            async () => {},
        hw:                         null,
        externalStream:             null,
        externalAudioCtx:           null,
        optsSourceId:               undefined,
        ND_AUDIO_REQUESTER:         'note_detect',
        ND_LEVEL_HISTORY_S:         6,
        RESCUE_BUF_MAX:             32768,
        updateButton:               () => {},
        onStreamHealthRestart:      () => {},
        ...overrides,
    };

    return { di: base, writes, ndLevelSamples };
}

// ── 1. ESM class-killer ────────────────────────────────────────────────────
// Verifies the module parses as a valid ES module and exports the expected fn.
// No vm, no injected globals — real import() in the test runner's realm.

test('ESM class-killer: audio-pipeline.js exports createAudioPipeline as a function', async () => {
    const mod = await import(path.join(__dirname, '..', 'src', 'audio-pipeline.js'));
    assert.strictEqual(typeof mod.createAudioPipeline, 'function',
        'createAudioPipeline must be a named export and a function');
});

// ── 2. applyInputGain seam — absent (no-throw) ────────────────────────────
// gainNode is null immediately after construction; applyInputGain must be a
// silent no-op (not a ReferenceError or TypeError).

test('applyInputGain: no-throw when gainNode is null (initial state)', async () => {
    const { createAudioPipeline } = await import(
        path.join(__dirname, '..', 'src', 'audio-pipeline.js'));
    const { di } = makeDI();
    const pipe = createAudioPipeline(di);

    assert.doesNotThrow(() => pipe.applyInputGain(0),   'applyInputGain(0) must not throw');
    assert.doesNotThrow(() => pipe.applyInputGain(0.5), 'applyInputGain(0.5) must not throw');
    assert.doesNotThrow(() => pipe.applyInputGain(2),   'applyInputGain(2) must not throw');
});

// ── 3. applyInputGain seam — present (gain.value mutated) ─────────────────
// Run startAudio with stubbed browser APIs (externalStream + externalAudioCtx)
// so gainNode is created, then assert applyInputGain writes to it.

test('applyInputGain: updates gainNode.gain.value when gainNode is present', async () => {
    const { createAudioPipeline } = await import(
        path.join(__dirname, '..', 'src', 'audio-pipeline.js'));

    // Inject requestAnimationFrame so startLevelMeter() does not throw.
    const origRAF = global.requestAnimationFrame;
    const origCAF = global.cancelAnimationFrame;
    global.requestAnimationFrame = () => 0;
    global.cancelAnimationFrame  = () => {};

    let capturedGainNode = null;
    const mockProcessor  = { onaudioprocess: null, connect: () => {}, disconnect: () => {} };
    const mockCtx = {
        state: 'running', sampleRate: 48000, destination: {},
        createGain: () => {
            capturedGainNode = { gain: { value: 1.0 }, connect: () => {}, disconnect: () => {} };
            return capturedGainNode;
        },
        createAnalyser:            () => ({ fftSize: 2048, getFloatTimeDomainData: () => {}, disconnect: () => {} }),
        createScriptProcessor:     () => mockProcessor,
        createMediaStreamSource:   () => ({ connect: () => {}, disconnect: () => {} }),
        createChannelSplitter:     () => ({ connect: () => {}, disconnect: () => {} }),
        createChannelMerger:       () => ({ connect: () => {}, disconnect: () => {} }),
    };
    const mockTrack  = { addEventListener: () => {}, removeEventListener: () => {} };
    const mockStream = {
        getAudioTracks: () => [mockTrack],
        getTracks:      () => [{ stop: () => {} }],
    };

    const { di } = makeDI({
        externalAudioCtx: mockCtx,
        externalStream:   mockStream,
    });
    const pipe = createAudioPipeline(di);

    try {
        await pipe.startAudio();

        assert.notStrictEqual(capturedGainNode, null,
            'gainNode must be created during startAudio');
        const before = capturedGainNode.gain.value;
        pipe.applyInputGain(0.42);
        assert.strictEqual(capturedGainNode.gain.value, 0.42,
            'applyInputGain must write the new value to gainNode.gain.value');
        // Discriminate: value must have actually changed.
        assert.notStrictEqual(capturedGainNode.gain.value, before,
            'gain.value must differ from its initial value after applyInputGain');
    } finally {
        pipe.stopAudio();
        global.requestAnimationFrame = origRAF;
        global.cancelAnimationFrame  = origCAF;
    }
});

// ── 4. stopAudio teardown — discriminating ────────────────────────────────
// Seven independent obligations. Removing any single one from stopAudio must
// make exactly one assertion here fail.
//
// Honest gap — detectInterval: the interval is set inside startAudio (bridge
// loop / ScriptProcessor path). Testing requires async bridge resolution or
// live audio APIs; covered at integration level in desktop-bridge.test.js.
// The bridgeLevelTimer path below exercises the same clearInterval call site.

test('stopAudio: clears bridgeLevelTimer and fires all state write-backs', async (t) => {
    const { createAudioPipeline } = await import(
        path.join(__dirname, '..', 'src', 'audio-pipeline.js'));

    // Capture setInterval handles so we can verify clearInterval gets the same one.
    const installedIds = [];
    const clearedIds   = [];
    const origSetInterval   = global.setInterval;
    const origClearInterval = global.clearInterval;
    global.setInterval   = (fn, delay) => {
        const id = origSetInterval(fn, delay != null ? delay : 99_999_999);
        installedIds.push(id);
        return id;
    };
    global.clearInterval = (id) => { clearedIds.push(id); origClearInterval(id); };

    const { di, writes } = makeDI({ getEnabled: () => true });
    const pipe = createAudioPipeline(di);

    // Install a bridge level meter timer via the public API.
    const mockDesktop = { audio: { getLevels: async () => ({ inputLevel: 0, inputPeak: 0 }) } };
    pipe.startBridgeLevelMeter(mockDesktop);

    try {
        assert.strictEqual(installedIds.length, 1,
            'startBridgeLevelMeter must install exactly one setInterval');
        const timerHandle = installedIds[0];

        pipe.stopAudio();

        // 1. bridgeLevelTimer clearInterval
        assert.ok(clearedIds.includes(timerHandle),
            'stopAudio must clearInterval(bridgeLevelTimer) — [1/7]');
        // 2. usingDesktopBridge reset
        assert.ok(writes.usingDesktopBridge.includes(false),
            'stopAudio must call setUsingDesktopBridge(false) — [2/7]');
        // 3. usingNativeFrames reset
        assert.ok(writes.usingNativeFrames.includes(false),
            'stopAudio must call setUsingNativeFrames(false) — [3/7]');
        // 4. ndUsingEngineVerifier reset
        assert.ok(writes.ndUsingEngineVerifier.includes(false),
            'stopAudio must call setNdUsingEngineVerifier(false) — [4/7]');
        // 5. verifier state reset
        assert.ok(writes.verifierStateResets >= 1,
            'stopAudio must call resetVerifierState() — [5/7]');
        // 6. inputLost cleared
        assert.ok(writes.inputLost.includes(false),
            'stopAudio must call setInputLost(false) — [6/7]');
        // 7. level counters zeroed
        assert.ok(writes.inputLevel.includes(0),
            'stopAudio must call setInputLevel(0) — [7/7]');
    } finally {
        global.setInterval   = origSetInterval;
        global.clearInterval = origClearInterval;
    }
});

// ── 5. processFrame detection write-backs — no-detection path ─────────────
// When the detector returns freq=0 / confidence=0, all five write-backs fire
// with the "miss" sentinel values.

test('processFrame: fires setDetectedMidi/Confidence/String/Fret/DisplayMidi(-1) when freq=0', async () => {
    const { createAudioPipeline } = await import(
        path.join(__dirname, '..', 'src', 'audio-pipeline.js'));
    const { di, writes } = makeDI({
        ndEffectiveDetectionMethod: () => 'hps',
        ndHpsDetect:                () => ({ freq: 0, confidence: 0 }),
    });
    const pipe = createAudioPipeline(di);

    await pipe.processFrame(new Float32Array(2048));

    assert.strictEqual(writes.detectedMidi.at(-1), -1,
        'setDetectedMidi(-1) must be called when freq=0');
    assert.strictEqual(writes.detectedConfidence.at(-1), 0,
        'setDetectedConfidence(0) must be called when freq=0');
    assert.strictEqual(writes.detectedString.at(-1), -1,
        'setDetectedString(-1) must be called when freq=0');
    assert.strictEqual(writes.detectedFret.at(-1), -1,
        'setDetectedFret(-1) must be called when freq=0');
    assert.strictEqual(writes.detectedDisplayMidi.at(-1), -1,
        'setDetectedDisplayMidi(-1) must be called when freq=0');
});

// ── 6. sessionGen bail ─────────────────────────────────────────────────────
// processFrame captures sessionGen at entry. If the gen changes before the
// post-detection check (simulating restartAudio bumping it mid-frame), it
// must bail WITHOUT writing any detection state.
//
// This is the "post-stop tick bails via sessionGen" requirement from god:
// a stale tick must not write detectedMidi / detectedString / etc.

test('processFrame: bails via sessionGen — no detection writes when gen changes', async () => {
    const { createAudioPipeline } = await import(
        path.join(__dirname, '..', 'src', 'audio-pipeline.js'));

    // First call: return gen=1 (captured at top of processFrame).
    // Subsequent calls: return gen=2 (simulates restartAudio bump).
    let callCount = 0;
    const { di, writes } = makeDI({
        getSessionGen:              () => (++callCount === 1 ? 1 : 2),
        ndEffectiveDetectionMethod: () => 'hps',
        // Return a valid detection — WITHOUT the bail this WOULD write setDetectedMidi.
        ndHpsDetect:                () => ({ freq: 220, confidence: 0.9 }),
    });
    const pipe = createAudioPipeline(di);

    await pipe.processFrame(new Float32Array(2048).fill(0.01));

    assert.strictEqual(writes.detectedMidi.length, 0,
        'processFrame must not write detectedMidi when sessionGen changed between capture and check');
    assert.strictEqual(writes.detectedString.length, 0,
        'processFrame must not write detectedString when sessionGen changed');
    assert.strictEqual(writes.detectedFret.length, 0,
        'processFrame must not write detectedFret when sessionGen changed');
});

// ── 7. pushRescueBuf — bass arrangement ───────────────────────────────────
// For bass arrangements, processFrame accumulates a rescue buffer and calls
// pushRescueBuf(newBuf, hwTime) so main.js can access it for checkMisses.

test('processFrame: calls pushRescueBuf for bass arrangement', async () => {
    const { createAudioPipeline } = await import(
        path.join(__dirname, '..', 'src', 'audio-pipeline.js'));
    const { di, writes } = makeDI({
        getCurrentArrangement:      () => 'bass',
        ndEffectiveDetectionMethod: () => 'hps',
        ndHpsDetect:                () => ({ freq: 0, confidence: 0 }),
    });
    const pipe = createAudioPipeline(di);

    const buf = new Float32Array(512).fill(0.2);
    await pipe.processFrame(buf);

    assert.ok(writes.rescueBufs.length >= 1,
        'pushRescueBuf must be called when arrangement is bass');
    assert.ok(writes.rescueBufs[0].buf instanceof Float32Array,
        'pushRescueBuf first arg must be a Float32Array');
});

// ── 8. resetLevelSamples — backward seek ──────────────────────────────────
// When hw.getTime() returns a value earlier than the last sample's songT by
// more than 0.05 s, processFrame calls resetLevelSamples() to flush the stale
// history before pushing the new sample.

test('processFrame: calls resetLevelSamples when hw.getTime seeks backward', async () => {
    const { createAudioPipeline } = await import(
        path.join(__dirname, '..', 'src', 'audio-pipeline.js'));

    let songT = 10;
    const { di, writes, ndLevelSamples } = makeDI({
        getCurrentArrangement:      () => 'lead', // not bass → no rescue buf
        ndEffectiveDetectionMethod: () => 'hps',
        ndHpsDetect:                () => ({ freq: 0, confidence: 0 }),
        hw: { getTime: () => songT, getAvOffset: () => 0 },
    });
    const pipe = createAudioPipeline(di);

    const buf = new Float32Array(128).fill(0.1);
    await pipe.processFrame(buf); // pushes a sample at songT=10
    songT = 1;                    // simulate seek backward by >0.05s
    await pipe.processFrame(buf); // must call resetLevelSamples()

    assert.ok(writes.levelSampleResets >= 1,
        'resetLevelSamples must be called when hw.getTime() seeks more than 0.05s backward');
});

// ── 9. Lifecycle write-backs on stopAudio ─────────────────────────────────
// setAudioCtx(null) and setStream(null) are the canonically observable signal
// that main.js should clear its own audioCtx / stream references after a stop.

test('stopAudio: fires setAudioCtx(null) and setStream(null)', async () => {
    const { createAudioPipeline } = await import(
        path.join(__dirname, '..', 'src', 'audio-pipeline.js'));
    const { di, writes } = makeDI();
    const pipe = createAudioPipeline(di);

    pipe.stopAudio();

    assert.ok(writes.audioCtx.includes(null),
        'stopAudio must call setAudioCtx(null) — lifecycle write-back');
    assert.ok(writes.stream.includes(null),
        'stopAudio must call setStream(null) — lifecycle write-back');
});
