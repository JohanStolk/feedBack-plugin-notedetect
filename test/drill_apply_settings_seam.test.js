// nd-carve-5 cut 4 — applySettings(changes) seam coverage.
//
// The internal applySettings() dispatcher is the ONLY write path from
// settings-panel.js into the factory's settings closure vars.  A single
// typo (e.g. `timigTolerance`) or a dropped `if` line leaves a key silently
// unrouted: the panel updates its slider, saves to localStorage, but the
// in-flight scoring variables never change.
//
// This test loops EVERY key the seam declares, drives applySettings() with
// a unique per-key sentinel value via the _applySettings test hook, and
// asserts that _getState() returns that sentinel for the same key.  One
// missing/misrouted assignment makes exactly that key's assertion fail,
// naming the broken key in the error.
//
// Mutation proof (run before committing):
//   In main.js drop ONE seam line, e.g.:
//     `if ('timingTolerance' in changes) timingTolerance = changes.timingTolerance;`
//   → the test for key 'timingTolerance' must fail: Expected 'timingTolerance'
//     to equal 'timingTolerance' (got the original default 0.15).
//   Revert → full suite green.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// Every key the applySettings(changes) seam dispatches, in declaration order.
// Add new keys here whenever the seam grows — the loop picks them up automatically.
const SEAM_KEYS = [
    'timingTolerance',
    'pitchTolerance',
    'timingHitThreshold',
    'chordTimingHitThreshold',
    'pitchHitThreshold',
    'detectionMethod',
    'detectionMethodUserSet',
    'nativeDetection',
    'inputGain',
    'chordHitRatio',
    'selectedDeviceId',
    'selectedChannel',
    'latencyOffset',
    'edgeFlashEnabled',
    'showTimingErrors',
    'showPitchErrors',
    'missMarkerDuration',
    'hitGlowDuration',
    'detectionConfidenceMin',
];

test('applySettings seam: every key routes to the correct closure var', () => {
    // Use the key name itself as the sentinel — unique per key, type-agnostic
    // (pure assigns mean type doesn't matter), readable in failure output.
    // A dropped or misrouted assignment leaves _getState()[key] at its
    // original default, which is never equal to the key's own name string.
    const core = loadDetectionCore();
    const det = core.createNoteDetector();

    for (const key of SEAM_KEYS) {
        det._applySettings({ [key]: key });
        assert.equal(
            det._getState()[key],
            key,
            `applySettings({${key}: '${key}'}) must update the closure var — ` +
            `got ${JSON.stringify(det._getState()[key])} (key missing or misrouted in applySettings)`,
        );
    }

    det.destroy();
});
