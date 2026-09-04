// Null-at-construction DI regression tests for createDiagnosticCatalog
// (nd-carve-6 cut 6, Toby r1 amendments).
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
//
// IMPORTANT — vm context deliberately excludes _ndShared and
// _ndClearDiagnosticReturnState. After Finding 1 fix those are resolved
// exclusively through DI accessors (getCurrentFilename, getDiagnosticReturn,
// clearDiagnosticReturnState). Any regression that re-introduces a bare
// _ndShared read will throw ReferenceError here and show up as a red test.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

// Load createDiagnosticCatalog into a plain vm context with NO _ndShared /
// _ndClearDiagnosticReturnState globals — those must be resolved through DI.
// Optional ctxOverrides lets tests inject spies (e.g. a fetch spy).
function loadCatalog(ctxOverrides = {}) {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'diagnostic-catalog.js'),
        'utf8',
    );
    // Strip export keyword so it becomes a plain function declaration in the vm.
    const stripped = src
        .replace(/^export\s+((?:function|const|let|var|class)\b)/gm, '$1')
        .replace(/^\/\*\s*global[^*]*\*\//gm, '');

    // Deliberately NO _ndShared or _ndClearDiagnosticReturnState here.
    // Any bare reference to those inside the module body will ReferenceError.
    const ctx = vm.createContext({
        // Minimal stubs for the catalog's DOM/event paths.
        window: {
            slopsmith: { on: () => {}, off: () => {} },
            feedBack:  { on: () => {}, off: () => {} },
        },
        fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
        Date, Math, JSON, Error, Array, Map, Set, Promise,
        console,
        setTimeout: () => 0,
        clearTimeout: () => {},
        ...ctxOverrides,
    });
    vm.runInContext(stripped, ctx);
    return vm.runInContext('({fn: createDiagnosticCatalog})', ctx).fn;
}

const _diagReturn = {
    active: false, previousFilename: null, previousArrangementIndex: null,
    previousTitle: null, previousArtist: null, launchedTrackId: null, diagnosticFilename: null,
};

// Minimal stubs for all 27 DI params (24 original + 3 new from Finding 1 fix).
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
        getCurrentFilename:         () => '',
        getDiagnosticReturn:        () => _diagReturn,
        clearDiagnosticReturnState: () => {},
        ndVersion:                  '99.0.0-test',
        ...overrides,
    };
}

const createDiagnosticCatalog = loadCatalog();

// ── Finding 1 regression — getDiagnosticTrackForSession reads getCurrentFilename() live ──

test('getCurrentFilename() live accessor: getDiagnosticTrackForSession sees updated filename', () => {
    // This test would throw ReferenceError on 5de9604 (before Finding 1 fix),
    // because the module read _ndShared.currentFilename directly and _ndShared is
    // not in the vm context here. It passes only after the DI fix.
    let filename = '';
    const cat = createDiagnosticCatalog(makeAccessors({ getCurrentFilename: () => filename }));

    // Pre-swap: no diagnostic track matches empty filename.
    assert.equal(cat.getDiagnosticTrackForSession(), null,
        'empty filename should not match any catalog track');

    // Swap to a filename that matches the benchmark catalog entry.
    filename = 'slopsmith-diagnostic-basic-guitar.sloppak';
    const track = cat.getDiagnosticTrackForSession();
    assert.ok(track !== null, 'getCurrentFilename() must be read live; swap must be visible');
    assert.equal(track.id, 'basic-guitar-6',
        'matched the correct catalog entry via live filename');
});

// ── getDiagnosticReturn() live accessor ───────────────────────────────────────

test('getDiagnosticReturn() live accessor: ndCaptureDiagnosticReturnBeforeLaunch writes to current object', () => {
    const returnA = { active: false, previousFilename: null, previousArrangementIndex: null,
        previousTitle: null, previousArtist: null, launchedTrackId: null, diagnosticFilename: null };
    const returnB = { active: false, previousFilename: null, previousArrangementIndex: null,
        previousTitle: null, previousArtist: null, launchedTrackId: null, diagnosticFilename: null };
    let dr = returnA;
    const cat = createDiagnosticCatalog(makeAccessors({
        getCurrentFilename:  () => 'my-song.sloppak',
        getDiagnosticReturn: () => dr,
        getHw: () => ({ getSongInfo: () => ({ title: 'My Song', artist: 'Artist', arrangement_index: 0 }) }),
    }));

    // Swap the return object AFTER construction.
    dr = returnB;
    const fakeTrack = {
        id: 'basic-guitar-6',
        title: 'T', artist: 'A', arrangement: 'B',
        dlcRelativePath: 'slopsmith-diagnostic-basic-guitar.sloppak',
        filenameIncludes: 'WONT-MATCH',
        reportProfile: 'basic-guitar-v1',
    };
    cat.ndCaptureDiagnosticReturnBeforeLaunch(fakeTrack);

    // returnB must have been written (live accessor), returnA must be untouched.
    assert.equal(returnB.active, true,
        'getDiagnosticReturn() must be read live; returnB must receive the capture');
    assert.equal(returnA.active, false,
        'stale returnA must not be written — proves accessor is live');
    assert.equal(returnB.previousFilename, 'my-song.sloppak');
});

// ── getHits() / getMisses() live accessors ────────────────────────────────────

test('getHits() live accessor: buildDiagnosticPayload reads the current hit count', () => {
    let hits = 0;
    const cat = createDiagnosticCatalog(makeAccessors({ getHits: () => hits }));
    hits = 42;
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.summary.hits, 42,
        'buildDiagnosticPayload must read getHits() live, not the captured 0');
});

test('getMisses() live accessor: buildDiagnosticPayload reads the current miss count', () => {
    let misses = 0;
    const cat = createDiagnosticCatalog(makeAccessors({ getMisses: () => misses }));
    misses = 17;
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.summary.misses, 17,
        'buildDiagnosticPayload must read getMisses() live, not the captured 0');
});

// ── getBestStreak() live accessor ─────────────────────────────────────────────

test('getBestStreak() live accessor: buildDiagnosticPayload reads current streak', () => {
    let streak = 0;
    const cat = createDiagnosticCatalog(makeAccessors({ getBestStreak: () => streak }));
    streak = 13;
    const payload = cat.buildDiagnosticPayload();
    // best_streak is in summary.best_streak
    assert.equal(payload.summary.best_streak, 13,
        'buildDiagnosticPayload must read getBestStreak() live');
});

// ── getSectionStats() live accessor ──────────────────────────────────────────

test('getSectionStats() live accessor: buildDiagnosticPayload reads current sections', () => {
    let sections = [];
    const cat = createDiagnosticCatalog(makeAccessors({ getSectionStats: () => sections }));
    sections = [{ name: 'Chorus', hits: 5, misses: 2 }];
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.sections.length, 1,
        'buildDiagnosticPayload must read getSectionStats() live');
    assert.equal(payload.sections[0].name, 'Chorus');
});

// ── getRescueCalls() / getRescueWindows() / getRescueHits() / getRescueSkippedSilent() ───

test('getRescueCalls() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 0;
    const cat = createDiagnosticCatalog(makeAccessors({ getRescueCalls: () => val }));
    val = 7;
    assert.equal(cat.buildDiagnosticPayload().summary.rescue.calls, 7);
});

test('getRescueWindows() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 0;
    const cat = createDiagnosticCatalog(makeAccessors({ getRescueWindows: () => val }));
    val = 4;
    assert.equal(cat.buildDiagnosticPayload().summary.rescue.windows, 4);
});

test('getRescueHits() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 0;
    const cat = createDiagnosticCatalog(makeAccessors({ getRescueHits: () => val }));
    val = 3;
    assert.equal(cat.buildDiagnosticPayload().summary.rescue.hits, 3);
});

test('getRescueSkippedSilent() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 0;
    const cat = createDiagnosticCatalog(makeAccessors({ getRescueSkippedSilent: () => val }));
    val = 2;
    assert.equal(cat.buildDiagnosticPayload().summary.rescue.skipped_silent, 2);
});

// ── getNdUsingEngineVerifier() live accessor ──────────────────────────────────

test('getNdUsingEngineVerifier() live accessor: buildDiagnosticPayload reads current flag', () => {
    let usingVerifier = false;
    const cat = createDiagnosticCatalog(makeAccessors({ getNdUsingEngineVerifier: () => usingVerifier }));
    usingVerifier = true;
    assert.equal(cat.buildDiagnosticPayload().engine_drain.active, true,
        'buildDiagnosticPayload must read getNdUsingEngineVerifier() live');
});

// ── getNdDrainStats() live accessor ──────────────────────────────────────────

test('getNdDrainStats() live accessor: diagResetCounters zeros the current stats object', () => {
    const statsA = { dropUnknownId: 5, suppressedRedelivery: 2, maxBatch: 3 };
    const statsB = { dropUnknownId: 9, suppressedRedelivery: 4, maxBatch: 7 };
    let stats = statsA;
    const cat = createDiagnosticCatalog(makeAccessors({ getNdDrainStats: () => stats }));
    stats = statsB;
    cat.diagResetCounters(stats);
    assert.equal(statsB.dropUnknownId, 0, 'live stats object must be zeroed');
    assert.equal(statsA.dropUnknownId, 5, 'stale object must not be zeroed');
});

// ── getDetectionMethod() live accessor ───────────────────────────────────────

test('getDetectionMethod() live accessor: buildDiagnosticPayload reads current method', () => {
    let method = 'yin';
    const cat = createDiagnosticCatalog(makeAccessors({ getDetectionMethod: () => method }));
    method = 'hps';
    assert.equal(cat.buildDiagnosticPayload().settings.method, 'hps',
        'buildDiagnosticPayload must read getDetectionMethod() live');
});

// ── Timing/pitch threshold live accessors ─────────────────────────────────────

test('getTimingTolerance() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 0.1;
    const cat = createDiagnosticCatalog(makeAccessors({ getTimingTolerance: () => val }));
    val = 0.15;
    assert.equal(cat.buildDiagnosticPayload().settings.timing_tolerance_s, 0.15);
});

test('getTimingHitThreshold() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 0.07;
    const cat = createDiagnosticCatalog(makeAccessors({ getTimingHitThreshold: () => val }));
    val = 0.09;
    assert.equal(cat.buildDiagnosticPayload().settings.timing_hit_threshold_s, 0.09);
});

test('getChordTimingHitThreshold() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 0.12;
    const cat = createDiagnosticCatalog(makeAccessors({ getChordTimingHitThreshold: () => val }));
    val = 0.18;
    assert.equal(cat.buildDiagnosticPayload().settings.chord_timing_hit_threshold_s, 0.18);
});

test('getPitchTolerance() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 50;
    const cat = createDiagnosticCatalog(makeAccessors({ getPitchTolerance: () => val }));
    val = 60;
    assert.equal(cat.buildDiagnosticPayload().settings.pitch_tolerance_cents, 60);
});

test('getPitchHitThreshold() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 35;
    const cat = createDiagnosticCatalog(makeAccessors({ getPitchHitThreshold: () => val }));
    val = 40;
    assert.equal(cat.buildDiagnosticPayload().settings.pitch_hit_threshold_cents, 40);
});

test('getChordHitRatio() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 0.6;
    const cat = createDiagnosticCatalog(makeAccessors({ getChordHitRatio: () => val }));
    val = 0.75;
    assert.equal(cat.buildDiagnosticPayload().settings.chord_hit_ratio, 0.75);
});

test('getDetectionConfidenceMin() live accessor: buildDiagnosticPayload reads current value', () => {
    let val = 0.5;
    const cat = createDiagnosticCatalog(makeAccessors({ getDetectionConfidenceMin: () => val }));
    val = 0.65;
    assert.equal(cat.buildDiagnosticPayload().settings.detection_confidence_min, 0.65,
        'buildDiagnosticPayload must read getDetectionConfidenceMin() live');
});

test('getSelectedChannel() live accessor: buildDiagnosticPayload reads current channel', () => {
    let val = 0;
    const cat = createDiagnosticCatalog(makeAccessors({ getSelectedChannel: () => val }));
    val = 1;
    assert.equal(cat.buildDiagnosticPayload().settings.channel, 1);
});

test('getTuningMode() live accessor: recordDiagnostic streams only when live flag is set', () => {
    // getTuningMode() / getRecArmedForTraining() are NOT read by buildDiagnosticPayload —
    // they gate the streamLiveJudgment call inside recordDiagnostic (line 308).
    // ponytail: test through recordDiagnostic + a fetch spy, with startLiveSession()
    // to mint a non-null _liveSessionId so the gate can fire.
    let tuningMode = false;
    let fetchCalls = 0;
    const fetchSpy = () => { fetchCalls++; return Promise.resolve({ ok: true }); };
    const cat = loadCatalog({ fetch: fetchSpy })(
        makeAccessors({ getTuningMode: () => tuningMode }),
    );
    // Mint a live session (consumes 1 fetch for the session-header POST).
    cat.startLiveSession();
    const beforeRecord = fetchCalls;

    // With tuningMode=false, recordDiagnostic must NOT stream.
    const j = { type: 'hit', note: { t: 1, s: 0, f: 5 }, detectedMidi: 60, confidence: 0.9,
        timingError: 0, hit: true, chord: false };
    cat.recordDiagnostic(j);
    assert.equal(fetchCalls, beforeRecord, 'tuningMode=false: no stream call');

    // Swap after construction — must see the new value.
    tuningMode = true;
    cat.recordDiagnostic(j);
    assert.ok(fetchCalls > beforeRecord,
        'getTuningMode() must be read live; swap to true must trigger stream');
});

test('getRecArmedForTraining() live accessor: recordDiagnostic streams when arm flag is set', () => {
    // Same pattern as getTuningMode — gates streamLiveJudgment inside recordDiagnostic.
    let recArmed = false;
    let fetchCalls = 0;
    const fetchSpy = () => { fetchCalls++; return Promise.resolve({ ok: true }); };
    const cat = loadCatalog({ fetch: fetchSpy })(
        makeAccessors({ getRecArmedForTraining: () => recArmed }),
    );
    cat.startLiveSession();
    const beforeRecord = fetchCalls;

    const j = { type: 'miss', note: { t: 2, s: 1, f: 3 }, detectedMidi: null, confidence: 0,
        timingError: 0.15, hit: false, chord: false };
    cat.recordDiagnostic(j);
    assert.equal(fetchCalls, beforeRecord, 'recArmed=false: no stream call');

    recArmed = true;
    cat.recordDiagnostic(j);
    assert.ok(fetchCalls > beforeRecord,
        'getRecArmedForTraining() must be read live; swap to true must trigger stream');
});

// ── getHw() live accessor ─────────────────────────────────────────────────────

test('getHw() live accessor: buildDiagnosticPayload reads song info from current hw', () => {
    let hw = null;
    const cat = createDiagnosticCatalog(makeAccessors({ getHw: () => hw }));
    hw = { getSongInfo: () => ({ title: 'Live Song', artist: 'Live Band', arrangement: 'lead' }) };
    const payload = cat.buildDiagnosticPayload();
    assert.equal(payload.benchmark_hint.title, 'Live Song',
        'buildDiagnosticPayload must read getHw() live, not the initial null');
});

// ── getLatencyOffset() / getInputGain() live accessors ───────────────────────

test('getLatencyOffset() live accessor: buildDiagnosticPayload reads current offset', () => {
    let val = 0;
    const cat = createDiagnosticCatalog(makeAccessors({ getLatencyOffset: () => val }));
    val = 0.075;
    assert.equal(cat.buildDiagnosticPayload().settings.latency_offset_s, 0.075);
});

test('getInputGain() live accessor: buildDiagnosticPayload reads current gain', () => {
    let val = 1;
    const cat = createDiagnosticCatalog(makeAccessors({ getInputGain: () => val }));
    val = 1.5;
    assert.equal(cat.buildDiagnosticPayload().settings.input_gain, 1.5);
});
