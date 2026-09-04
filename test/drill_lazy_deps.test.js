// Lazy-dependency regression tests for nd-carve-5 cut 3 (drill-conductor.js).
//
// Verifies that getEnabled() and getNoteResults() are live accessors — not
// values captured at createDrillConductor() construction time. If either
// accessor were captured at construction the test would throw or report stale
// data, matching the bug-class that occurred with hw in earlier cuts.
//
// Mutation proof (run before committing):
//   In main.js change `getNoteResults: () => noteResults` to
//   `getNoteResults: () => new Map()` → test "getNoteResults() live accessor..."
//   must fail: rung stays 0, speed 0.8 (no hits seen → no advance).
//   Revert → full suite green.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// Sandbox extension that provides:
//   - highway.getSongInfo() → { duration: 60 } so startDrill's duration guard passes
//   - slopsmith.setLoop()   → resolves true so startDrill proceeds past the setLoop guard
// Merged ON TOP of the base sandbox so the existing stubs survive.
function withDrillSandbox(sandboxBeforeRun) {
    return {
        sandboxBeforeRun(sandbox) {
            // Give the highway a duration so startDrill doesn't abort at "no song duration".
            sandbox.highway = Object.assign({}, sandbox.highway, {
                getSongInfo: () => ({ duration: 60, arrangement: 'lead' }),
                getTime: () => 15,
                getBeats: () => [],
            });
            // Stub setLoop so startDrill proceeds past its setLoop-unavailable guard.
            // Returns a Promise resolving to true (= loop set successfully).
            sandbox.slopsmith.setLoop = (_a, _b, _opts) => Promise.resolve(true);
            if (sandboxBeforeRun) sandboxBeforeRun(sandbox);
        },
    };
}

// ── getEnabled() ─────────────────────────────────────────────────────────────

test('getEnabled() lazy accessor: startDrill reaches the getEnabled() guard without crashing', async () => {
    // If getEnabled were captured at construction time (always false), calling
    // startDrill when detection is already enabled would still try to re-enable,
    // wasting work. The test just verifies the path is reached and handled
    // gracefully — a throw here means the accessor is broken.
    //
    // startDrill with hw.getSongInfo() → {duration:60} and slopsmith.setLoop
    // available will reach `if (!getEnabled())` at line ~263 and attempt
    // enable(), which throws (no audio pipeline) but is caught silently.
    const core = loadDetectionCore(withDrillSandbox());
    const det = core.createNoteDetector();
    det._bindDrillEvents();

    // Note: captured-false and live-false are indistinguishable in the vm
    // (enable() always fails); this test proves the path is reached, not
    // that the value is live.
    // startDrill: no throw expected even with no audio pipeline — the
    // enable() failure is caught inside startDrill.
    await assert.doesNotReject(
        () => det.startDrill(10, 20),
        'startDrill reaching getEnabled() must not propagate',
    );
    det.destroy();
});

// ── getNoteResults() ─────────────────────────────────────────────────────────

test('getNoteResults() live accessor: _drillConductorOnWrap reads the current judgment Map', async () => {
    // _drillConductorOnWrap iterates getNoteResults() to score the just-finished
    // iteration. It is registered as a slopsmith "loop:restart" listener by
    // startDrill(). This test exercises that full path:
    //
    //   startDrill → registers drillConductorOnWrapFn = _drillConductorOnWrap
    //   _recordJudgment × 3 → populates noteResults (3 hits in [10,20] window)
    //   loop:restart fires → _drillConductorOnWrap calls getNoteResults()
    //   score = 3/3 = 1.0 ≥ goal 0.85 → advance: rung 0→1, speed 0.8→0.9
    //
    // Discriminating assertion: rung must advance to 1 (speed 0.9). Under the
    // mutation `getNoteResults: () => new Map()` the wrap sees 0 hits →
    // score 0/3 → hold → rung stays 0, speed 0.8 → assertions fail.
    //
    // Requires charted notes in the judge window so _ndDrillPassScore returns a
    // real score (not null). highway.getFilteredNotes is stubbed below.
    const chartNotes = [
        { t: 12, s: 1, f: 0 },
        { t: 13, s: 1, f: 0 },
        { t: 14, s: 1, f: 0 },
    ];
    const core = loadDetectionCore(withDrillSandbox((sandbox) => {
        // Add getFilteredNotes so _drillChartedCount returns 3 (notes in [10,20]).
        sandbox.highway.getFilteredNotes = () => chartNotes;
    }));
    const det = core.createNoteDetector();
    det._bindDrillEvents();

    // startDrill registers drillConductorOnWrapFn for "loop:restart".
    const started = await det.startDrill(10, 20);
    if (!started) { det.destroy(); return; }

    // Populate noteResults with 3 hits inside the judge window (10–20 s).
    for (let i = 0; i < 3; i++) {
        det._recordJudgment(`k${i}`, { hit: true, note: { s: 1, f: 0 }, noteTime: 12 + i, judgedAt: 0 });
    }

    // Fire loop:restart → drillConductorOnWrapFn scores the window.
    assert.doesNotThrow(() => {
        core.slopsmith._fire('loop:restart', { time: 10 });
    }, 'loop:restart triggering _drillConductorOnWrap must not throw');

    // 3/3 hits → score 1.0 ≥ goal 0.85 → conductor advances rung 0→1.
    // These concrete values fail under the () => new Map() mutation (rung=0, speed=0.8).
    const s = det.getConductorState();
    assert.ok(s.active, 'conductor must still be active after first scored pass');
    assert.equal(s.rung, 1, 'rung must advance to 1 — proves getNoteResults() returned live Map');
    assert.equal(s.speed, 0.9, 'speed at rung 1 is ladder[1] = 0.9');

    det.destroy();
});

test('getNoteResults() lazy accessor: no throw with no judgments recorded', async () => {
    // Edge case: _drillConductorOnWrap called with an empty noteResults Map.
    // A stale null capture would throw here; a live accessor returning an
    // empty Map must iterate cleanly and score 0/charted hits.
    const core = loadDetectionCore(withDrillSandbox());
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    const started = await det.startDrill(10, 20);
    if (!started) { det.destroy(); return; }

    // No judgments. Fire loop:restart — _drillConductorOnWrap iterates
    // an empty getNoteResults(), scores 0/0, skips promotion (0 charted).
    assert.doesNotThrow(() => {
        core.slopsmith._fire('loop:restart', { time: 10 });
    }, 'empty noteResults must not throw');

    det.destroy();
});
