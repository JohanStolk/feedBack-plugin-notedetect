// Regression test for Creed's HIGH finding on cut 1 (nd-carve-5, bfe1570):
// createHUD captured `hw` at construction time. When the plugin loads before
// window.highway exists, the HUD's closure holds null forever; after enable()
// registers drawOverlay as a draw hook, the first renderer frame throws
// TypeError null.project on every tick (fixed by reading hw live from
// getState() → resolveHw() on every call).
//
// Probe order (replicates the actual failure sequence):
//   1. load with window.highway = null
//   2. construct detector (hw=null at factory-init and at createHUD-construction)
//   3. install highway stub on sandbox.window
//   4. enable() → resolveHw() finds stub → draw hook registered
//   5. invoke draw hook → assert no throw AND hw.project called
//
// On buggy bfe1570: step 5 throws TypeError null.project — RED.
// On fixed 60d6be3: step 5 succeeds, project called — GREEN.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader.js');

test('draw hook: hw resolved lazily — null at load, stub installed before enable, project called', async () => {
    // Audio mock defined up-front (passed as opts, independent of window state).
    const noop = () => {};
    const audioNode = {
        connect: noop, disconnect: noop,
        gain: { value: 1 },
        channelCount: 1,         // mono path — no splitter/merger
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

    // 1. Load with NO highway in the sandbox — both window.highway and
    //    any auto-installed highway stub are absent.
    const core = loadDetectionCore({
        sandboxBeforeRun: (sb) => { sb.highway = null; },
    });
    const sandboxRef = core._sandbox;

    // 2. Construct the detector WHILE window.highway is still null.
    //    Factory: let hw = opts.highway || window.highway || null → hw = null
    //    Buggy createHUD (bfe1570): captures hw=null at construction.
    //    Fixed createHUD (60d6be3): does not take hw; reads resolveHw() from getState().
    const instanceRoot = sandboxRef.document.createElement('div');
    const detector = sandboxRef.createNoteDetector({
        instanceRoot,
        audioStream: fakeStream,
        audioCtx: fakeAudioCtx,
    });

    // 3. NOW install the highway stub — AFTER construction, before enable().
    //    This is what makes the test meaningful: the factory's construction-time
    //    hw was null; only resolveHw() (called lazily in enable()) can find this.
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

    // 4. enable() — resolveHw() finds hwStub via window.highway.
    //    Registers drawOverlay with hwStub.addDrawHook.
    const ok = await detector.enable();
    assert.ok(ok, 'enable() must succeed with the audio mock');

    assert.ok(typeof registeredHook === 'function',
        'draw hook must be registered via hw.addDrawHook after enable()');

    // 5. Invoke the registered draw hook.
    //    Buggy path (bfe1570): drawOverlay uses closure hw=null → TypeError null.project.
    //    Fixed path (60d6be3): drawOverlay reads hw from getState() → hwStub → project called.
    const ctxStub = new Proxy({}, {
        get: (_, prop) => typeof prop === 'string' ? noop : undefined,
        set: () => true,
    });

    assert.doesNotThrow(() => registeredHook(ctxStub, 800, 600),
        'draw hook must not throw when hw was null at construction time');

    assert.ok(projectCalls > 0,
        `hw.project must be called (was called ${projectCalls} time(s)); ` +
        'zero means drawOverlay returned early — lazy-hw fix not in effect');
});
