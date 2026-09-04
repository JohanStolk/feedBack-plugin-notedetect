// Vocal Highway external scoring path (Option B):
//
// When the active arrangement is named "vocal / vocals / sing / karaoke",
// note_detect defers to Vocal Highway's note:hit / note:miss events on
// window.feedBack and NEVER starts the mic pipeline. Verdicts feed the
// same graded HUD + summary as the MIDI external path, without touching
// window.slopsmith.noteDetection at all.
//
// Mutation proof contract:
//   (a) remove feedBack listener wiring → hits counter stays 0 → RED
//   (b) remove vocal short-circuit from enableImpl → mic path entered → RED
//       (also: feedBack listener count stays 0 → RED)
//   (c) guitar arrangement → feedBack left unsubscribed (0 listeners) → confirms
//       the vocal gate doesn't over-reach (RED if vocal check fires on guitar)

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// One microtask-tick flush so async enable() resolves fully.
async function tick() { await new Promise((r) => setImmediate(r)); }

// ── (a) Vocal arrangement + feedBack note:hit → hits counter advances ──────
test('vocal arrangement: feedBack note:hit routed to HUD counters', async () => {
    const core = loadDetectionCore();
    // Vocal arrangement announced by the highway stub.
    core.highway.getSongInfo = () => ({ arrangement: 'Vocals' });

    const det = core.createNoteDetector({ isDefault: true });
    const result = await det.enable();
    await tick();
    assert.equal(result, true, 'enable() must return true for vocal arrangement');

    const fb = core._sandbox.feedBack;

    // Before any event: zero hits.
    assert.equal(det.getStats().hits, 0);

    // Fire a VH note:hit — must be ingested.
    fb._fire('note:hit', { source: 'vocal_highway', noteTime: 1.5 });
    assert.equal(det.getStats().hits, 1, 'hit event must increment hits counter');

    // Non-VH source must be ignored (no double-count).
    fb._fire('note:hit', { source: 'other_plugin', noteTime: 2.0 });
    assert.equal(det.getStats().hits, 1, 'events from other sources must be ignored');

    // Miss event.
    fb._fire('note:miss', { source: 'vocal_highway', noteTime: 3.0 });
    assert.equal(det.getStats().misses, 1, 'miss event must increment misses counter');

    det.destroy();
});

// ── (b) Vocal arrangement → mic NOT started + feedBack wired ─────────────────
test('vocal arrangement: mic pipeline skipped, feedBack listeners installed', async () => {
    const core = loadDetectionCore();
    core.highway.getSongInfo = () => ({ arrangement: 'karaoke' });

    let micCalled = false;
    core._sandbox.navigator.mediaDevices.getUserMedia = () => {
        micCalled = true;
        return Promise.reject(new Error('should not be called'));
    };

    const det = core.createNoteDetector({ isDefault: true });
    await det.enable();
    await tick();

    assert.equal(micCalled, false, 'getUserMedia must NOT be called for vocal arrangement');
    assert.equal(core._sandbox.feedBack._listenerCount('note:hit'),  1,
        'one note:hit listener must be registered on feedBack');
    assert.equal(core._sandbox.feedBack._listenerCount('note:miss'), 1,
        'one note:miss listener must be registered on feedBack');

    // Disable tears down the listener.
    det.disable();
    assert.equal(core._sandbox.feedBack._listenerCount('note:hit'),  0,
        'note:hit listener must be removed on disable');
    assert.equal(core._sandbox.feedBack._listenerCount('note:miss'), 0,
        'note:miss listener must be removed on disable');

    det.destroy();
});

// ── (c) Guitar arrangement → feedBack left clean (no over-reach) ─────────────
test('guitar arrangement: feedBack NOT subscribed (vocal gate does not over-reach)', async () => {
    // Guitar can't start audio in vm (getUserMedia rejects), so enable()
    // returns false. That's fine — what matters is the feedBack listener
    // count, which must stay 0: the vocal check must not fire for guitar.
    const core = loadDetectionCore();
    core.highway.getSongInfo = () => ({ arrangement: 'lead' });

    const det = core.createNoteDetector({ isDefault: true });
    await det.enable();
    await tick();

    assert.equal(core._sandbox.feedBack._listenerCount('note:hit'),  0,
        'guitar arrangement must not install note:hit listener');
    assert.equal(core._sandbox.feedBack._listenerCount('note:miss'), 0,
        'guitar arrangement must not install note:miss listener');

    det.destroy();
});
