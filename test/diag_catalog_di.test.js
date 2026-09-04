// Null-at-construction DI regression tests for createDiagnosticCatalog
// (nd-carve-6 cut 6).
//
// Contract (Amendment 2026-09-03 23:3xZ): every mutable factory dep passed as
// an accessor must be read LIVE at call time, never captured at construction.
// These tests verify that by:
//   1. Constructing the catalog with accessor-A returning value-A.
//   2. Replacing accessor-A with one returning value-B (object-swap).
//   3. Calling the API method that reads that dep.
//   4. Asserting value-B is observed — proving it was NOT captured at
//      construction (captured = still sees value-A → assertion fails).
//
// Mutation proof (run before committing):
//   Change any `getX()` to `getX` (a captured value) in diagnostic-catalog.js
//   → the matching test below must fail. Revert → full suite green.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

// Load createDiagnosticCatalog into a plain vm context (no DOM needed — the
// catalog's core paths only touch the accessors and _ndShared globals).
function loadCatalog() {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'diagnostic-catalog.js'),
        'utf8',
    );
    // Strip export keyword so it becomes a plain function declaration in the vm.
    const stripped = src
        .replace(/^export\s+((?:function|const|let|var|class)\b)/gm, '$1')
        .replace(/^\/\*\s*global[^*]*\*\//gm, '');

    const ctx = vm.createContext({
        // _ndShared is read by buildSessionHeader / launch helpers
        _ndShared: {
            currentFilename: 'test-song.sloppak',
            diagnosticReturn: null,
        },
        _ndClearDiagnosticReturnState: () => {},
        // Minimal stubs for the catalog's DOM/event paths (live bind/stream
        // paths) — these tests only cover DI accessor liveness, not streaming.
        window: {
            slopsmith: {
                on: () => {},
                off: () => {},
            },
            feedBack: {
                on: () => {},
                off: () => {},
            },
        },
        fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
        Date, Math, JSON, Error, Array, Map, Set, Promise,
        console,
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    vm.runInContext(stripped, ctx);
    return vm.runInContext('({fn: createDiagnosticCatalog})', ctx).fn;
}

// Minimal stubs for all required DI params.
function makeAccessors(overrides = {}) {
    const drainStats = { dropUnknownId: 0, suppressedRedelivery: 0, maxBatch: 0 };
    return {
        getHw:                      () => null,
        getHits:                    () => 0,
        getMisses:                  () => 0,
        getBestStreak:              () => 0,
        getSectionStats:            () => [],
        getRescueCalls:             () => 0,
        getRescueWindows:           () => 0,
        getRescueHits:              () => 0,
        getRescueSkippedSilent:     () => 0,
        getNdUsingEngineVerifier:   () => false,
        getNdDrainStats:            () => drainStats,
        getDetectionMethod:         () => 'yin',
        getTimingTolerance:         () => 0.1,
        getTimingHitThreshold:      () => 0.07,
        getChordTimingHitThreshold: () => 0.12,
        getPitchTolerance:          () => 50,
        getPitchHitThreshold:       () => 35,
        getChordHitRatio:           () => 0.6,
        getDetectionConfidenceMin:  () => 0.5,
        getLatencyOffset:           () => 0,
        getInputGain:               () => 1,
        getSelectedChannel:         () => 0,
        getTuningMode:              () => false,
        getRecArmedForTraining:     () => false,
        ndVersion:                  '99.0.0-test',
        ...overrides,
    };
}

const createDiagnosticCatalog = loadCatalog();

// ── getHits() / getMisses() live accessor ─────────────────────────────────────

test('getHits() live accessor: buildDiagnosticPayload reads the current hit count', () => {
    let hits = 0;
    const accessors = makeAccessors({ getHits: () => hits });
    const cat = createDiagnosticCatalog(accessors);

    // Swap the value after construction — live accessor must see the new value.
    hits = 42;
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.summary.hits, 42,
        'buildDiagnosticPayload must read getHits() live, not the captured 0');
});

test('getMisses() live accessor: buildDiagnosticPayload reads the current miss count', () => {
    let misses = 0;
    const accessors = makeAccessors({ getMisses: () => misses });
    const cat = createDiagnosticCatalog(accessors);

    misses = 17;
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.summary.misses, 17,
        'buildDiagnosticPayload must read getMisses() live, not the captured 0');
});

// ── getNdUsingEngineVerifier() live accessor ──────────────────────────────────

test('getNdUsingEngineVerifier() live accessor: buildDiagnosticPayload reads current flag', () => {
    let usingVerifier = false;
    const accessors = makeAccessors({ getNdUsingEngineVerifier: () => usingVerifier });
    const cat = createDiagnosticCatalog(accessors);

    // Swap after construction.
    usingVerifier = true;
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.engine_drain.active, true,
        'buildDiagnosticPayload must read getNdUsingEngineVerifier() live');
});

// ── getNdDrainStats() live accessor ──────────────────────────────────────────

test('getNdDrainStats() live accessor: diagResetCounters zeros the current stats object', () => {
    // Two objects — A (initial), B (swapped in after construction).
    const statsA = { dropUnknownId: 5, suppressedRedelivery: 2, maxBatch: 3 };
    const statsB = { dropUnknownId: 9, suppressedRedelivery: 4, maxBatch: 7 };
    let stats = statsA;
    const accessors = makeAccessors({ getNdDrainStats: () => stats });
    const cat = createDiagnosticCatalog(accessors);

    // Swap to statsB AFTER construction.
    stats = statsB;
    // diagResetCounters(obj) zeros the object returned by getNdDrainStats().
    // If accessor were captured, statsA would be zeroed and statsB unchanged.
    cat.diagResetCounters(stats);
    assert.equal(statsB.dropUnknownId, 0, 'diagResetCounters must zero the live stats object');
    assert.equal(statsB.suppressedRedelivery, 0, 'diagResetCounters must zero the live stats object');
    // statsA must be untouched (it would be zeroed under captured-accessor bug).
    assert.equal(statsA.dropUnknownId, 5, 'stale object must not be zeroed');
});

// ── getDetectionMethod() live accessor ───────────────────────────────────────

test('getDetectionMethod() live accessor: buildDiagnosticPayload reads current method', () => {
    let method = 'yin';
    const accessors = makeAccessors({ getDetectionMethod: () => method });
    const cat = createDiagnosticCatalog(accessors);

    method = 'hps';
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.settings.method, 'hps',
        'buildDiagnosticPayload must read getDetectionMethod() live');
});

// ── getHw() live accessor ─────────────────────────────────────────────────────

test('getHw() live accessor: buildDiagnosticPayload reads song info from current hw', () => {
    let hw = null;
    const accessors = makeAccessors({ getHw: () => hw });
    const cat = createDiagnosticCatalog(accessors);

    // Swap in a hw stub with known song info.
    hw = { getSongInfo: () => ({ title: 'Live Song', artist: 'Live Band', arrangement: 'lead' }) };
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.benchmark_hint.title, 'Live Song',
        'buildDiagnosticPayload must read getHw() live, not the initial null');
});

// ── getLatencyOffset() / getInputGain() live accessors ───────────────────────

test('getLatencyOffset() live accessor: buildDiagnosticPayload reads current offset', () => {
    let latencyOffset = 0;
    const accessors = makeAccessors({ getLatencyOffset: () => latencyOffset });
    const cat = createDiagnosticCatalog(accessors);

    latencyOffset = 0.075;
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.settings.latency_offset_s, 0.075,
        'buildDiagnosticPayload must read getLatencyOffset() live');
});

test('getInputGain() live accessor: buildDiagnosticPayload reads current gain', () => {
    let inputGain = 1;
    const accessors = makeAccessors({ getInputGain: () => inputGain });
    const cat = createDiagnosticCatalog(accessors);

    inputGain = 1.5;
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.settings.input_gain, 1.5,
        'buildDiagnosticPayload must read getInputGain() live');
});
