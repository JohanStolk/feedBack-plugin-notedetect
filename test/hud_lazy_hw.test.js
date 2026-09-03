// Regression test for Creed's HIGH finding on cut 1 (nd-carve-5, bfe1570):
// createHUD captured `hw` at construction time. When the plugin loads before
// window.highway exists, the HUD's closure holds null forever; after enable()
// registers drawOverlay as a draw hook, the first renderer frame threw
// TypeError null.project at hud.js drawOverlay (now fixed to read hw live
// from getState() → resolveHw() on every call).
//
// Probe (replicates Creed's exact test):
//   no highway at load → install stub → enable() → invoke draw hook
//   → assert no throw AND hw.project called
//
// Mutation proof: revert fix (pass hw at createHUD construction instead of
// via getState) → this test goes RED. Apply fix → GREEN.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader.js');

test('draw hook: hw resolved lazily — null at load, stub installed before enable, project called', async () => {
    // 1. Load with NO highway — simulates plugin installed before window.highway.
    const core = loadDetectionCore({
        sandboxBeforeRun: (sb) => {
            sb.highway = null; // override the default highway stub
        },
    });
    const sandboxRef = core._sandbox;

    // 2. Install a complete highway stub AFTER load (but before enable).
    let projectCalls = 0;
    let registeredHook = null;
    const hwStub = {
        getTime: () => 0,
        getAvOffset: () => 0,
        getNotes: () => [],
        getChords: () => [],
        getFilteredNotes: () => [],
        getFilteredChords: () => [],
        isDefaultRenderer: () => true,
        project: () => { projectCalls++; return { x: 0, y: 0.5, scale: 1 }; },
        fretX: () => 0,
        fillTextUnmirrored: () => {},
        getNoteStateProvider: () => null,
        addDrawHook: (fn) => { registeredHook = fn; },
        removeDrawHook: () => {},
    };
    sandboxRef.highway = hwStub;

    // 3. Provide a minimal audio mock via opts so startAudio() succeeds
    //    and enabled stays true (avoiding the audio-fail → enabled=false path).
    const noop = () => {};
    const audioNode = {
        connect: noop, disconnect: noop,
        gain: { value: 1 },
        channelCount: 1,       // mono path — no splitter/merger created
        fftSize: 0,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData: noop,
    };
    const fakeAudioCtx = {
        sampleRate: 44100,
        state: 'running',
        destination: {},
        createMediaStreamSource: () => audioNode,
        createGain: () => audioNode,
        createAnalyser: () => audioNode,
        createScriptProcessor: () => audioNode,
    };
    const fakeStream = { getTracks: () => [] };

    // 4. Create a detector instance and enable it.
    const instanceRoot = sandboxRef.document.createElement('div');
    const detector = sandboxRef.createNoteDetector({
        instanceRoot,
        audioStream: fakeStream,
        audioCtx: fakeAudioCtx,
    });

    const ok = await detector.enable();
    assert.ok(ok, 'enable() must succeed with the audio mock');

    // 5. The draw hook must have been registered with the stub's addDrawHook.
    assert.ok(typeof registeredHook === 'function',
        'draw hook must be registered via hw.addDrawHook after enable()');

    // 6. Invoke the registered draw hook — must not throw AND project must be called.
    //    ctx is a Proxy that swallows any canvas 2D call.
    const ctxStub = new Proxy({}, {
        get: (_, prop) => {
            if (prop === 'save' || prop === 'restore') return noop;
            return typeof prop === 'string' ? noop : undefined;
        },
        set: () => true,
    });

    assert.doesNotThrow(() => registeredHook(ctxStub, 800, 600),
        'draw hook must not throw when hw was null at load time');

    assert.ok(projectCalls > 0,
        `hw.project must be called (was called ${projectCalls} time(s)); ` +
        'zero means drawOverlay returned early — the lazy-hw fix is not in effect');
});
