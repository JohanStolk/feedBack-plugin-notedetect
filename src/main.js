// Note Detection plugin
//
// Factory pattern — `createNoteDetector(options)` returns an independent
// detector instance with its own audio pipeline, scoring, HUD, timers,
// draw hook, and DOM subtree. A default singleton (`window.noteDetect`)
// is created on load for the standard single-panel case; additional
// instances can be constructed via `window.createNoteDetector(...)` by
// plugins like splitscreen that need per-panel detection.
//
// Originally proposed by topkoa in PR #2 on this repo; this takeover
// re-applies the factory design on top of 5-string-bass (#14),
// per-note hit/miss events (#12), CI (#13), and HPS (#15) which all
// landed after his branch diverged. Co-Authored-By: topkoa.
//
// ── What this revision adds and why ───────────────────────────────────────
//
// BACKGROUND: WHY CHORD DETECTION NEEDED A DIFFERENT APPROACH
//
// YIN, HPS, and CREPE are all monophonic pitch detectors — they return one
// frequency from the full mixed signal. That works well for single notes, but
// a guitar chord produces 2–6 simultaneous fundamentals plus their harmonics
// all overlapping in the spectrum. The detectors lock onto whichever string
// is loudest (usually the lowest) and score the whole chord against that one
// pitch, silently missing every other note. This revision adds a parallel
// detection path for chords that avoids the problem entirely.
//
// The core insight (from a design brief accompanying this change): instead of
// asking "what pitch is playing?" — which is hard for chords — ask "is there
// energy near the frequency I *expect* on string S right now?" That is a much
// simpler question. Because the arrangement XML already tells us exactly which
// string plays which fret at every moment, we can compute the expected
// frequency per string and check for it independently in that string's
// frequency band. This turns one hard polyphonic detection problem into N easy
// monophonic band-energy checks, one per string.
//
// The existing YIN/HPS/CREPE path is left completely intact for single notes,
// where it already works well. The constraint path is additive: it activates
// only when the chart has ≥2 simultaneous notes in the timing window.
//
// ── CHANGE 1: 8-string guitar tuning ─────────────────────────────────────
//
// _ND_TUNING_GUITAR_8 added: [30, 35, 40, 45, 50, 55, 59, 64]
// That is F#1 B1 E2 A2 D3 G3 B3 E4 — standard Ibanez/Schecter 8-string
// tuning, a perfect fourth below the 7-string low B.
//
// _ndStandardMidiFor() now branches on stringCount === 8 before the existing
// 7-string check. Every downstream function — MIDI mapping, display labels,
// and the new constraint band calculator — derives from this table, so no
// other callsites required changes.
//
// ── CHANGE 2: Dynamic string-count sizing (prerequisite for changes 1 & 3) ─
//
// Previously, `tuningOffsets` was initialised as a hardcoded 6-element array
// and never resized. Every call that passed `tuningOffsets.length` as the
// stringCount argument to mapping helpers was therefore always passing 6,
// regardless of what instrument was actually loaded. This silently produced
// wrong frequency bands for 5-string bass, 7-string guitar, and would have
// been completely broken for 8-string guitar.
//
// Fix: a new `currentStringCount` variable is set at enable() time from
// `hw.getSongInfo().tuning.length` — the authoritative source. All three
// call sites that were passing `tuningOffsets.length` into mapping helpers
// now use `currentStringCount` instead. This was a prerequisite for both
// 8-string support and for the constraint checker computing correct frequency
// bands on non-6-string instruments.
//
// ── CHANGE 3: Constraint-based chord detection ────────────────────────────
//
// Three new module-level functions (after _ndHpsDetect, before _ndLoadCrepe):
//
//   _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo)
//     Returns [loHz, hiHz] for a given string covering frets 0–24, with ±10%
//     headroom for tuning offsets, capo, and bent notes. Derived from the
//     tuning tables rather than hardcoded, so all instrument types are covered.
//
//   _ndBandEnergy(magnitudes, binHz, loHz, hiHz)
//     Measures the fraction of total spectrum energy (0..1) that falls in a
//     frequency band, operating on the magnitude spectrum from _ndFftMagnitude.
//     NOTE: reuses the module-level FFT scratch buffers (_ndFftInterleavedScratch,
//     _ndFftMagnitudesScratch). This is safe because the FFT is synchronous and
//     JS is single-threaded — see the existing comment on those buffers. If this
//     code is ever moved to an AudioWorklet or Web Worker, per-call scratch
//     buffers would be needed instead.
//
//   _ndConstraintCheckString(buffer, sampleRate, stringIdx, fret, ...)
//     The core per-string check. Calls _ndFftMagnitude once (which reuses the
//     scratch), measures band energy for this string's frequency range, and
//     optionally verifies that the dominant bin in the band is within
//     pitchCheckCents of the expected frequency. Returns { hit, bandEnergy,
//     centsDiff }. energyThreshold and pitchCheckCents are caller-adjustable
//     to support technique-specific loosening (see change 4).
//
//   _ndScoreChord(buffer, sampleRate, chordNotes, ..., minHitRatio)
//     Runs _ndConstraintCheckString for each note in a chord group, applies
//     per-technique threshold adjustments (see change 4), and returns
//     { score, hitStrings, totalStrings, results, isHit } where isHit is
//     true if score >= minHitRatio.
//
// ROUTING IN matchNotes():
//   Candidate notes (from the chart's timing window) are now bucketed by
//   timestamp. A bucket with 1 note goes through the existing MIDI comparison
//   against the YIN/HPS/CREPE result, unchanged. A bucket with ≥2 notes runs
//   polyphonic chord scoring. The browser path calls _ndScoreChord on the
//   accumulated `pendingBuffer` (same audio just analysed for pitch). The
//   slopsmith-desktop bridge path dispatches the chord context over the
//   `audio:scoreChord` IPC, where the native JUCE ChordScorer reads from
//   the engine's own input ring — no audio buffer crosses IPC. Both paths
//   return the same { score, hitStrings, totalStrings, isHit, results[] }
//   shape. Each string's individual result is stored in noteResults so the
//   draw overlay can colour fret gems per-note. The chord hit/miss is
//   counted as a single judgment and fires a notedetect:hit event with
//   { chord: true, hitStrings, totalStrings, score } instead of the usual
//   { note, expectedMidi }.
//
// ── CHANGE 4: Technique-aware thresholds ─────────────────────────────────
//
// The arrangement XML includes technique flags on individual notes. _ndScoreChord
// reads these from the chord note objects and adjusts thresholds before calling
// _ndConstraintCheckString:
//
//   ho / po (hammer-on / pull-off)
//     No fresh pick attack, so string energy will be lower than a picked note.
//     energyThreshold is halved from 0.03 to 0.015.
//
//   b / sl (bend / slide)
//     Pitch is moving continuously during the note. pitchCheckCents is widened
//     to at least 100 cents (a semitone) so a note mid-bend still registers.
//
//   hm (harmonic)
//     The fundamental is suppressed; the audible pitch is at 2x or 1.5x the
//     fret frequency. Pitch checking against the fundamental is unreliable, so
//     pitchCheckCents is set to 0 (energy-only check). A proper harmonic
//     frequency check (checking at 2x/1.5x) is a known TODO — see the comment
//     inside _ndScoreChord.
//
// ── CHANGE 5: chordHitRatio setting ──────────────────────────────────────
//
// The fraction of a chord's strings that must register energy to count as a
// hit. Default 0.6 (60% — e.g. 4 of 6 strings for a full barre chord). Lower
// values suit beginners or players using lighter touches on inner strings;
// higher values enforce stricter accuracy.
//
// Exposed in the settings panel as "Chord Leniency" (slider: 25–100%).
// Persisted in localStorage under the existing _ND_STORAGE_KEY alongside all
// other settings. Loaded and clamped to [0.25, 1] on construction so a stale
// persisted value can't put scoring in a state the slider can't represent.
//
// ── CHANGE 6: HUD chord display ──────────────────────────────────────────
//
// The cyan detected-note line in the HUD (`.nd-hud-detected`) previously only
// showed output when a confident single-note detection existed. It now also
// shows the most recent chord constraint result when no single note is detected,
// e.g. "chord 4/6 (66%)". This gives the player real-time visibility into
// whether the constraint scorer is seeing their strings ring, which is useful
// for diagnosing audio input issues and tuning the Chord Leniency setting.
// lastChordScore / lastChordHit / lastChordTotal are reset with the rest of
// scoring state in resetScoring().

// ── Module-level shared state ──────────────────────────────────────────────

// Shared state anchored on `window` so multiple evaluations of this
// file (HMR, accidental double <script> load) all see the same
// registry and model-load state. A bare module-scoped Set would let
// the second evaluation register its detectors into a fresh set
// while the first evaluation's live playSong wrapper iterates the
// old set — breaking song-switch disable/reset on any detector
// created by the second eval.
//
// `_ndShared` is initialised once; subsequent evaluations reuse the
// existing object. All mutable shared state (CREPE model, loading
// flag, instance registry, playSong-hook retry counter) lives on it
// so reassignments land on the canonical object, not on a fresh
// module-scope copy.
// ── Desktop-bridge back-compat ──────────────────────────────────────────────
// The host renamed window.slopsmithDesktop → window.feedBackDesktop
// (got-feedback/feedBack-desktop#40). On desktop builds that still expose only
// the legacy name, alias it so the feedBackDesktop reads below work on every
// desktop in any release order. No-op in the browser and on the new bridge.
import {
    _ND_TUNING_BASS_4, _ND_TUNING_BASS_5, _ND_TUNING_BASS_6,
    _ND_TUNING_GUITAR_6, _ND_TUNING_GUITAR_7, _ND_TUNING_GUITAR_8,
    _ND_PITCH_NAMES,
    _ndArrangementKindFromName, _ndStandardMidiFor,
    _ndFreqToMidi, _ndMidiToName, _ndMidiFromStringFret, _ndMidiToStringFret,
    _ndFoldOctaveCents, _ndNearestOctaveCents, _ndResolveDisplayFingering,
    _ndNextPow2, _ndParabolicOffset,
} from './pitch-math.js';
import {
    _ndClassifyTiming, _ndClassifyPitch,
    ND_BASE_SINGLE, ND_BASE_CHORD,
    _ndMultiplierForStreak, _ndIsStreakMilestone,
    _ndGradeFor, _ndComputeBestDelta, _ndPickHeroAction,
    _ndGradeClean,
} from './classify.js';
import { createHUD } from './hud.js';
import {
    _ndEscapeHtml, _ndInstrumentLabel, _ndSongArtUrl,
    _ndShareCardText, _ndShareCardFilename, _ndAutoSaveFilename,
} from './format.js';
import {
    _ND_DRILL_LEAD_IN_SEC, _ND_DRILL_FIRST_NOTE_RUNWAY_SEC, _ND_DRILL_DEFAULT_GOAL,
    _ND_DRILL_DEFAULT_LADDER, _ND_DRILL_FULLSPEED_REPS,
    _ndDrillRampDecision, _ndDrillPassScore, _ndAutoDrillShouldTrigger,
    _ndAutoDrillRange, _ndDescribeMiss, _ndSummarizeWindowMisses,
} from './drill-math.js';
import {
    _ND_MIN_DETECTABLE_HZ,
    _ndFftMagnitude, _ndHpsDetect,
} from './dsp.js';
import { _ndSetLogAppend, _ndSetLogAverage } from './set-math.js';
import { createSummaryUi } from './summary-ui.js';
import { createDrillConductor } from './drill-conductor.js';
import { createSettingsPanel } from './settings-panel.js';
import { createAvCalibrate } from './av-calibrate.js';
import { createDiagnosticCatalog } from './diagnostic-catalog.js';
import { createRecordingCapture, _ndEncodeWavPcm16 } from './recording-capture.js';
import { createCalibrationWizard } from './calibration-wizard.js';
try {
    if (typeof window !== 'undefined' && !window.feedBackDesktop && window.slopsmithDesktop) {
        window.feedBackDesktop = window.slopsmithDesktop;
    }
} catch (_) { /* frozen window — ignore */ }

const _ndShared = (window.__ndShared = window.__ndShared || {
    model: null,          // CREPE/SPICE model (single ~20 MB load)
    modelLoading: false,
    instances: new Set(), // live detector APIs — iterated by playSong hook
    playSongRetries: 0,   // bounded-retry counter for _ndInstallPlaySongHook
    // Most-recent filename passed to playSong(). hw.getSongInfo() doesn't
    // expose a `filename` field (per the WS song_info contract), but
    // playSong's first arg IS the custom song filename — capture it in the
    // wrapper so the training-bundle manifest can populate the custom song
    // File Name field that getSongInfo can't supply on its own.
    currentFilename: null,
    // Token of the detector instance that currently owns an engine chart slot
    // for a contained-playback verifier (setContainedChart), plus the engine
    // SOURCE that slot belongs to. The engine has one chart slot PER source; a
    // contained chart and the host-song chart contend for the same slot, and so
    // do two detector instances bound to the SAME source (split-screen). These
    // cross-instance fields let setContainedChart refuse a second arm on that
    // source, AND let every instance on that source skip its own host-chart
    // pushes/drains while another instance holds the contained slot — so a
    // non-owning instance can't overwrite the contained chart. Instances bound
    // to a DIFFERENT source use a different slot and are unaffected.
    // Map of engine sourceId (null = default source 0) -> the detector instance
    // that owns the contained chart slot on THAT source. Keyed per source because
    // each source has its own engine chart slot — two instances on the same
    // source contend (only one may hold the contained slot), but instances on
    // different sources don't. setContainedChart refuses a second arm on a source
    // already owned, and every instance on a source skips its own host-chart
    // pushes/drains while another instance owns that source's contained slot.
    containedSlotOwners: new Map(),
    // Snapshot for "Return to Previous Song" after a Detection Health
    // diagnostic playthrough — one slot, screen.js only.
    diagnosticReturn: {
        active: false,
        previousFilename: null,
        previousArrangementIndex: null,
        previousTitle: null,
        previousArtist: null,
        launchedTrackId: null,
        diagnosticFilename: null,
    },
});
// HMR / prior evaluations may lack diagnosticReturn on the reused object.
if (!_ndShared.diagnosticReturn) {
    _ndShared.diagnosticReturn = {
        active: false,
        previousFilename: null,
        previousArrangementIndex: null,
        previousTitle: null,
        previousArtist: null,
        launchedTrackId: null,
        diagnosticFilename: null,
    };
}
// Local aliases — kept for readability of the rest of the file, but
// they're the same objects as `window.__ndShared.*`.
const _ndInstances = _ndShared.instances;

// ── ML note-detection gate (cross-instance, refcounted) ────────────────────
// The desktop engine's polyphonic ML detector (Basic Pitch) defaults OFF and
// is the most expensive thing in the audio engine. On the default desktop path
// scoring runs through the harmonic-comb engine NoteVerifier and NOTHING reads
// the ML detector (the engine-verifier tick returns before matchNotes and uses
// getRawPitch for the live glow). ML is read only in native-frame detection and
// the non-verifier fallback. So we arm the engine ML pipeline (via the new
// setNoteDetectionEnabled bridge) only while at least one detector instance is
// actually in a mode that reads ML — keyed per instance so one instance
// disarming can't suspend ML for another still using it. No-op on a downlevel
// addon that predates the bridge method (ML then runs as before — fail-safe).
if (!_ndShared.mlGateWanters) _ndShared.mlGateWanters = new Set();
if (typeof _ndShared.mlGateOn !== 'boolean') _ndShared.mlGateOn = false;
function _ndSyncMlGate(token, wantsMl, audio) {
    const wanters = _ndShared.mlGateWanters;
    if (wantsMl) wanters.add(token); else wanters.delete(token);
    const desired = wanters.size > 0;
    if (desired === _ndShared.mlGateOn) return;          // already in the right state
    if (!audio || typeof audio.setNoteDetectionEnabled !== 'function') return;
    try {
        audio.setNoteDetectionEnabled(desired);
        _ndShared.mlGateOn = desired;                    // commit only on success → retries on failure
    } catch (_) { /* downlevel / transient — leave state so a later sync retries */ }
}

const _ND_DIAGNOSTIC_FILENAME_MARKERS = [
    'slopsmith-diagnostic-basic-guitar.sloppak',
];

function _ndFilenameLooksDiagnostic(fn) {
    const lower = String(fn || '').toLowerCase();
    if (!lower) return false;
    return _ND_DIAGNOSTIC_FILENAME_MARKERS.some((m) => lower.includes(m));
}

// Escape untrusted text before interpolating into an innerHTML string.
function _ndClearDiagnosticReturnState() {
    const r = _ndShared.diagnosticReturn;
    if (!r) return;
    r.active = false;
    r.previousFilename = null;
    r.previousArrangementIndex = null;
    r.previousTitle = null;
    r.previousArtist = null;
    r.launchedTrackId = null;
    r.diagnosticFilename = null;
}

// (The playSong wrapper's idempotency guard lives on the wrapper
// function object itself — see `_ndInstallPlaySongHook()` below —
// so it persists across HMR / double-<script>-load where a
// module-level flag would be reset.)

const _ND_STORAGE_KEY = 'slopsmith_notedetect';

// How long the construct-time auto-enable waits before its single retry
// when the first attempt fails (e.g. a USB interface that's enumerated but
// not yet openable at first paint). Long enough for a slow device to settle,
// short enough not to strand a persisted-on session.
const _ND_AUTO_ENABLE_RETRY_MS = 1500;

// Plugin semver — keep in sync with package.json / plugin.json. Stamped
// into every diagnostic export so a JSON blob can be tied back to the
// exact build that produced it. The script tag has no `import`/`fetch`
// hook to read package.json at load time, so this is the single
// hand-maintained constant the diagnostic path keys off of.
const _ND_VERSION = '1.33.0';

// Bleed-rescue tuning for the low-bass blind spot. A bass DI's fundamental is
// weaker than its 2nd harmonic and an open string / neighbour often rings the
// loudest bin in the band, so a present low note fails the single-peak pitch
// check. When that happens we confirm the EXPECTED note directly by its
// harmonic comb. Ported from slopsmith note_detect 1.39.1 (primitive recall
// 59%→72% on a clean bass take); see _ndHarmonicCombCount / tools/probe-bleed.js.
const _ND_HARMONIC_FALLBACK_MAX_HZ = 140;   // ~C#3; covers the whole 4-string bass blind spot
const _ND_HARMONIC_FALLBACK_RATIOS = [1, 2, 3, 4, 5];
const _ND_HARMONIC_FALLBACK_HALF_CENTS = 80; // ±half-window around each harmonic (≈1.5 coarse low bins)
const _ND_HARMONIC_FALLBACK_PEAK_FRAC = 0.40; // each counted harmonic ≥ this fraction of the band peak
const _ND_HARMONIC_FALLBACK_MIN_HARMONICS = 3; // need this many coherent harmonics to accept

// Low-energy comb rescue for low power chords (E5/A5/B5 near the nut) played
// with distortion or palm-muting. Those pile energy into upper harmonics, so
// the fundamental's own band drops below the 3% "ringing" bar even though the
// note is plainly there — the string reads silent and the chord bins as a
// "partial chord" miss (the tester's report). Below the 3% gate but at/above
// this floor, a low note is not conceded on energy alone: the same strict
// harmonic-comb test above must confirm it. The floor keeps a genuinely dead
// string out — a low string's band already holds ~1% of a flat-noise spectrum
// just from its width, so the floor sits clear of that. Calibration knob: if
// on-device chugs still miss, lower it and watch for false positives.
const _ND_LOW_ENERGY_RESCUE_FLOOR = 0.015; // band-energy fraction; rescue eligible in [floor, 0.03)
// Post-miss PRESENCE check (coaching fault attribution, not hit/miss): how many
// coherent harmonics of the expected note must appear for us to say the player
// DID play it (so the miss is a detector blind-spot, not a no-play).
const _ND_PRESENCE_MIN_COMB = 2;

// Audio processing constants
const _ND_MIN_YIN_SAMPLES = 4096;  // enough for low E at 48kHz (need tau=585, halfLen=2048)
// ScriptProcessor buffer size. The YIN analysis buffer is a separate
// _ND_MIN_YIN_SAMPLES (4096) that accumulates across callbacks, so
// shrinking the audio-callback granularity here doesn't reduce
// detection resolution — it only halves the input-side buffering
// latency (1024/48000 ≈ 21 ms vs 2048/48000 ≈ 43 ms). Matches the
// headless harness's default --frame-size.
const _ND_FRAME_SIZE = 1024;       // ScriptProcessor buffer size (hard fallback)
// Valid ScriptProcessor buffer sizes; the persisted `frameSize` setting is
// clamped to this set on load. EMPIRICAL CORRECTION to the note above: the
// callback chunk size DOES affect bass recall — harness on a real take gives
// 1024→27%, 2048→77%, 4096→68%. The 4096-sample accumulation does NOT fully
// compensate for a too-short callback granularity on low fundamentals, so the
// per-instance default is 2048, not _ND_FRAME_SIZE.
const _ND_VALID_FRAME_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384];
function _ndClampFrameSize(v) {
    v = Number(v);
    return _ND_VALID_FRAME_SIZES.includes(v) ? v : 2048;
}

// Pitch window the DSP band-energy scorer uses to VERIFY a single note
// (confirm the expected pitch is what is ringing, vs. a neighbouring
// fret ~100 cents away). Deliberately decoupled from the user's
// pitch_tolerance_cents — that setting governs the strict hit/miss
// pitch CALL in makeMatchedJudgment, which is far tighter than what a
// coarse FFT peak can verify. 50 cents = a quarter-tone, enough to
// disambiguate adjacent frets without rejecting real-world intonation.
const _ND_VERIFY_PITCH_CENTS = 50;
// Bass widens the pitch-verify window: a low-string fundamental (B0 ≈ 31 Hz)
// spans barely one FFT bin (~157 cents/bin), so even the engine's
// harmonic-blended pitch estimate is coarser than guitar's. 60 cents still
// disambiguates adjacent bass frets (a semitone is 100 cents) without
// rejecting real intonation on a note the low bins resolve loosely.
const _ND_VERIFY_PITCH_CENTS_BASS = 60;

// Minimum harmonic-to-floor ratio for the desktop engine's harmonic-comb
// verifier (scoreChord harmonicVerify mode) to count a single note as
// present. Tunable here — it rides through the IPC, so calibration does
// not need a native rebuild.
const _ND_VERIFY_HARMONIC_SNR = 3.0;
// Bass lowers the harmonic-to-floor ratio. A bass DI puts less of its energy
// into the upper partials the comb sums (the fundamental is strong but the
// harmonic stack is shorter than a guitar's), so the guitar SNR gate of 3.0
// under-counts genuine low notes — measured against a real bass DI calibration
// take, dropping to 2.0 raised picked-note recall ~81%→86% with no loss on
// fingerstyle and no real-world precision cost (the verifier only ever scores
// the *charted* note, and silence is still rejected by the separate floor/
// average-bin denominator, not this ratio). Rides the IPC — no native rebuild.
const _ND_VERIFY_HARMONIC_SNR_BASS = 2.0;

// Fundamental-presence gate for the harmonic-comb verifier (scoreChord
// `fundamentalRatio`): a note is rejected when its f0 peak is weaker than
// ratio × its strongest partial — the specificity guard against octave-up
// impostors. Guitar's DI fundamental is healthy, so 0.20 is safe. A bass DI
// fundamental is routinely WEAKER than the 2nd harmonic (amp-sim DIs,
// compression, roll-off below ~60 Hz — see _ndHpsDetect), so the guitar gate
// false-rejects real bass notes; bass uses a low ratio that still rejects a
// true octave impostor (which has ~no energy at f0) but passes a weak-but-
// present fundamental. Rides the IPC — no native rebuild to recalibrate.
const _ND_VERIFY_FUNDAMENTAL_RATIO = 0.20;
const _ND_VERIFY_FUNDAMENTAL_RATIO_BASS = 0.08;

// Temporal-persistence floor for the engine NoteVerifier (setChart
// `presenceRatio`): a chart note counts as hit only when the comb confirms its
// pitch in at least this FRACTION of the frames scored in its window, instead
// of the legacy "ever present" (any single frame). Measured against real
// wrong-position bass DI takes: a correctly-fretted note rings present through
// ~70-100% of its frames, while a note played 2 frets off only flickers present
// on a handful of stray frames (its harmonics don't align with the comb), so a
// 0.3 floor cuts wrong-position false-accepts ~70-95% with no loss on the
// correct take. Guitar keeps 0 (legacy ever-present, byte-identical) — guitar
// was never reported to false-accept and a floor risks dropping fast/staccato
// passages. Rides the IPC — no native rebuild to recalibrate.
const _ND_VERIFY_PRESENCE_RATIO = 0.0;
const _ND_VERIFY_PRESENCE_RATIO_BASS = 0.3;

// Fraction of a verify target's strings that must ring for notedetect:verify
// to fire. Deliberately FIXED and independent of the user-facing gameplay
// `chordHitRatio` slider: a verify consumer (Step Mode) needs stable,
// predictable chord acceptance, not one that drifts with a scoring preference.
// 0.5 keeps it forgiving (single notes are 1/1 = always pass) without letting
// a 2-of-5 partial voicing count as the chord.
const _ND_VERIFY_MIN_HIT_RATIO = 0.5;

// Per-arrangement harmonic-comb verify parameters. `harmonicSnr` and
// `fundamentalRatio` feed both the setChart payload and the scoreChord
// harmonic-verify call. This helper's `pitchCheckCents` feeds only the
// scoreChord call; setChart's own `pitchCheckCents` field is populated from
// the user's Pitch-tolerance slider instead, not from this helper.
function _ndVerifyParamsFor(arrangement) {
    const bass = arrangement === 'bass';
    return {
        pitchCheckCents: bass ? _ND_VERIFY_PITCH_CENTS_BASS : _ND_VERIFY_PITCH_CENTS,
        harmonicSnr: bass ? _ND_VERIFY_HARMONIC_SNR_BASS : _ND_VERIFY_HARMONIC_SNR,
        fundamentalRatio: bass ? _ND_VERIFY_FUNDAMENTAL_RATIO_BASS : _ND_VERIFY_FUNDAMENTAL_RATIO,
        presenceRatio: bass ? _ND_VERIFY_PRESENCE_RATIO_BASS : _ND_VERIFY_PRESENCE_RATIO,
    };
}

// Tuning tables — standard-tuning MIDI base per (arrangement, stringCount).
//
// Bass ascends in perfect fourths end-to-end; guitar is fourths except
// the major third between G3→B3 (the standard irregularity). Low B on
// 5-string bass and 7-string guitar both add a perfect fourth below
// the standard low-E string. 8-string guitar adds a further low F#1
// below that (a perfect fourth below B1), matching the most common
// Ibanez/Schecter 8-string standard tuning.

// Calibration-wizard instrument presets (standalone, no song to read tuning
// from). Each maps to an arrangement + stringCount that _ndStandardMidiFor
// turns into the per-string open-note tuning above.
const _CAL_WIZARD_INSTRUMENT_CONFIGS = [
    { id: 'bass-4',   label: '4-string bass',          arrangement: 'bass',   stringCount: 4 },
    { id: 'bass-5',   label: '5-string bass',          arrangement: 'bass',   stringCount: 5 },
    { id: 'bass-6',   label: '6-string bass',          arrangement: 'bass',   stringCount: 6 },
    { id: 'guitar-6', label: '6-string guitar',        arrangement: 'guitar', stringCount: 6 },
    { id: 'guitar-7', label: '7-string guitar',        arrangement: 'guitar', stringCount: 7 },
    { id: 'guitar-8', label: '8-string guitar',        arrangement: 'guitar', stringCount: 8 },
];


// Stable fingerprint of the tuning context a verify target is scored under.
// A (string, fret) only maps to a pitch under a specific arrangement + string
// count + per-string offsets + capo, so a target is meaningless once that
// context changes. Used to bind a verify target to its context and drop it on
// mismatch. Pure — takes the context explicitly so the host-chart binding and
// a caller-supplied override (setVerifyTarget's ctx) share one definition.
function _ndVerifySigFor(arrangement, stringCount, offsets, capo) {
    return arrangement + '|' + stringCount + '|'
        + offsets.slice(0, stringCount).join(',') + '|' + capo;
}

// Sanitize a caller-supplied verify context (setVerifyTarget's 2nd arg) into a
// coherent { arrangement, stringCount, offsets, capo }, or null when no usable
// context object was passed (→ score against the host song's live tuning, the
// back-compat Step Mode behavior). Lets a non-chart consumer (contained
// playback: SlopScale, Chord Sprint) verify against the player's real
// instrument instead of whatever song the host highway happens to have loaded.
//
// The per-string tuning may be given two ways (checked in this order):
//   • `openMidis`: ABSOLUTE open-string MIDI per string (e.g. [40,45,50,55,59,
//     64] for standard guitar) — what a non-chart consumer naturally holds.
//     Converted here to standard-tuning offsets. These are the REAL sounding
//     open pitches (any capo is already baked in), so the openMidis path
//     forces capo 0 — applying ctx.capo on top would transpose twice.
//   • `tuning` / `offsets`: per-string semitone OFFSETS from standard tuning
//     (the chart convention, matching the instance's tuningOffsets). `offsets`
//     is also accepted so getVerifyContext() output round-trips back in. This
//     path honors ctx.capo.
// Either array is read BY STRING INDEX — a non-finite entry maps to 0 in place,
// never reindexed, so one bad string can't shift the others' pitch mapping.
//
// `arrangement` is optional: when omitted and absolute openMidis were given,
// it's inferred as whichever of bass/guitar the pitches sit closest to (so a
// 5-string bass isn't mis-scored — and mis-parameterized — as a guitar);
// otherwise it defaults to guitar.
function _ndSanitizeVerifyCtx(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    const rawOpen = Array.isArray(ctx.openMidis) ? ctx.openMidis : null;
    const rawOff = Array.isArray(ctx.tuning) ? ctx.tuning
        : (Array.isArray(ctx.offsets) ? ctx.offsets : null);
    // String count: explicit wins; else the source array length; else (no
    // array) the arrangement default.
    const srcLen = (rawOpen && rawOpen.length) || (rawOff && rawOff.length) || 0;
    const explicitArr = (ctx.arrangement != null)
        ? _ndArrangementKindFromName(ctx.arrangement) : null;
    let stringCount = Number.isInteger(ctx.stringCount) && ctx.stringCount > 0
        ? ctx.stringCount
        : (srcLen || ((explicitArr || 'guitar') === 'bass' ? 4 : 6));
    stringCount = Math.max(1, Math.min(8, stringCount));
    // Arrangement: explicit wins; else infer from absolute pitches; else guitar.
    const arrangement = explicitArr
        || (rawOpen ? _ndInferArrangementFromOpenMidis(rawOpen, stringCount) : 'guitar');
    // Clamp to the arrangement's supported tuning-table range so the scorer's
    // standard base always covers every string — _ndStandardMidiFor only models
    // bass 4/5 and guitar 6/7/8, and a higher count would index an undefined
    // base (NaN pitch, never verifies). 6-string bass is out of scope here.
    stringCount = Math.min(stringCount, arrangement === 'bass' ? 5 : 8);
    const offsets = [];
    let capo;
    if (rawOpen) {
        // Absolute open MIDI → offsets from this arrangement's standard tuning.
        const base = _ndStandardMidiFor(arrangement, stringCount);
        for (let s = 0; s < stringCount; s++) {
            const m = rawOpen[s];
            offsets.push(Number.isFinite(m) && Number.isFinite(base[s])
                ? Math.round(m - base[s]) : 0);
        }
        // openMidis already encode the real (capoed) open pitches.
        capo = 0;
    } else {
        // Offsets convention. Read by string index, non-finite → 0.
        for (let s = 0; s < stringCount; s++) {
            const v = rawOff ? rawOff[s] : 0;
            offsets.push(Number.isFinite(v) ? Math.trunc(v) : 0);
        }
        capo = Number.isInteger(ctx.capo) && ctx.capo >= 0 ? ctx.capo : 0;
    }
    return { arrangement, stringCount, offsets, capo };
}

// Pick the arrangement (bass/guitar) whose standard tuning a set of absolute
// open-string MIDI values sits closest to — used to infer arrangement when a
// caller supplies openMidis without naming one. A non-finite/out-of-range
// string contributes a fixed penalty so partial data still resolves sanely.
function _ndInferArrangementFromOpenMidis(openMidis, stringCount) {
    const totalDistance = (arrangement) => {
        const base = _ndStandardMidiFor(arrangement, stringCount);
        let sum = 0;
        for (let s = 0; s < stringCount; s++) {
            const m = openMidis[s];
            sum += (Number.isFinite(m) && Number.isFinite(base[s])) ? Math.abs(m - base[s]) : 12;
        }
        return sum;
    };
    return totalDistance('bass') < totalDistance('guitar') ? 'bass' : 'guitar';
}

// ── Pure mapping helpers ───────────────────────────────────────────────────
// All take state (arrangement, stringCount, offsets, capo) as explicit args
// so they remain safe to call across multiple instances with different
// tunings. No module-level mutable fallbacks — the factory closure passes
// its own state in.



// ── Game-scoring layer: points / multiplier / grade ─────────────────────
// Pure helpers shared by the live HUD, the end-of-song summary, and the
// highway FX contract. Kept top-level (not in the factory closure) so the
// vm test loader can exercise them directly.


// Scoring-UI skin. One global preference shared by every instance (and read
// by the highway renderer for its FX palette), stored under a standalone
// key so non-notedetect consumers don't have to parse the settings blob.
const ND_SKINS = ['neon', 'esports', 'metal'];
const ND_SKIN_STORAGE_KEY = 'slopsmith_notedetect_skin';

// Runtime mirror of the skin preference. Keeps getSkin()/setSkin()
// coherent for the session when localStorage is unavailable (private
// mode, quota): readable storage wins, the mirror is the fallback — so a
// setSkin() whose persist failed still themes consistently until reload.
let _ndSkinRuntime = 'neon';

function _ndLoadSkin() {
    try {
        const v = localStorage.getItem(ND_SKIN_STORAGE_KEY);
        if (ND_SKINS.indexOf(v) !== -1) {
            _ndSkinRuntime = v;
            return v;
        }
    } catch (e) { /* storage unavailable — fall through to the mirror */ }
    return _ndSkinRuntime;
}




// Contextual hero CTA — which action gets the emphasised (primary) slot on the
// results card, chosen from the SHAPE of the result so the nudge points at the
// highest-value next step instead of always "retry the whole song". Deliberate-
// practice principle: when the failure is LOCALIZED to one section, drilling it
// beats grinding bars you already own. Pure + tunable; the caller resolves the
// section's loop range and renders. Everything stays a suggestion — nothing is
// gated, and Retry remains available even when it isn't the hero.
//   ctx: { accuracy, canRetry, sections: [{ name, acc|null }] }  (acc null = no
//   notes in that section — skipped). Returns { kind, sectionName?, reason }.
//     'practice-section' — one section is the clear weak outlier; drill it.
//     'retry'            — broadly rough / no clear outlier; replay the whole.

// ── Results-card share image (Copy card / Save) ──────────────────────────
// A shareable PNG of the end-of-song results, rendered in note_detect's own
// skin (palette + display fonts read live off the overlay), NOT the host's.
// Mirrors the robust host-checked fallback ladder used elsewhere in the
// ecosystem: image→clipboard → download PNG → text.



// Results "text glow" A/B setting (standalone key so the card reads it
// directly). Off by default — the glow bled into the digits (readability).
function _ndResultsGlowOn() {
    try { return localStorage.getItem('slopsmith_notedetect_results_glow') === '1'; }
    catch (e) { return false; }
}

// User-configured folder the Save button writes to ('' → server default =
// the user's Pictures folder).
function _ndSaveDir() {
    try { return (localStorage.getItem('slopsmith_notedetect_save_dir') || '').trim(); }
    catch (e) { return ''; }
}

// Auto-save a results card to disk after every (scored) song? Opt-in, default
// OFF. The song-end summary reads this; settings.html writes the key.
function _ndAutoSaveEnabled() {
    try { return localStorage.getItem('slopsmith_notedetect_autosave_card') === '1'; }
    catch (e) { return false; }
}

// Queue auto-advance delay (seconds) between a queued song's results card and
// the next track starting. A plain manual number (the tester ask — presets
// felt limiting): 0 = advance immediately, anything larger counts down
// visibly on the card. Default 10 s; settings.html writes the key.
function _ndQueueDelaySeconds() {
    try {
        const v = parseFloat(localStorage.getItem('slopsmith_notedetect_queue_delay'));
        return (Number.isFinite(v) && v >= 0) ? v : 10;
    } catch (e) { return 10; }
}

// Auto-drill threshold: jump into a drill loop after this many CONTIGUOUS missed
// notes while playing (0 = off, the default). settings.html writes the key;
// screen.js caches it at enable()/resetScoring and evaluates it on each miss.
function _ndAutoDrillMissesSetting() {
    try {
        const v = parseInt(localStorage.getItem('slopsmith_notedetect_autodrill_misses'), 10);
        return (Number.isFinite(v) && v > 0) ? v : 0;
    } catch (e) { return 0; }
}

// Playlist-queue display toggles (both default ON; settings.html writes the
// keys). "Show scores" off collapses a queued song's card to just the
// Up-Next countdown — advance on the countdown alone; the set still logs
// for the end-of-set summary. "Set summary" off skips the summary card
// after the last song.
function _ndQueueShowScores() {
    try { return localStorage.getItem('slopsmith_notedetect_queue_show_scores') !== '0'; }
    catch (e) { return true; }
}

function _ndQueueSetSummaryEnabled() {
    try { return localStorage.getItem('slopsmith_notedetect_queue_set_summary') !== '0'; }
    catch (e) { return true; }
}

// End-of-set score log (playlist "Play All"): one entry per naturally-
// finished queued song — {pos, total, filename, title, artist, accuracy,
// hits, misses} — consumed by the end-of-set summary card after the last
// song. Module-level: one queue plays at a time.
let _ndSetLog = [];

// Personal-best store for the "beat your best" delta — one localStorage map
// keyed by song+arrangement, holding the field-wise best run seen. Always on
// (no setting); the value only ever rises, and it's the user's own private
// trajectory data.
const _ND_SONG_BEST_KEY = 'slopsmith_notedetect_song_best';
const _ND_SONG_BEST_MAX = 600;   // cap entries so the map can't grow unbounded
function _ndSongBestId(filename, arrangementIndex) {
    return String(filename || '') + '#'
        + (Number.isFinite(arrangementIndex) ? arrangementIndex : '');
}
function _ndReadSongBest(id) {
    try {
        const raw = localStorage.getItem(_ND_SONG_BEST_KEY);
        if (!raw) return null;
        const map = JSON.parse(raw);
        return (map && map[id]) ? map[id] : null;
    } catch (e) { return null; }
}
function _ndWriteSongBest(id, run) {
    try {
        let map = {};
        const raw = localStorage.getItem(_ND_SONG_BEST_KEY);
        if (raw) { try { map = JSON.parse(raw) || {}; } catch (e) { map = {}; } }
        const prev = map[id] || null;
        const max = (k, scale) => Math.max(
            Math.round((Number(run[k]) || 0) * (scale || 1)) / (scale || 1),
            prev ? (Number(prev[k]) || 0) : 0);
        map[id] = {
            accuracy: max('accuracy'),
            score: max('score'),
            bestStreak: max('bestStreak'),
            ts: Date.now(),
        };
        // Bound the map: past the cap, evict the least-recently-updated entries
        // so the blob can't grow without limit (and trip quota, which would then
        // silently stop recording every song's best).
        const keys = Object.keys(map);
        if (keys.length > _ND_SONG_BEST_MAX) {
            keys.sort((a, b) => (Number(map[a].ts) || 0) - (Number(map[b].ts) || 0));
            for (const k of keys.slice(0, keys.length - _ND_SONG_BEST_MAX)) delete map[k];
        }
        localStorage.setItem(_ND_SONG_BEST_KEY, JSON.stringify(map));
    } catch (e) { /* non-fatal — best-tracking is cosmetic */ }
}

// Transient skin-themed toast (used for "Saved to …"). Self-removing.
function _ndToast(message, ms) {
    if (typeof document === 'undefined' || !document.body) return;
    try {
        const t = document.createElement('div');
        t.className = 'nd-toast';
        try { t.setAttribute('data-nd-skin', _ndLoadSkin()); } catch (e) {}
        t.textContent = String(message == null ? '' : message);
        document.body.appendChild(t);
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => { try { t.classList.add('nd-toast-in'); } catch (e) {} });
        } else { t.classList.add('nd-toast-in'); }
        setTimeout(() => {
            try { t.classList.remove('nd-toast-in'); } catch (e) {}
            setTimeout(() => { try { t.remove(); } catch (e) {} }, 400);
        }, ms || 6000);
    } catch (e) {}
}




// Render the results into a 1200×630 canvas using the live skin. Returns the
// canvas, or null when canvas/2d isn't available (vm sandbox / old host).
async function _ndRenderShareCard(data, overlayEl) {
    const d = data || {};
    if (typeof document === 'undefined' || !document.createElement) return null;
    const cv = document.createElement('canvas');
    cv.width = 1200; cv.height = 630;
    const ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return null;
    // The bundled display fonts (Orbitron / Rajdhani / Russo One / Black Ops
    // One) are document-loaded by the stylesheet; wait so the canvas text
    // matches the on-screen card instead of falling back to a system font.
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}

    // Album art (optional) — same-origin so toBlob() stays untainted. Resolves
    // null on a 404 (art-less song) or any load error; the card just omits it.
    let artImg = null;
    if (d.artUrl) {
        try {
            artImg = await new Promise((res) => {
                const im = new Image();
                im.onload = () => res(im.naturalWidth ? im : null);
                im.onerror = () => res(null);
                im.src = d.artUrl;
            });
        } catch (e) { artImg = null; }
    }

    // Resolve the active skin's palette + fonts off the overlay's computed
    // style (it carries data-nd-skin), with the neon defaults as fallback.
    const cssVar = (name, fallback) => {
        try {
            if (overlayEl && typeof getComputedStyle === 'function') {
                const v = getComputedStyle(overlayEl).getPropertyValue(name).trim();
                if (v) return v;
            }
        } catch (e) {}
        return fallback;
    };
    const accent  = cssVar('--nd-accent',  '#00f0ff');
    const accent2 = cssVar('--nd-accent2', '#ff2ec4');
    const hit     = cssVar('--nd-hit',     '#00ff88');
    const miss    = cssVar('--nd-miss',    '#ff4444');
    const text    = cssVar('--nd-text',    '#e8f6ff');
    const dim     = cssVar('--nd-dim',     '#7c93a8');
    const warn    = cssVar('--nd-warn',    '#ffcc00');
    const bg      = cssVar('--nd-bg',      'rgba(6,10,24,0.82)');
    const fDisp   = cssVar('--nd-font-display', "'Orbitron', sans-serif");

    const W = 1200, H = 630, P = 72;
    const font = (px, stack, weight) => { ctx.font = `${weight || 700} ${px}px ${stack}`; };
    const fit = (s, maxW) => {
        s = String(s == null ? '' : s);
        if (ctx.measureText(s).width <= maxW) return s;
        let t = s;
        while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
        return t + '…';
    };
    const spaced = (px) => { try { ctx.letterSpacing = px + 'px'; } catch (e) {} };

    // Opaque base first (--nd-bg can be translucent → no see-through PNG).
    ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 6);                 // accent spine
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
    ctx.strokeRect(28.5, 28.5, W - 57, H - 57);                       // hairline frame
    ctx.textBaseline = 'alphabetic';

    // Optional text glow (A/B setting) — off by default for legibility.
    const glow = _ndResultsGlowOn();
    const glowSet = (color) => { if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 16; } };
    const glowClear = () => { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; };

    // Album art (top-right) — same-origin, cover-fit, accent-framed.
    const A = 190, artX = W - P - A, artY = 64, artR = 14;
    if (artImg) {
        ctx.save();
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(artX, artY, A, A, artR); else ctx.rect(artX, artY, A, A);
        ctx.closePath(); ctx.clip();
        const iw = artImg.naturalWidth, ih = artImg.naturalHeight;
        const s = Math.max(A / iw, A / ih), dw = iw * s, dh = ih * s;
        ctx.drawImage(artImg, artX + (A - dw) / 2, artY + (A - dh) / 2, dw, dh);
        ctx.restore();
        ctx.strokeStyle = accent; ctx.lineWidth = 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(artX + 1, artY + 1, A - 2, A - 2, artR); else ctx.rect(artX + 1, artY + 1, A - 2, A - 2);
        ctx.stroke();
    }
    const leftMaxW = (artImg ? artX - 28 : W - P) - P;

    // Eyebrow + hero title + sub (top-left). eyebrow/hero are overridable so
    // another plugin can drive the same card with its own labels.
    spaced(6); ctx.fillStyle = dim; font(20, fDisp, 700);
    ctx.fillText(String(d.eyebrow || 'SONG COMPLETE').toUpperCase(), P, 92); spaced(0);
    let heroSize = 64; font(heroSize, fDisp, 800);
    const heroText = d.hero || d.title || 'Song Complete';
    if (ctx.measureText(heroText).width > leftMaxW) { heroSize = 48; font(heroSize, fDisp, 800); }
    glowSet(text); ctx.fillStyle = text; ctx.fillText(fit(heroText, leftMaxW), P, 156); glowClear();
    const sub = [d.artist, d.instrument].filter(Boolean).join('   ·   ');
    if (sub) { spaced(2); ctx.fillStyle = dim; font(24, fDisp, 500); ctx.fillText(fit(sub.toUpperCase(), leftMaxW), P, 196); spaced(0); }

    // Full-combo badge — right-aligned under the art (top-right with no art).
    if (d.fullCombo) {
        spaced(4); glowSet(hit); ctx.fillStyle = hit; font(22, fDisp, 700);
        const fcW = ctx.measureText('★ FULL COMBO').width + 4 * 11;
        ctx.fillText('★ FULL COMBO', W - P - fcW, artImg ? artY + A + 36 : 150);
        glowClear(); spaced(0);
    }

    // Per-section accuracy — a vertical list of % meters (name · bar · %).
    // Colour bands stay positive: green / cyan / amber, never a failure red.
    const secs = Array.isArray(d.sections) ? d.sections.slice(0, 5) : [];
    if (secs.length) {
        spaced(3); ctx.fillStyle = dim; font(15, fDisp, 600);
        ctx.fillText('SECTIONS', P, 252); spaced(0);
        const barX = P + 160, barW = 320, rowH = 36;
        let y = 292;
        for (const sec of secs) {
            const acc = Math.max(0, Math.min(100, Math.round(sec.acc)));
            const barColor = acc >= 90 ? hit : warn;   // green only at 90%+, else amber
            ctx.textBaseline = 'middle';
            ctx.fillStyle = text; font(18, fDisp, 600);
            ctx.fillText(fit(sec.name, 140), P, y);
            ctx.fillStyle = 'rgba(255,255,255,0.10)';      // track
            if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(barX, y - 7, barW, 14, 7); ctx.fill(); }
            else ctx.fillRect(barX, y - 7, barW, 14);
            ctx.fillStyle = barColor;                       // fill
            const fw = Math.max(8, barW * acc / 100);
            if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(barX, y - 7, fw, 14, 7); ctx.fill(); }
            else ctx.fillRect(barX, y - 7, fw, 14);
            glowSet(barColor); ctx.fillStyle = barColor; font(18, fDisp, 700);
            ctx.fillText(acc + '%', barX + barW + 16, y); glowClear();
            y += rowH;
        }
        ctx.textBaseline = 'alphabetic';
    } else {
        // No section data (GP imports / section-less charts): fill the middle
        // with an accuracy hero so the card doesn't read as half-empty. Same
        // positive colour band as the section bars (green ≥90%, else amber).
        const accPct = Math.max(0, Math.min(100, Math.round(Number(d.accuracy) || 0)));
        const heroColor = accPct >= 90 ? hit : warn;
        const hitsTotal = (d.hits || 0) + (d.misses || 0);
        spaced(3); ctx.fillStyle = dim; font(15, fDisp, 600);
        ctx.fillText('ACCURACY', P, 252); spaced(0);
        glowSet(heroColor); ctx.fillStyle = text; font(116, fDisp, 800);
        ctx.fillText(accPct + '%', P, 372); glowClear();
        spaced(2); ctx.fillStyle = dim; font(20, fDisp, 600);
        ctx.fillText((d.hits || 0) + ' / ' + hitsTotal + ' NOTES HIT', P, 410); spaced(0);
        const mX = P, mW = W - P * 2, mY = 446, mH = 18;
        ctx.fillStyle = 'rgba(255,255,255,0.10)';                       // track
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(mX, mY, mW, mH, mH / 2); ctx.fill(); }
        else ctx.fillRect(mX, mY, mW, mH);
        ctx.fillStyle = heroColor;                                      // fill
        const mFw = Math.max(mH, mW * accPct / 100);
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(mX, mY, mFw, mH, mH / 2); ctx.fill(); }
        else ctx.fillRect(mX, mY, mFw, mH);
    }

    // Stat strip across the bottom — note counts as fractions of judged total.
    // A consumer may override the whole strip via d.stats [{label,value,color?}].
    const total = (d.hits || 0) + (d.misses || 0);
    const stats = (Array.isArray(d.stats) && d.stats.length) ? d.stats.slice(0, 6) : [
        { label: 'ACCURACY',    value: d.accuracy + '%',          color: text },
        { label: 'SCORE',       value: String(d.score),           color: accent },
        { label: 'HITS',        value: d.hits + '/' + total,      color: hit },
        { label: (d.extraLabel || 'Top Section').toUpperCase(), value: d.extraValue || '—', color: accent },
        { label: 'BEST STREAK', value: String(d.bestStreak),      color: text },
        { label: 'MAX MULT',    value: '×' + d.maxMultiplier,     color: accent2 },
    ];
    const colW = (W - P * 2) / stats.length;
    const sy = 520;
    stats.forEach((st, i) => {
        const x = P + colW * i;
        const col = st.color || text;
        spaced(2); ctx.fillStyle = dim; font(15, fDisp, 600);
        ctx.fillText(String(st.label || '').toUpperCase(), x, sy); spaced(0);
        // Auto-shrink the value font so wide values (3-digit hit counts like
        // "280/388", a long section name) fit the column instead of being
        // ellipsised to "280/3…"; short values keep the full 36px.
        const valStr = String(st.value == null ? '' : st.value);
        const valMaxW = colW - 14;
        let valPx = 36;
        font(valPx, fDisp, 700);
        while (valPx > 22 && ctx.measureText(valStr).width > valMaxW) { valPx -= 2; font(valPx, fDisp, 700); }
        glowSet(col); ctx.fillStyle = col;
        ctx.fillText(fit(valStr, valMaxW), x, sy + 46); glowClear();
    });

    // Footer brand (overridable for a consuming plugin).
    spaced(2); ctx.fillStyle = dim; font(16, fDisp, 500);
    ctx.fillText(String(d.brand || 'FEE[dB]ACK · NOTE DETECTION'), P, H - 26); spaced(0);
    return cv;
}

// Copy/download with the host-checked fallback ladder: image→clipboard (kept
// a live Promise so the click activation survives) → download PNG → text.
// Returns 'copied' | 'saved' | 'copied-text' | 'failed'.
async function _ndShareCardAction(data, action, overlayEl) {
    const cv = await _ndRenderShareCard(data, overlayEl);
    if (!cv || !cv.toBlob) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(_ndShareCardText(data)); return 'copied-text';
            }
        } catch (e) {}
        return 'failed';
    }
    const toBlob = () => new Promise((r) => cv.toBlob(r, 'image/png'));
    const download = async () => {
        const b = await toBlob(); if (!b) return false;
        const url = URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = url; a.download = _ndShareCardFilename(data);
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
        return true;
    };
    if (action === 'download') {
        try { if (await download()) return 'saved'; } catch (e) {}
    } else {
        try {
            if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
                await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': toBlob() })]);
                return 'copied';
            }
        } catch (e) {}
        try { if (await download()) return 'saved'; } catch (e) {}
    }
    try { await navigator.clipboard.writeText(_ndShareCardText(data)); return 'copied-text'; } catch (e) {}
    return 'failed';
}

// Save the rendered card to disk. Preferred path: POST the PNG to the plugin
// backend, which writes it to the user's configured folder (default: their
// Pictures folder) and returns the absolute path. Falls back to a normal
// browser download if the backend route isn't reachable. Returns
// { ok, path?, dir?, filename?, fallback? }.
async function _ndSaveCard(data, overlayEl, opts) {
    const auto = !!(opts && opts.auto);
    const cv = await _ndRenderShareCard(data, overlayEl);
    if (!cv || !cv.toBlob) return { ok: false };
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    if (!blob) return { ok: false };
    const name = auto ? _ndAutoSaveFilename(data) : _ndShareCardFilename(data);
    const dir = _ndSaveDir();
    try {
        const qs = '?name=' + encodeURIComponent(name)
            + (dir ? '&dir=' + encodeURIComponent(dir) : '')
            + (auto ? '&auto=1' : '');
        const resp = await fetch('/api/plugins/note_detect/save-card' + qs, {
            method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob,
        });
        if (resp && resp.ok) {
            const j = await resp.json().catch(() => null);
            if (j && j.ok) return { ok: true, path: j.path, dir: j.dir, filename: j.filename };
        }
    } catch (e) { /* fall through */ }
    // Auto-save is silent: never spew a browser download per song when the
    // server route is unavailable — just report failure. The manual Save button
    // keeps the download fallback below.
    if (auto) return { ok: false };
    // Fallback: browser download (server route unavailable).
    try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
        return { ok: true, fallback: true, filename: name };
    } catch (e) {}
    return { ok: false };
}

// Click handler for Copy card / Save — gives transient in-button feedback,
// plus a 6 s "Saved to …" toast on the Save path.
async function _ndShareCardClick(btn, action, data, overlayEl) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.disabled = true;
    if (action === 'download') {
        btn.textContent = 'Saving…';
        let res = { ok: false };
        try { res = await _ndSaveCard(data, overlayEl); } catch (e) {}
        if (res.ok && !res.fallback) {
            btn.textContent = 'Saved ✓';
            _ndToast('Saved to ' + (res.dir || res.path || 'disk'), 6000);
        } else if (res.ok && res.fallback) {
            btn.textContent = 'Saved ✓';
            _ndToast('Saved ' + (res.filename || 'card') + ' to your browser downloads', 6000);
        } else {
            btn.textContent = 'Couldn’t save';
        }
        setTimeout(() => { if (btn.isConnected) { btn.textContent = orig; btn.disabled = false; } }, 1600);
        return;
    }
    let res = 'failed';
    try { res = await _ndShareCardAction(data, 'copy', overlayEl); } catch (e) {}
    btn.textContent = res === 'copied' ? 'Copied ✓'
        : res === 'saved' ? 'Saved ✓'
        : res === 'copied-text' ? 'Copied text ✓'
        : 'Couldn’t copy';
    setTimeout(() => { if (btn.isConnected) { btn.textContent = orig; btn.disabled = false; } }, 1600);
}

// A HIT is binary — a note 95 ms late still lands inside a 150 ms window and
// counts identical to a dead-on hit, which inflates scores and produces false
// "you passed" verdicts. `clean` is the tighter grade the coach keys off of to
// surface "technically hit but loose" spots WITHOUT reclassifying them as
// misses (which would resurrect the bass low-string false-misses the wide
// windows were widened to avoid). The clean thresholds are always <= the hit
// thresholds (clamped on load), so the clean band lives strictly inside the hit
// window. `looseReason` names the offending axis so the coach can label the
// drill (tight timing vs intonation).

function _ndMakeJudgment(opts) {
    const o = opts || {};
    const matched = !!o.matched;
    const timingError = matched && Number.isFinite(o.judgedAt) && Number.isFinite(o.noteTime)
        ? Math.round((o.judgedAt - o.noteTime) * 1000)
        : null;
    const pitchError = matched && Number.isFinite(o.pitchError)
        ? Math.round(o.pitchError)
        : null;
    const timingThresholdMs = Number.isFinite(o.timingThresholdMs) ? o.timingThresholdMs : 100;
    const pitchThresholdCents = Number.isFinite(o.pitchThresholdCents) ? o.pitchThresholdCents : 20;
    // Derive late-side grace from the chart note's sustain. Capped at
    // 1 s so a 4-second held note doesn't accept detections nearly 4
    // seconds late as "on time" — at some point the player has clearly
    // missed the strike and is just holding the previous note's ring.
    //
    // For chord judgments, the caller passes an explicit `lateGraceMs`
    // computed from the MAX sus across chord constituents (matching
    // matchNotes' candidate-inclusion + checkMisses' retire-extension
    // grace). Without that override, this falls back to the chart
    // note's own sus, which for chords is just the first constituent
    // (`liveNotes[0]`) — and a chord whose lead has a shorter sus than
    // its longest constituent would get classified LATE here even
    // though it was still inside the chord's matching window.
    const chartNote = o.chartNote || o.note || null;
    const susSec = chartNote && Number.isFinite(chartNote.sus) ? chartNote.sus : 0;
    const lateGraceMs = Number.isFinite(o.lateGraceMs)
        ? Math.max(0, o.lateGraceMs)
        : (susSec > 0 ? Math.min(susSec * 1000, 1000) : 0);
    const timingState = matched ? _ndClassifyTiming(timingError, timingThresholdMs, lateGraceMs) : null;
    const pitchState = matched ? _ndClassifyPitch(pitchError, pitchThresholdCents) : null;
    // pitchState === null means pitch was not measured (e.g. energy-only chord
    // check or harmonic flag).  Treat unmeasured pitch as non-blocking so a
    // chord that passes the scorer is not incorrectly counted as a miss.
    //
    // For CHORDS specifically: the chord scorer (_ndScoreChord) already
    // ran per-string pitch + energy checks before this judgment was
    // constructed. matchNotes only takes the chord-hit path when the
    // scorer returned isHit (score ≥ chordHitRatio). If we *also* gate
    // the overall hit on the monophonic pitchState computed from a
    // SINGLE string's pitchError (the first one with a finite cents
    // measurement), we throw away clean chord hits whenever the lead
    // string happens to be a bit sharp/flat — even when every string
    // rang and the chord scorer said yes. Trust the chord scorer's
    // verdict here. For single notes the original timing+pitch rule
    // still applies.
    const isChord = !!o.chord;
    const hit = isChord
        ? (matched && timingState === 'OK')
        : (timingState === 'OK' && (pitchState === 'OK' || pitchState === null));
    // Tighter quality grade inside the hit window — defaults to the hit
    // thresholds (so a caller that doesn't pass clean thresholds sees every
    // hit as clean → no behaviour change). Real call sites pass the stricter
    // clean thresholds. Pitch grade is skipped for chords (pitchError is a
    // single-string sample there; the chord scorer already gated the hit).
    const cleanTimingMs = Number.isFinite(o.cleanTimingThresholdMs) ? o.cleanTimingThresholdMs : timingThresholdMs;
    const cleanPitchCents = Number.isFinite(o.cleanPitchThresholdCents) ? o.cleanPitchThresholdCents : pitchThresholdCents;
    // Skip the clean *pitch* sub-grade when the pitch band was intentionally
    // widened (bend / slide / harmonic — caller passed a widened
    // pitchThresholdCents). The pitch is off-chart on purpose, so flagging it
    // looseReason:'pitch' would be telemetry noise. Mirrors the chord skip
    // (null pitchError). Clean *timing* still applies.
    const skipCleanPitch = isChord || !!o.pitchWindowWidened;
    const { clean, looseReason } = _ndGradeClean(
        hit, timingError, skipCleanPitch ? null : pitchError, cleanTimingMs, cleanPitchCents);
    return {
        chartNote: o.chartNote || o.note || null,
        note: o.note || null,
        notes: o.notes || null,
        chord: !!o.chord,
        hit,
        clean,
        looseReason,
        timingState,
        timingError,
        pitchState,
        pitchError,
        detectedFreq: Number.isFinite(o.detectedFreq) ? o.detectedFreq : null,
        expectedFreq: Number.isFinite(o.expectedFreq) ? o.expectedFreq : null,
        detectedAt: matched && Number.isFinite(o.judgedAt) ? o.judgedAt : null,
        time: Number.isFinite(o.judgedAt) ? o.judgedAt : null,
        noteTime: Number.isFinite(o.noteTime) ? o.noteTime : null,
        expectedMidi: Number.isFinite(o.expectedMidi) ? o.expectedMidi : null,
        detectedMidi: Number.isFinite(o.detectedMidi) ? o.detectedMidi : null,
        confidence: Number.isFinite(o.confidence) ? o.confidence : 0,
        hitStrings: Number.isFinite(o.hitStrings) ? o.hitStrings : undefined,
        totalStrings: Number.isFinite(o.totalStrings) ? o.totalStrings : undefined,
        score: Number.isFinite(o.score) ? o.score : undefined,
        monophonicDetected: o.monophonicDetected,
    };
}



// ── Pitch Detection: YIN ───────────────────────────────────────────────────
// Lightweight monophonic pitch detector — works instantly, no model to load.

// Lowest frequency we claim to detect — see dsp.js for the constant definition.
// _ND_MIN_DETECTABLE_HZ is imported from ./dsp.js.
function _ndYinDetect(buffer, sampleRate, minFreqHz = _ND_MIN_DETECTABLE_HZ) {
    const threshold = 0.15;
    const halfLen = Math.floor(buffer.length / 2);
    const yinBuffer = new Float32Array(halfLen);

    // Surface "too-small buffer" as a distinct state from "no note detected"
    // so callers (and tests) can tell the two apart. Without this, a broken
    // accumulation path silently drops every bass note.
    const minHalfLenForFreq = Math.ceil(sampleRate / minFreqHz);
    const underBuffered = halfLen < minHalfLenForFreq;

    // Difference function
    let runningSum = 0;
    yinBuffer[0] = 1;
    for (let tau = 1; tau < halfLen; tau++) {
        let sum = 0;
        for (let i = 0; i < halfLen; i++) {
            const delta = buffer[i] - buffer[i + tau];
            sum += delta * delta;
        }
        yinBuffer[tau] = sum;
        runningSum += sum;
        yinBuffer[tau] *= tau / runningSum; // cumulative mean normalized
    }

    // Absolute threshold
    let tau = 2;
    while (tau < halfLen) {
        if (yinBuffer[tau] < threshold) {
            while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
            break;
        }
        tau++;
    }
    if (tau === halfLen) return { freq: -1, confidence: 0, underBuffered };

    // Parabolic interpolation
    const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
    const s1 = yinBuffer[tau];
    const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
    const betterTau = tau + (s0 - s2) / (2 * (s0 - 2 * s1 + s2));

    const freq = sampleRate / betterTau;
    const confidence = 1 - yinBuffer[tau];
    return { freq, confidence: Math.max(0, confidence), underBuffered };
}

// ── Pitch Detection: Shared FFT helper ─────────────────────────────────────
// Real-valued FFT via Cooley-Tukey radix-2, in-place on interleaved
// complex arrays. Currently used by HPS; factored out as a helper so
// future frequency-domain detectors (e.g. cepstrum) can reuse it.
// ~80 lines of dependency-free JS to preserve notedetect's zero-deps
// principle.


// Minimum samples to accumulate before a single-note detection frame. Guitar
// keeps the proven _ND_MIN_YIN_SAMPLES (4096). Bass must span ~2 periods of
// the lowest detectable fundamental (_ND_MIN_DETECTABLE_HZ, B0 ≈ 31 Hz) for
// YIN/HPS to lock it — at 96 kHz that exceeds 4096, so a fixed buffer drops
// low bass silently (the "undersized buffer" warning). Size from the device
// rate so the floor holds at 44.1, 48, 96, 192 kHz.
function _ndMinAnalysisSamples(arrangement, sampleRate) {
    if (arrangement !== 'bass' || !(sampleRate > 0)) return _ND_MIN_YIN_SAMPLES;
    // Exact two-period floor — do NOT round up to a power of two. YIN's
    // difference loop is O(n²) in buffer length, so an overshoot (e.g. 192 kHz:
    // 12800 → 16384) adds real CPU for no benefit; _ndFftMagnitude already
    // zero-pads its own input to a pow2 ≥ resolutionFloor, so the HPS/FFT path
    // is unaffected by a non-pow2 accumulation length.
    const need = Math.ceil(2 * sampleRate / _ND_MIN_DETECTABLE_HZ);
    return Math.max(_ND_MIN_YIN_SAMPLES, need);
}

// ── A/V auto-calibration ──────────────────────────────────────────────
// The harness objective made concrete in-app. Given offset-free detections
// (`{ bt, m }`: bt = hw.getTime() − latencyOffset, m = detected MIDI) logged
// across a play, and the chart notes, sweep candidate A/V offsets and return
// the one (ms) that matches the MOST chart notes within the hit window — then
// refine by the mean residual so matched detections sit centered in their
// windows. Maximizing matched-notes (recall) is robust even from a bad start,
// unlike shifting by the median timing error of whatever hits you already have
// (which collapses when the offset is far off). Pure + exported for tests;
// returns null when there isn't enough evidence to decide.
function _ndCalibrateOffsetMs(detections, chartNotes, geom, hitWindowS, pitchTolCents, opts) {
    opts = opts || {};
    const loMs = (opts.loMs != null) ? opts.loMs : -250;
    const hiMs = (opts.hiMs != null) ? opts.hiMs : 250;
    const stepMs = opts.stepMs || 10;
    const minMatched = (opts.minMatched != null) ? opts.minMatched : 12;
    if (!Array.isArray(detections) || !Array.isArray(chartNotes)) return null;
    if (detections.length < minMatched || chartNotes.length < minMatched) return null;
    // Expected MIDI + time per single chart note (skip chord-only / unfingered).
    const exp = [];
    for (const n of chartNotes) {
        const t = (n.time != null) ? n.time : n.t;
        if (t == null || n.s == null || n.f == null) continue;
        const em = _ndMidiFromStringFret(n.s, n.f, geom.arrangement, geom.stringCount, geom.offsets, geom.capo);
        if (Number.isFinite(em)) exp.push({ t, em });
    }
    if (exp.length < minMatched) return null;
    const dets = detections.slice().sort((a, b) => a.bt - b.bt);
    let best = null;
    for (let ms = loMs; ms <= hiMs; ms += stepMs) {
        const off = ms / 1000;
        let matched = 0, residSum = 0;
        for (const note of exp) {
            for (let i = 0; i < dets.length; i++) {
                const dt = dets[i].bt + off - note.t;
                if (dt < -hitWindowS) continue;
                if (dt > hitWindowS) break;            // dets sorted by bt → past the window
                if (Math.abs(_ndNearestOctaveCents(dets[i].m, note.em)) <= pitchTolCents) {
                    matched++; residSum += dt; break;
                }
            }
        }
        if (!best || matched > best.matched) best = { ms, matched, resid: matched ? residSum / matched : 0 };
    }
    if (!best || best.matched < minMatched) return null;
    // Refine: shift so matched detections center in their windows (sub-grid).
    const refinedMs = Math.round(best.ms - best.resid * 1000);
    return { offsetMs: Math.max(-1000, Math.min(1000, refinedMs)), matched: best.matched, total: exp.length };
}

// ── Constraint-Based Per-String Band Analysis ──────────────────────────────
//
// This is the core of the brief's proposal: instead of asking "what pitch is
// playing?" (hard for chords), ask "is there energy near frequency F on string
// S right now?" — a much simpler question that standard FFT can answer reliably.
//
// Used exclusively for chord scoring. Single notes continue to use YIN/HPS/CREPE
// via processFrame unchanged; the two paths are additive, not competing.

// Frequency bounds for each string covering frets 0–24 at standard tuning,
// with ±10% headroom for non-standard tunings, capo, and tuning offsets.
// Computed dynamically from MIDI tuning tables rather than hardcoded so
// 5-string bass, 7-string and 8-string guitar all derive correct ranges
// automatically.
//
// Returns [loHz, hiHz] for the given string/arrangement/stringCount/offsets/capo.
function _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo) {
    const openMidi = _ndMidiFromStringFret(stringIdx, 0, arrangement, stringCount, offsets, capo);
    const fret24Midi = openMidi + 24;
    // MIDI → Hz: 440 * 2^((midi-69)/12)
    const loHz = 440 * Math.pow(2, (openMidi - 69) / 12) * 0.90; // -10% margin
    const hiHz = 440 * Math.pow(2, (fret24Midi - 69) / 12) * 1.10; // +10% margin
    return [loHz, hiHz];
}

// Measure the energy fraction in a frequency band [loHz, hiHz] relative to
// total spectrum energy, using the magnitude spectrum already computed by
// _ndFftMagnitude. Returns a value in [0, 1].
//
// Reuses the existing FFT scratch buffers — this is a read-only pass over
// magnitudes that were produced by _ndFftMagnitude in the same synchronous
// call chain, so no re-entrancy or buffer corruption risk.
function _ndBandEnergy(magnitudes, binHz, loHz, hiHz, totalEnergy = null) {
    const nBins = magnitudes.length;
    const loBin = Math.max(0, Math.floor(loHz / binHz));
    const hiBin = Math.min(nBins - 1, Math.ceil(hiHz / binHz));
    // hiBin === loBin (a band that covers exactly one FFT bin) is still a
    // valid case — include the bin's energy. Only bail when the band is
    // empty (hi strictly below lo, e.g. hi clamped below 0).
    if (hiBin < loBin) return 0;

    let bandEnergy = 0;
    for (let k = loBin; k <= hiBin; k++) {
        bandEnergy += magnitudes[k] * magnitudes[k];
    }

    // Caller can pre-compute total energy once per frame and pass it in
    // — saves N full-spectrum scans during chord scoring (one per
    // string). When omitted (e.g. single-string callers), compute here.
    if (totalEnergy === null) {
        totalEnergy = 0;
        for (let k = 0; k < nBins; k++) {
            totalEnergy += magnitudes[k] * magnitudes[k];
        }
    }
    if (totalEnergy < 1e-12) return 0;
    return bandEnergy / totalEnergy;
}

// Sum of squared magnitudes across the full spectrum. Pulled out so
// `_ndScoreChord` can compute it once per FFT frame and reuse it across
// every per-string `_ndBandEnergy` call.
function _ndTotalEnergy(magnitudes) {
    let total = 0;
    for (let k = 0; k < magnitudes.length; k++) {
        total += magnitudes[k] * magnitudes[k];
    }
    return total;
}

// Check whether a specific string+fret is audible in the current audio frame.
//
// Returns { hit: bool, bandEnergy: float, centsDiff: float|null, centsError: float|null }
//   centsDiff  — absolute pitch deviation in cents (null when pitch check is skipped)
//   centsError — signed pitch deviation in cents, positive = sharp (present only when
//                pitchCheckCents > 0 and band energy passes threshold; null otherwise)
//
// energyThreshold  — minimum band energy fraction to count as "string is
//                    ringing" (default 0.03, i.e. at least 3% of total
//                    spectrum energy). Lower this for hammer-ons and pull-offs
//                    where the pick attack is absent.
// pitchCheckCents  — if > 0, also verify the dominant frequency in the band
//                    is within this many cents of the expected pitch. Pass 0
//                    to skip the pitch check and use energy-only (faster,
//                    adequate for most chord hits on clean signals).
function _ndConstraintCheckString(
    buffer, sampleRate,
    stringIdx, fret, arrangement, stringCount, offsets, capo,
    pitchCheckCents = 0,
    energyThreshold = 0.03,
    precomputedSpectrum = null,
    precomputedTotalEnergy = null
) {
    // Optional precomputed spectrum + total energy let _ndScoreChord run
    // one FFT and one full-spectrum sum for the whole chord and reuse
    // both across per-string checks. The scratch buffer returned by
    // _ndFftMagnitude is module-level, so callers must keep this
    // synchronous and not interleave other FFT-using detectors.
    const { magnitudes, binHz } = precomputedSpectrum || _ndFftMagnitude(buffer, sampleRate);
    const [loHz, hiHz] = _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo);

    const expectedMidi = _ndMidiFromStringFret(stringIdx, fret, arrangement, stringCount, offsets, capo);
    const expectedHz = 440 * Math.pow(2, (expectedMidi - 69) / 12);

    const bandEnergy = _ndBandEnergy(magnitudes, binHz, loHz, hiHz, precomputedTotalEnergy);
    const energyOk = bandEnergy >= energyThreshold;

    // Low-energy comb rescue eligibility: a sub-3% band can still be a real low
    // note whose fundamental was diluted by distortion/palm-mute (see
    // _ND_LOW_ENERGY_RESCUE_FLOOR). Only a low expected pitch, with pitch
    // checking on and the band above the silence floor, gets a second look —
    // the harmonic-comb confirmation happens on the pitch path below. Everything
    // else concedes on energy exactly as before.
    const combRescueEligible = pitchCheckCents > 0
        && expectedHz <= _ND_HARMONIC_FALLBACK_MAX_HZ
        && bandEnergy >= _ND_LOW_ENERGY_RESCUE_FLOOR;

    if (!energyOk && !combRescueEligible) {
        return { hit: false, bandEnergy, centsDiff: null, centsError: null };
    }

    if (pitchCheckCents <= 0) {
        return { hit: true, bandEnergy, centsDiff: null, centsError: null };
    }

    // Find dominant bin in the band and refine with parabolic interpolation.
    const nBins = magnitudes.length;
    const loBin = Math.max(0, Math.floor(loHz / binHz));
    const hiBin = Math.min(nBins - 1, Math.ceil(hiHz / binHz));
    let peakBin = loBin;
    let peakVal = -Infinity;
    for (let k = loBin; k <= hiBin; k++) {
        if (magnitudes[k] > peakVal) { peakVal = magnitudes[k]; peakBin = k; }
    }
    const delta = (peakBin > loBin && peakBin < hiBin)
        ? _ndParabolicOffset(magnitudes[peakBin - 1], magnitudes[peakBin], magnitudes[peakBin + 1])
        : 0;
    const detectedHz = (peakBin + delta) * binHz;

    const rawCentsError = 1200 * Math.log2(detectedHz / expectedHz);
    const centsError = _ndFoldOctaveCents(rawCentsError);
    const centsDiff = Math.abs(centsError);

    // A clean pitch hit needs the energy gate too. Below the gate (a
    // rescue-eligible low note) only the harmonic comb can grant the hit — a
    // coincidentally on-pitch dominant bin in a sub-threshold band is exactly
    // the bleed the comb is there to reject.
    let hit = energyOk && centsDiff <= pitchCheckCents;
    // Harmonic-comb rescue for the low blind spot. Confirms the EXPECTED note
    // directly by its harmonic comb, catching two failure modes for low notes
    // (≤140Hz, so never guitar mid/high):
    //   • pitch-check fail with energy present — the single-peak read above
    //     grabbed a bleed/neighbour (an open string or the octave ringing under
    //     the fretted note), common on bass DI; and
    //   • energy-gate fail — a low power chord near the nut (E5/A5/B5) under
    //     distortion or palm-muting whose fundamental band fell below 3%
    //     (combRescueEligible let it reach here). This is the guitar case the
    //     tester reported; the comment used to claim this "never fires for
    //     guitar" — it does now, by design.
    // Purely additive (only ever turns a miss into a hit) and the strict comb
    // (≥3 ratio-locked local-max peaks) is what keeps bleed from being credited.
    // NB the per-frame level/diagnostic recording this branch feeds (processFrame
    // level history, _wasSilentAtNote, _ndStrikeLevelContext) is diagnostics-only
    // and never affects hit/miss/score. See _ND_HARMONIC_FALLBACK_*.
    if (!hit && expectedHz <= _ND_HARMONIC_FALLBACK_MAX_HZ
        && _ndHarmonicCoherenceLow(magnitudes, binHz, expectedHz, peakVal)) {
        hit = true;
    }
    return { hit, bandEnergy, centsDiff, centsError };
}

// Count how many of the expected note's harmonics (k·f0 for the configured
// ratios) appear as a genuine LOCAL-MAXIMUM spectral peak whose magnitude is at
// least _ND_HARMONIC_FALLBACK_PEAK_FRAC of the band's peak, within
// ±_ND_HARMONIC_FALLBACK_HALF_CENTS of the ideal harmonic frequency; accept the
// note when at least _ND_HARMONIC_FALLBACK_MIN_HARMONICS line up. Keying on the
// upper harmonics (well-resolved at higher Hz) and requiring ratio-locked
// peaks is what separates a genuinely-ringing low note from open-string bleed
// or a coincidental neighbour — see the note on _ND_HARMONIC_FALLBACK_MAX_HZ.
function _ndHarmonicCoherenceLow(magnitudes, binHz, expectedHz, bandPeakMag) {
    return _ndHarmonicCombCount(magnitudes, binHz, expectedHz, bandPeakMag) >= _ND_HARMONIC_FALLBACK_MIN_HARMONICS;
}

// How many of `expectedHz`'s harmonics (ratios 1..5) appear as a genuine
// local-maximum peak ≥ _ND_HARMONIC_FALLBACK_PEAK_FRAC of bandPeakMag, within
// ±_ND_HARMONIC_FALLBACK_HALF_CENTS of the ideal harmonic frequency.
function _ndHarmonicCombCount(magnitudes, binHz, expectedHz, bandPeakMag) {
    if (!(bandPeakMag > 0) || !(expectedHz > 0) || !(binHz > 0)) return 0;
    const widen = Math.pow(2, _ND_HARMONIC_FALLBACK_HALF_CENTS / 1200);
    const floor = _ND_HARMONIC_FALLBACK_PEAK_FRAC * bandPeakMag;
    const nBins = magnitudes.length;
    let coherent = 0;
    for (const k of _ND_HARMONIC_FALLBACK_RATIOS) {
        const f = expectedHz * k;
        const lo = Math.max(1, Math.floor((f / widen) / binHz));
        const hi = Math.min(nBins - 2, Math.ceil((f * widen) / binHz));
        let bestBin = -1;
        let bestVal = -Infinity;
        for (let b = lo; b <= hi; b++) {
            if (magnitudes[b] > bestVal) { bestVal = magnitudes[b]; bestBin = b; }
        }
        if (bestBin < 0 || bestVal < floor) continue;
        // Require a true local maximum — a bleed/neighbour harmonic leaking into
        // the window is a shoulder, not a peak.
        if (magnitudes[bestBin] >= magnitudes[bestBin - 1] && magnitudes[bestBin] >= magnitudes[bestBin + 1]) {
            coherent++;
        }
    }
    return coherent;
}

// Mute-fail check for a conceded miss: did the OPEN string ring in place of the
// charted FRETTED note? (You fingered the wrong fret or failed to fret/mute, so
// the open string sounded instead.) A genuinely valid reason to miss — distinct
// from "played nothing" (no comb anywhere) and "detector dropped a note you
// played" (the fretted comb IS present). Returns true only for a fretted note
// whose open-string comb is clearly present AND stronger than the fretted comb.
function _ndDetectMuteFail(magnitudes, binHz, expectedHz, openHz, bandPeakMag) {
    if (!(openHz > 0) || !(expectedHz > 0)) return false;
    // Open note and fretted note must be meaningfully different pitches.
    if (Math.abs(1200 * Math.log2(expectedHz / openHz)) < 120) return false;
    const openComb = _ndHarmonicCombCount(magnitudes, binHz, openHz, bandPeakMag);
    if (openComb < _ND_HARMONIC_FALLBACK_MIN_HARMONICS) return false;
    const frettedComb = _ndHarmonicCombCount(magnitudes, binHz, expectedHz, bandPeakMag);
    return openComb > frettedComb;
}

// Was the input SILENT across a ±halfWin window around centerT (visual/song
// time)? Peak level below `threshold` = silence (player stopped / didn't play),
// vs the low-string blind spot (string ringing, pitch unresolved). Returns
// true/false, or null when there's no level telemetry in the window.
function _ndIsSilentWindow(samples, centerT, halfWin, threshold) {
    if (!Array.isArray(samples) || samples.length === 0) return null;
    let peak = 0;
    let inWindow = 0;
    for (let i = samples.length - 1; i >= 0; i--) {
        const s = samples[i];
        if (!s) continue;
        if (s.songT > centerT + halfWin) continue;
        if (s.songT < centerT - halfWin) break;
        inWindow++;
        if (s.level > peak) peak = s.level;
    }
    if (inWindow === 0) return null;
    return peak < threshold;
}

// Which already-judged note keys to RE-OPEN when the playhead jumps backward
// (a seek-back / drill-loop restart), so a replayed section re-scores instead
// of keeping its stale first-pass verdict. Pure → testable. `keys` are
// noteResults keys of the form "<chartTime>_<s>_<f>". Returns [] unless this is
// a genuine backward jump (> 0.25s, past normal frame jitter / pause); then
// returns every key whose chart time is at/after the new playhead (minus the
// timing window).
function _ndKeysToReopenOnSeek(lastT, t, tolerance, keys) {
    if (!Number.isFinite(lastT) || !(t < lastT - 0.25)) return [];
    const floor = t - (Number.isFinite(tolerance) ? tolerance : 0);
    const out = [];
    for (const key of keys) {
        const nt = parseFloat(String(key).split('_')[0]);
        if (Number.isFinite(nt) && nt >= floor) out.push(key);
    }
    return out;
}

// Score a chord by checking each of its constituent notes against their
// respective string frequency bands. Returns { score, hitStrings, totalStrings }.
//
// score = hitStrings / totalStrings (0..1)
// minHitRatio — fraction of strings that must ring for the chord to count as a hit.
//
// Each `chordNotes` entry may carry abbreviated technique flags from the chart
// note data (`cn.ho`, `cn.po`, `cn.b`, `cn.sl`, `cn.hm`), used to adjust
// per-string thresholds:
//   - ho/po (hammer-on / pull-off): lower energyThreshold (no fresh pick attack)
//   - b/sl (bend / slide): widen pitchCheckCents (pitch is in motion)
//   - hm (harmonic): energy-only check (pitch check at fundamental is unreliable)
//     — a future pass could check at 2x / 1.5x fundamental for stricter NYI
//     classification.
function _ndScoreChord(buffer, sampleRate, chordNotes, arrangement, stringCount, offsets, capo, pitchCheckCents, minHitRatio = 0.6) {
    let hitStrings = 0;
    const results = [];

    // Run one FFT for the whole chord and reuse the magnitude spectrum
    // across every per-string check. Without this a 6-string chord ran
    // 6 FFTs per detection tick — measurable CPU on slower devices.
    // Pre-compute total energy too — it's per-frame, not per-string,
    // and was the inner loop's dominant cost on a single 4096-point
    // spectrum.
    const spectrum = _ndFftMagnitude(buffer, sampleRate);
    const totalEnergy = _ndTotalEnergy(spectrum.magnitudes);

    for (const cn of chordNotes) {
        // Per-technique threshold adjustments (brief §"Handling Techniques")
        let energyThreshold = 0.03;
        let cents = pitchCheckCents;

        if (cn.ho || cn.po) {
            // Hammer-on / pull-off: no pick attack, energy will be lower
            energyThreshold = 0.015;
        }
        if (cn.b || cn.sl) {
            // Bend / slide: pitch is moving, widen the pitch window
            cents = Math.max(cents, 100);
        }
        if (cn.hm) {
            // Harmonic: energy-only check (pitch check at fundamental is unreliable)
            cents = 0;
        }

        const check = _ndConstraintCheckString(
            buffer, sampleRate,
            cn.s, cn.f, arrangement, stringCount, offsets, capo,
            cents, energyThreshold, spectrum, totalEnergy
        );
        results.push({ s: cn.s, f: cn.f, ...check });
        if (check.hit) hitStrings++;
    }

    const totalStrings = chordNotes.length;
    const score = totalStrings > 0 ? hitStrings / totalStrings : 0;

    // ── Voicing-reduction credit ─────────────────────────────────────
    // The strict score-ratio path counts "how much of the chart's full
    // voicing rang". For a chart that says "E major, all 6 strings", a
    // player who plays the same chord as a 2-string power voicing
    // (E + B = root + fifth on strings 0 and 1) scores 2/6 = 0.33 and
    // misses at the default cr=0.40. That's musically wrong for huge
    // categories of real playing — punk / pop-rock / country rhythm
    // guitar IS root + fifth voicings on full-chord charts. Real-song
    // data (American Jesus, Bad Religion rhythm, 1033 chord events)
    // showed ~50% of misses landing in exactly this 1-2-of-N regime,
    // while having clean timing and ringing the root every time.
    //
    // Add a parallel hit path: the chord ALSO counts as a hit if at
    // least 2 of the chord's strings rang at their expected pitches
    // (pitch-verified, not energy-only). This rewards reduced
    // voicings without rewarding random-string noise:
    //   • Single string alone → still a miss
    //   • Any ≥2 pitch-verified chord strings (in any combination) → hit
    //   • Full voicing → hit via ratio (the original path)
    //
    // Strict players who want "all strings must ring" can dial cr up
    // to 1.0. The pitch-verified gate (vs. raw energy) keeps incidental
    // noise from tripping the rescue path.
    //
    // Surface `voicingHit` separately from `isHit` so analytics /
    // diagnostics can see WHY a chord was credited.
    // Voicing-reduction = "at least 2 of the chord's strings rang at
    // their correct expected pitches". This is the bar for "the player
    // played a reduced voicing of this chord", as distinct from "random
    // string noise" — which fails to match any chord string's expected
    // pitch and so doesn't contribute to the count.
    //
    // An earlier formulation required the chart's LOWEST string (the
    // bass note) to be one of the rung strings, reasoning that a real
    // chord must include its root. Real-song data caught the issue:
    // players often strum the middle/high strings of a chord shape
    // without sounding the lowest note (string skipping, fast strumming,
    // open-chord shapes where the bass is muted by hand position). Those
    // are valid 2-note interpretations of the chord too. The pitch-
    // verified gate is the real protection against energy-only false
    // positives — once 2 chord strings are confirmed at their correct
    // pitches, it doesn't matter which 2 they are.
    let voicingHit = false;
    if (results.length >= 2) {
        let pitchVerifiedHits = 0;
        for (const r of results) {
            // `hit && finite centsDiff` means the per-string check ran
            // a real pitch comparison and accepted. Energy-only "hit"s
            // (centsDiff null, from the pitchCheckCents <= 0 path used
            // by harmonics) intentionally don't count here — see the
            // "energy-only mode gates off voicing-reduction" test.
            if (r.hit && Number.isFinite(r.centsDiff)) pitchVerifiedHits++;
            if (pitchVerifiedHits >= 2) break;
        }
        if (pitchVerifiedHits >= 2) voicingHit = true;
    }

    // `isHit` reflects ONLY the strict ratio path — that's what
    // matchNotes uses to decide whether to commit a hit on the
    // current frame. The `voicingHit` flag is informational: it
    // means "if matchNotes never finds a strict-ratio frame for
    // this chord, checkMisses should rescue it as a hit at retire
    // time instead of recording a miss." This deferred-commit
    // approach lets strict-ratio frames (which tend to have better
    // timing because they fire later in the chord's audio decay)
    // win out, and voicing-reduction only kicks in as a fallback —
    // avoiding the timing-eager-commit regression where a sub-
    // threshold early frame locked in a hit with bad timing.
    const isHit = score >= minHitRatio;
    return { score, hitStrings, totalStrings, results, isHit, voicingHit };
}
// ── Pitch Detection: CREPE (shared model) ──────────────────────────────────

async function _ndLoadCrepe() {
    if (_ndShared.model || _ndShared.modelLoading) return;
    _ndShared.modelLoading = true;
    // Refresh every instance's button so any detector on 'crepe' shows
    // "loading model..." while the ~20 MB download is in flight.
    // Without this, the UI stays idle for the multi-second download
    // window and users get no feedback.
    for (const inst of _ndInstances) inst._updateButton();

    try {
        if (!window.tf) {
            await _ndLoadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js');
        }
        _ndShared.model = await tf.loadGraphModel(
            'https://tfhub.dev/google/tfjs-model/spice/2/default/1',
            { fromTFHub: true }
        );
        console.log('CREPE/SPICE model loaded');
    } catch (e1) {
        console.warn('SPICE TFHub load failed, trying CREPE backup:', e1);
        try {
            _ndShared.model = await tf.loadLayersModel(
                'https://cdn.jsdelivr.net/gh/nicksherron/crepe-js@master/model/model.json'
            );
            console.log('CREPE model loaded (fallback)');
        } catch (e2) {
            console.warn('All model loads failed, using YIN for this session:', e2);
            _ndShared.model = null;
        }
    }
    _ndShared.modelLoading = false;
    // Update every instance's button — any of them might be on crepe.
    for (const inst of _ndInstances) inst._updateButton();
}

function _ndLoadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function _ndCrepeDetect(buffer) {
    if (!_ndShared.model) return { freq: -1, confidence: 0 };
    try {
        const input = tf.tensor(buffer, [1, buffer.length]);
        let outputs;
        if (_ndShared.model.execute) {
            outputs = _ndShared.model.execute(input);
        } else {
            outputs = _ndShared.model.predict(input);
        }

        let freq = -1, confidence = 0;
        if (Array.isArray(outputs)) {
            const pitchData = await outputs[0].data();
            const uncData = outputs.length > 1 ? await outputs[1].data() : null;
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = uncData ? Math.max(0, 1 - uncData[0]) : 0.8;
            outputs.forEach(t => t.dispose());
        } else {
            const pitchData = await outputs.data();
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = pitchData.length > 1 ? Math.max(0, 1 - pitchData[1]) : 0.8;
            outputs.dispose();
        }
        input.dispose();

        if (freq < 20 || freq > 5000) return { freq: -1, confidence: 0 };
        return { freq, confidence };
    } catch (e) {
        return { freq: -1, confidence: 0 };
    }
}

// ── Factory: createNoteDetector ────────────────────────────────────────────
//
// Returns an independent detector instance. Each instance owns its
// own audio pipeline, scoring, HUD, timers, and DOM subtree. Shared
// resources (CREPE model, tuning tables, FFT scratch) stay at module
// scope to avoid duplication.
//
// Audio lifecycle — important for multi-instance use:
//   - If `audioStream` and `audioCtx` are passed in `options`, this
//     instance is a BORROWER. disable() disconnects its own nodes
//     but does NOT stop the stream or close the context; the parent
//     owns those.
//   - If neither is passed, the instance OWNS an AudioContext and
//     MediaStream that it creates on enable() and tears down on
//     disable(). The default singleton operates this way.
//   - No reference counting — shared lifecycle is the parent's
//     responsibility.
//
// Options:
//   highway      — highway instance (default: window.highway)
//   container    — DOM parent for the instance's HUD/panels
//                  (default: document.getElementById('player'))
//   channel      — -1 (mono mix, default), 0 (left), 1 (right)
//   audioStream  — optional shared MediaStream (borrowing mode)
//   audioCtx     — optional shared AudioContext (borrowing mode)
//   isDefault    — true for the singleton; only the default instance
//                  persists settings changes to localStorage
//
// Returns an API object with:
//   enable()         — async; start audio + detection
//   disable()        — stop audio + detection + show summary
//   destroy()        — disable() + remove DOM + unregister instance
//   isEnabled()      — current toggle state
//   getStats()       — {hits, misses, streak, bestStreak, accuracy, sectionStats}
//   setChannel(idx)  — -1=mono, 0=left, 1=right (restarts audio if enabled)
//   injectButton(bar)— insert detect + gear buttons into a control bar
//   showSummary()    — force-show the end-of-song summary modal

// _ndEncodeWavPcm16 moved to src/recording-capture.js (nd-carve-7 cut 7);
// re-exported from there and imported above.

// Pure health predicate for the scoring watchdog. Extracted so the
// enabled/bridge/external/mic-callback decision is unit-testable without the
// DOM + play-timing the full tick needs. Healthy when detection is on AND one
// of the scoring inputs is live: the desktop bridge, an external MIDI provider
// (keys/piano — opens no audio graph, so cbFresh is permanently false there and
// _extActive must count as healthy or the watchdog spuriously banners + reopens
// the mic against MIDI scoring), or a fresh mic callback.
function _ndScoringHealthy(enabled, usingBridge, extActive, cbFresh) {
    return !!(enabled && (usingBridge || extActive || cbFresh));
}

function createNoteDetector(options = {}) {
    const opts = options || {};
    // Highway is resolved lazily. A caller can pass `highway` in
    // options for explicit binding (splitscreen per-panel use);
    // otherwise we fall back to `window.highway`, re-checking on
    // every access so late initialization (plugin loads before
    // slopsmith-core defines highway) is picked up automatically.
    let hw = opts.highway || window.highway || null;
    function resolveHw() {
        if (hw) return hw;
        hw = opts.highway || window.highway || null;
        return hw;
    }

    // The notes the player is actually being asked to play — the chart AS DRAWN.
    //
    // The highway filters the chart by the mastery slider, but getNotes() /
    // getChords() still return every note in the 100% chart. Scoring the raw
    // arrays retires notes that were never drawn as misses, so playing a lower
    // difficulty perfectly still tanks the score (feedback#226). Every scoring,
    // drill and calibration path must read the chart through these instead.
    //
    // Safe drop-ins: getFilteredNotes/getFilteredChords fall back to the raw
    // arrays when the song has no phrase data (single-difficulty charts, GP
    // imports), and the typeof guard falls back on a core too old to expose
    // them — so behaviour is unchanged everywhere the filter isn't active.
    function _ndChartNotes(h) {
        const x = h || hw;
        if (!x) return [];
        if (typeof x.getFilteredNotes === 'function') return x.getFilteredNotes() || [];
        return (x.getNotes && x.getNotes()) || [];
    }
    function _ndChartChords(h) {
        const x = h || hw;
        if (!x) return [];
        if (typeof x.getFilteredChords === 'function') return x.getFilteredChords() || [];
        return (x.getChords && x.getChords()) || [];
    }

    // Onset times of everything the player is expected to play — singles AND
    // chords, sorted. Anything asking "is there anything to play here?" must look
    // at both: many arrangements deliver chord constituents through getChords()
    // rather than getNotes(), and a reduced difficulty often boils a passage down
    // to chord stabs with no standalone notes left. Asking only about notes then
    // reports an empty chart and bails on perfectly playable material.
    function _ndChartOnsets(h) {
        const ts = [];
        for (const n of _ndChartNotes(h)) if (n && Number.isFinite(n.t)) ts.push(n.t);
        for (const c of _ndChartChords(h)) if (c && Number.isFinite(c.t)) ts.push(c.t);
        return ts.sort((a, b) => a - b);
    }

    // Anchors for the A/V offset sweep. Standalone notes are the primary set — a
    // monophonic onset is the cleanest thing to correlate a detection against, and
    // it's what the sweep was tuned on — so this deliberately does NOT widen the
    // anchor set on a song that has any. But a reduced difficulty can leave a
    // chart with nothing BUT chords, and reporting "no notes" there skips
    // calibration silently. Fall back to the chord constituents rather than skip:
    // flattened onto the chord's onset they're the same {s, f, t} shape the sweep
    // already takes.
    // The chart + difficulty the training bundle pins at song:ended. This is the
    // LABEL for the take's WAV, and the WAV only contains the notes the highway
    // actually drew — so it is FILTERED. Under a reduced mastery level the 100%
    // chart asserts notes that are not in the audio, which teaches the detector to
    // expect notes nobody played. The full chart stays recoverable from
    // song.filename + arrangement; the drawn subset would NOT be recoverable from
    // the full chart, because the phrase filter lives in the highway — so this is
    // the lossless direction.
    //
    // mastery / hasPhraseData ride along so a consumer can tell a reduced-difficulty
    // take from a full one. Without them a take at 60% is indistinguishable from a
    // 100% take of a sparser song, and the dataset can't be segmented after the fact.
    function _ndTrainingChartSnapshot() {
        return {
            notes:  _ndChartNotes(),
            chords: _ndChartChords(),
            mastery: (hw && hw.getMastery) ? hw.getMastery() : null,
            hasPhraseData: !!(hw && hw.hasPhraseData && hw.hasPhraseData()),
        };
    }

    function _ndCalibrationNotes() {
        const singles = _ndChartNotes().filter((n) => n && Number.isFinite(n.t));
        if (singles.length) return singles;
        const out = [];
        for (const c of _ndChartChords()) {
            if (!c || !Number.isFinite(c.t)) continue;
            for (const m of (c.notes || [])) if (m) out.push({ ...m, t: c.t });
        }
        return out;
    }
    const isDefault = !!opts.isDefault;

    // Audio ownership: if caller passed stream/ctx in, they own the
    // lifecycle. We flag the "borrower" vs "owner" state here and
    // consult it in stopAudio().
    const externalStream = opts.audioStream || null;
    const externalAudioCtx = opts.audioCtx || null;
    // Track ownership of each resource independently — a caller can
    // pass just a stream (we create the context) or just a context
    // (we open getUserMedia for the stream). Basing teardown on
    // `!externalStream` alone would leak a context in the former case.
    const ownsStream = !externalStream;
    const ownsAudioCtx = !externalAudioCtx;

    // ── Per-instance state ────────────────────────────────────────────
    let enabled = false;
    // User preference for whether detection should be running. Default
    // is true (Detect on out of the box) — overridden by localStorage
    // when the user has explicitly toggled. Distinct from `enabled`
    // because the audio pipeline can't be claimed during construction
    // (highway may not be ready, mic permissions may not be cached),
    // so this is the *intent* and `enabled` is the *current run state*.
    // The plugin auto-calls enable() on next tick if this is true.
    let detectPreference = true;
    // Set only around the construct-time auto-enable's first (silent,
    // automatic) attempt — the one with a delayed retry still in hand. In that
    // window the open should be non-committal: startAudio() suppresses its
    // user-facing failure alert (a transient not-ready device shouldn't pop a
    // dialog on load) AND openInstrumentStream() preserves a saved deviceId
    // that fails to match (it may just be mid-enumeration) instead of forgetting
    // it. The retry and every user-initiated enable run with this false, so
    // genuine failures surface and a genuinely stale device is forgotten.
    let autoEnableTrial = false;
    // Session generation — incremented on every disable(). A frame
    // that captures the value at the start of processing and re-checks
    // after an `await _ndCrepeDetect(...)` can drop its result rather
    // than apply stale hits to a disabled (or re-enabled) session.
    let sessionGen = 0;
    let audioCtx = null;
    let stream = null;
    // Full audio-node chain — stored so stopAudio can disconnect
    // every node, not just the ScriptProcessor. Matters particularly
    // in borrower mode (external audioCtx): without tearing these
    // down the caller's context graph grows by N nodes per
    // enable/disable cycle.
    let sourceNode = null;
    let gainNode = null;
    let splitterNode = null;
    let mergerNode = null;
    let worklet = null;
    let levelAnalyser = null;

    // Settings — seed from localStorage defaults (shared with singleton),
    // then override from options where provided. Only the default
    // singleton writes back to localStorage; non-default instances keep
    // mutations local.
    let detectionMethod = 'yin';
    // Whether the user explicitly picked a detection method (settings or the
    // dropdown). When false, a bass arrangement auto-uses HPS — see
    // _ndEffectiveDetectionMethod — since YIN locks onto the 2nd harmonic of a
    // weak-fundamental bass note and reports an octave high.
    let detectionMethodUserSet = false;
    // Opt-in: on the desktop bridge, run note_detect's own pitch detector on
    // engine-captured PCM (getRawAudioFrame) rather than the engine's
    // verdicts. Default off — the engine verdict/verifier path stays the
    // out-of-box behaviour. See `usingNativeFrames`.
    let nativeDetection = false;
    let timingTolerance = 0.150;
    let pitchTolerance = 50;
    let timingHitThreshold = 0.100;
    // Chord-specific timing-OK window. Wider than the single-note
    // threshold because a chord strum spans 5–10 ms across strings and
    // the per-string FFT analysis window itself smears chord-strike
    // timing by another 50–100 ms — so the inherent jitter on a chord
    // event is closer to ±150 ms than the single-note ±100 ms. Fast
    // punk / pop-rock rhythm players also anticipate the beat by 80–
    // 120 ms (issue #38 — "Bad Habit", "American Jesus"), and the strict
    // 100 ms window cuts off most of that bias even when the chord was
    // scored as a strict-ratio hit. Default 150 ms; clamped >=
    // timingHitThreshold at load so chord scoring is never stricter
    // than single notes.
    let chordTimingHitThreshold = 0.150;
    let pitchHitThreshold = 20;
    // Clean-grade thresholds — always <= the hit thresholds (clamped on load),
    // so the clean band lives strictly inside the hit window. See _ndGradeClean.
    let cleanTimingThreshold = 0.050;   // 50 ms
    let cleanPitchThreshold = 12;       // cents
    let showTimingErrors = true;
    let showPitchErrors = true;
    // slopsmith#254 — the full-screen green/red edge flash on hit/miss.
    // Off by default now that the highway renderer lights the note gem
    // itself (and sizzles it); users who want the peripheral cue back can
    // re-enable it in the gear popover.
    let edgeFlashEnabled = false;
    // Tuning mode — opt-in switch for everything the detector exposes
    // for development / tuning / benchmarking (the Reference Recording
    // panel, the Diagnostic JSON export / Reset, the miss-category
    // breakdown on the end-of-song summary). Off by default — these
    // surfaces are noise for normal play. Gated by a single checkbox
    // in the gear popover. Persisted in localStorage alongside the
    // other settings.
    let tuningMode = false;
    // Auto-record every play (default singleton only) so each take is
    // captured for later analysis — the teaching-tool goal — without the
    // user arming anything. Off by default — opt in via Settings. The manual Arm /
    // Arm-(training) dev surfaces stay behind tuningMode and override
    // this (we only auto-arm when nothing is already armed for training).
    let autoRecord = false;
    // Detection frame size — the ScriptProcessor buffer fed to the
    // detector each callback. 1024 (~21 ms @48k) is too short to resolve a
    // low-bass fundamental (low-E period ~24 ms), so the detector silently
    // drops most bass notes; 2048 (~43 ms) nearly triples bass recall
    // (harness-measured 27%→77% on a real take) for an imperceptible
    // latency cost. Persisted + tunable so downstream bass-accuracy work is
    // configuration, not a code fork. Clamped to a valid ScriptProcessor
    // buffer size on load.
    let frameSize = 2048;
    // Auto-calibrate the A/V offset from each play: log offset-free detections,
    // then on song-end sweep for the offset that maximizes matched notes (the
    // harness objective) and apply it via window.setAvOffsetMs — so the user
    // never hand-sets the latency number. Persisted/tunable like the others.
    let autoCalibrate = true;
    let missMarkerDuration = 2.0;
    let hitGlowDuration = 0.5;
    let inputGain = 1.0;
    // Calibrated ENGINE input gain (desktop): the input-level wizard sets the
    // engine source gain (bridge setGain('input', …)) so a hard-played DI peaks at
    // CAL_TARGET_PEAK (-12 dBFS) — the level the rig_builder amps are built for, so
    // a hot guitar/bass doesn't clip them on the way in. Distinct from `inputGain`
    // above, which only scales the browser web-audio analysis path (no amps there).
    // null until the user calibrates; re-applied on enable so it survives restarts.
    let engineInputGain = null;
    // Input-calibration target: hardest playing should peak here. 0.25 = -12 dBFS,
    // matching the rig_builder amps' vst/src/amps/INPUT_CALIBRATION.md reference.
    const CAL_TARGET_PEAK = 0.25;
    let selectedDeviceId = '';
    let selectedChannel = 'mono';
    // Detector pipeline latency compensation. 0.080 is the historical
    // default; the right value is heavily audio-chain-dependent (USB
    // interfaces, ScriptProcessor buffering, OS audio path all vary).
    // Users typically dial this via the gear-popover slider; the A/V
    // auto-calibrate panel suggests a value derived from their own
    // recently-detected note timings. We tried bumping the default to
    // match one heavy-user's empirical value, but it over-corrected
    // for users with shorter chains (caused their on-time playing to
    // register as "early" misses). Keeping the conservative default
    // and pointing users at the calibrate workflow is the right
    // trade-off.
    let latencyOffset = 0.080;
    // Fraction of a chord's strings that must register energy for the
    // chord to count as a hit (0.0–1.0). Was 0.6 historically, but
    // harness measurements against real-guitar recordings showed
    // chord scoring near 0/16 at that gate even for clean
    // playing. Dropping to 0.40 lets typical open/power-chord
    // voicings score multi-string hits without rewarding single-
    // string strums. Users who want stricter scoring can raise via
    // the slider.
    let chordHitRatio = 0.40;
    // Minimum YIN/HPS/CREPE confidence to accept a detection. Below
    // this, the per-frame result is discarded and the note retires
    // as a "pure" miss. Previously hardcoded to 0.30 at every gate
    // (6 sites in this file: two YIN/HPS result gates, three
    // detectedMidi-on-confidence gates, and the desktop-bridge pitch
    // detection gate); real-rig diagnostics on a healthy
    // signal showed ~47% of frames falling below that floor on CREPE
    // — most of the "pure" miss bucket. Default lowered to 0.20 +
    // exposed as a UI slider (gear popover) so users with quieter
    // / noisier signals can tune. Range 0.05–0.50 clamped on load.
    let detectionConfidenceMin = 0.20;

    try {
        const raw = localStorage.getItem(_ND_STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            if (s.deviceId !== undefined) selectedDeviceId = s.deviceId;
            // Allowlist channel — a manually-edited or future-version
            // storage value would otherwise fall through `startAudio`'s
            // `selectedChannel === 'left' ? 0 : 1` check and silently
            // default to the right channel. Same defensive shape as
            // the method allowlist below.
            if (['mono', 'left', 'right'].includes(s.channel)) selectedChannel = s.channel;
            const storedMethod = (typeof s.method === 'string'
                && ['yin', 'hps', 'crepe'].includes(s.method)) ? s.method : null;
            if (storedMethod) detectionMethod = storedMethod;
            // A persisted `method` alone is NOT a manual override: saveSettings()
            // always writes the current method, including the untouched default
            // 'yin'. Treat it as user-set only when the explicit flag is stored,
            // or a VALIDATED non-default method was stored — otherwise a returning
            // user who only changed an unrelated setting (or has a corrupted
            // method value) would lose bass auto-HPS.
            detectionMethodUserSet = !!s.methodUserSet || (storedMethod !== null && storedMethod !== 'yin');
            // Clamp tolerances to the UI slider ranges (30–300ms, 10–100c)
            // before deriving hit thresholds so a stale or manually-edited
            // stored value can't produce an invalid range input or a hit
            // threshold that exceeds the tolerance ceiling.
            if (s.timingTolerance !== undefined) timingTolerance = Math.max(0.03, Math.min(0.3, s.timingTolerance));
            if (s.pitchTolerance !== undefined) pitchTolerance = Math.max(10, Math.min(100, s.pitchTolerance));
            if (s.timingHitThreshold !== undefined) timingHitThreshold = Math.max(0.03, Math.min(timingTolerance, s.timingHitThreshold));
            // Chord threshold clamp: at least the single-note strict threshold
            // (chords shouldn't be stricter than single notes), at most the
            // outer timing tolerance (we're widening within the existing
            // candidate window, not pushing past it).
            if (s.chordTimingHitThreshold !== undefined) chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, s.chordTimingHitThreshold));
            if (s.pitchHitThreshold !== undefined) pitchHitThreshold = Math.max(5, Math.min(pitchTolerance, s.pitchHitThreshold));
            if (s.cleanTimingThreshold !== undefined) cleanTimingThreshold = Math.max(0.01, Math.min(timingHitThreshold, s.cleanTimingThreshold));
            if (s.cleanPitchThreshold !== undefined) cleanPitchThreshold = Math.max(1, Math.min(pitchHitThreshold, s.cleanPitchThreshold));
            // Clean thresholds live strictly inside the hit window.
            if (cleanTimingThreshold > timingHitThreshold) cleanTimingThreshold = timingHitThreshold;
            if (cleanPitchThreshold > pitchHitThreshold)   cleanPitchThreshold = pitchHitThreshold;
            if (s.showTimingErrors !== undefined) showTimingErrors = !!s.showTimingErrors;
            if (s.showPitchErrors !== undefined) showPitchErrors = !!s.showPitchErrors;
            if (s.edgeFlash !== undefined) edgeFlashEnabled = !!s.edgeFlash;
            if (s.tuningMode !== undefined) tuningMode = !!s.tuningMode;
            if (s.autoRecord !== undefined) autoRecord = !!s.autoRecord;
            if (s.frameSize !== undefined) frameSize = _ndClampFrameSize(s.frameSize);
            if (s.autoCalibrate !== undefined) autoCalibrate = !!s.autoCalibrate;
            if (s.nativeDetection !== undefined) nativeDetection = !!s.nativeDetection;
            // Persisted on/off preference. Absence keeps the default
            // (true), so fresh installs get Detect on out of the box.
            if (s.detectEnabled !== undefined) detectPreference = !!s.detectEnabled;
            if (s.missMarkerDuration !== undefined) missMarkerDuration = Math.max(0.5, Math.min(5, s.missMarkerDuration));
            if (s.hitGlowDuration !== undefined) hitGlowDuration = Math.max(0.1, Math.min(2, s.hitGlowDuration));
            if (Number.isFinite(s.inputGain)) inputGain = Math.max(0.1, Math.min(5, s.inputGain));
            if (Number.isFinite(s.engineInputGain)) engineInputGain = Math.max(0.1, Math.min(5, s.engineInputGain));
            if (s.latencyOffset !== undefined) latencyOffset = s.latencyOffset;
            // Clamp to the slider's range so a stale persisted value
            // (older build, manual edit) can't put scoring in a state the
            // UI can't represent.
            if (s.chordHitRatio !== undefined) chordHitRatio = Math.max(0.25, Math.min(1, s.chordHitRatio));
            // Auto-drill threshold (contiguous misses → drill; 0 = off). Also
            // persisted to localStorage by settings.html; accept it here so a
            // host/test can drive it programmatically.
            if (s.autoDrillMisses !== undefined) {
                const n = parseInt(s.autoDrillMisses, 10);
                _drillConductor.setAutoDrillMisses((Number.isFinite(n) && n > 0) ? n : 0);
            }
            // Detection confidence floor — clamp to a sensible range.
            // Below 0.05, even pure noise becomes a "detection"; above
            // 0.50, even confident YIN/CREPE frames get rejected on
            // typical guitar signals.
            if (s.detectionConfidenceMin !== undefined) {
                detectionConfidenceMin = Math.max(0.05, Math.min(0.50, s.detectionConfidenceMin));
            }
        }
    } catch (e) { /* localStorage unavailable */ }

    // Persist the input calibration across the host re-setting the SHARED engine
    // input gain whenever a tone/preset loads (applyPresetGainLevels) — including
    // the default tone at startup, which otherwise wipes the calibration on every
    // restart. Re-assert the calibrated value a few times shortly after load to win
    // the startup default-tone race; enable() re-applies too (the reliable backstop
    // when the user turns Detect on to practice). Default instance only, and only
    // when actually calibrated. (The clean long-term fix is host-side: a persistent
    // input-calibration stage independent of the per-preset input gain.)
    if (isDefault && engineInputGain != null) {
        for (const ms of [800, 2500, 5000]) setTimeout(() => _ndApplyEngineGain(), ms);
    }
    // Chord window invariant — single-note strict can't exceed chord
    // (a stored chord value smaller than the loaded strict threshold
    // would invert the relationship); and chord can't exceed the outer
    // tolerance (we're widening within the candidate window, not past
    // it). The latter trips when a user has a stored timingTolerance
    // below the chord default and no chordTimingHitThreshold yet.
    if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
    if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;

    // Engine input channel index for the DESKTOP source path (-1 = mono mix of the
    // first pair, else 0-based). Source of truth for addSource/setSourceInputChannel
    // and supports channels beyond L/R (a multi-channel interface, or a PipeWire
    // combine of two interfaces). `selectedChannel` (the string above) stays what
    // the 2-channel browser splitter uses; the two are kept in sync for the values
    // the splitter can represent (-1/0/1).
    let _ndChannelIndex = selectedChannel === 'left' ? 0
        : selectedChannel === 'right' ? 1 : -1;

    // Phase 2: which engine input DEVICE this instance's source captures from.
    // 0 = primary input device (the only one on the single-device path); 1..N =
    // an ADDITIONAL device the host (splitscreen) bound via bindInputDevice, so
    // two separate interfaces each feed their own panel. Fixed at addSource time
    // (a source's device can't change live — re-add to move it). Desktop-only.
    let _ndDeviceKey = 0;
    if (typeof opts.deviceKey === 'number' && Number.isInteger(opts.deviceKey) && opts.deviceKey >= 0)
        _ndDeviceKey = opts.deviceKey;

    // Phase 2: user-dialed capture-latency correction (milliseconds) for a source
    // on an EXTRA input device — the residual offset between that device's path and
    // the primary's, which can't be auto-measured reliably on JACK/PipeWire. The
    // host (splitscreen) exposes a per-panel control that calls setVerifierOffset().
    // Positive = scoring playhead later; negative = earlier. Applied to the bound
    // source's engine verifier. No effect on the primary / browser path.
    let _ndVerifierOffsetMs = 0;
    if (typeof opts.verifierOffsetMs === 'number' && Number.isFinite(opts.verifierOffsetMs))
        _ndVerifierOffsetMs = opts.verifierOffsetMs;
    function _ndApplyVerifierOffset() {
        const a = _ndBridgeAudio();
        // Apply ONLY to a source WE allocated (_ndOwnsSource). Never source 0 (the
        // shared legacy/default path), and never a borrowed opts.sourceId the detector
        // doesn't own — mutating a shared/reused source would leak this panel's latency
        // correction onto another consumer and skew its scoring.
        if (_ndOwnsSource && sourceId != null && sourceId !== 0
            && a && typeof a.setSourceVerifierOffset === 'function') {
            try { a.setSourceVerifierOffset(sourceId, _ndVerifierOffsetMs / 1000); } catch (_) { /* best-effort */ }
        }
    }

    // opts.channel overrides the persisted channel for this instance (used by
    // splitscreen to bind each panel to a distinct input channel). Accepts -1/0/1
    // (mono/left/right). Channel >= 2 (multi-channel selection) is DEFERRED — see
    // setChannel() — so clamp it to mono rather than store an index the capture path
    // may not honor (which would also export stale selectedChannel metadata).
    if (typeof opts.channel === 'number' && Number.isInteger(opts.channel) && opts.channel >= -1) {
        if (opts.channel >= 2) {
            console.warn(`[note_detect] opts.channel ${opts.channel} (multi-channel selection) is not yet supported; using mono.`);
            _ndChannelIndex = -1;
            selectedChannel = 'mono';
        } else {
            _ndChannelIndex = opts.channel;
            if (opts.channel === 0) selectedChannel = 'left';
            else if (opts.channel === 1) selectedChannel = 'right';
            else selectedChannel = 'mono';  // -1
        }
    }

    // Audio metering
    let inputLevel = 0;
    let inputPeak = 0;
    let peakDecay = 0;

    // Input-dropout watchdog (ported from slopsmith note_detect 1.39.1). The
    // "played a whole song into the void" failure: the interface drops the input
    // (USB glitch, driver, audio focus) or the detector never came up, and
    // nothing scores — invisible until the end-of-song summary. We stamp every
    // audio callback and, while detection is wanted and the song is playing,
    // alert + auto-recover within ~2s if the callbacks stop. Browser-only (the
    // desktop bridge owns its own input health).
    let _lastAudioCbT = 0;            // Date.now() of the last onaudioprocess
    let _maxCbGapMs = 0;              // worst inter-callback gap this play (starvation gauge)
    let _scoringStalled = false;      // banner state (not scoring while playing)
    let _wdPlayStartT = 0;            // when the current playing+wantsDetect stretch began
    let _inputLost = false;           // track ended/muted (device dropped)
    let _lastInputRecover = 0;        // throttle re-acquire so a glitch storm can't thrash
    let scoringWatchdog = null;       // persistent setInterval handle (cleared in destroy)
    let _healthTrack = null;          // the live input MediaStreamTrack (for dropout telemetry)
    let _healthHandlers = null;       // { track, ended, mute, unmute } — stored so we can detach before rebinding

    // Calibration Wizard v2 state — moved to calibration-wizard.js (nd-carve-8)
    // _calWizardEl, _calWizardTick, _calWizardState, _calWizardOnDone,
    // _calWizardOnCancel, _calWizardForceArrangement, _CAL_WIZARD_NOTE_CHECK_DEFS,
    // _CAL_WIZARD_STEPS — all private to createCalibrationWizard() module.

    // Renderer-side silence gate. CREPE on this engine emits high-
    // confidence stuck-pitch output on silence (interference / induced
    // signal even with the guitar muted); the engine's verifier accepts
    // it, and bent / slide / harmonic notes' 600¢ pitch leniency widens
    // the window so far that those phantom pitches pass as hits — giving
    // ~50% false-hit rate with no input. The fix is to track recent
    // input levels and, when a verdict arrives, force its `detected` to
    // false if no real signal existed around the note's chart time.
    const _ndLevelSamples = [];
    const _ND_LEVEL_HISTORY_S = 6;
    const _ND_LEVEL_WIN_HALF = 0.2;  // ±200 ms around chartTime
    const _ND_SILENCE_THRESHOLD = 0.02;  // ~2% of full scale

    // Scoring
    let hits = 0;
    let misses = 0;
    let streak = 0;
    let bestStreak = 0;
    // Game points (base × streak multiplier per clean hit) and the
    // multiplier tier itself — see the top-level _ndMultiplierForStreak /
    // ND_BASE_* helpers. maxMultiplier is the session high-water mark for
    // the end-of-song summary.
    let score = 0;
    let multiplier = 1;
    let maxMultiplier = 1;
    let sectionStats = [];   // [{name, hits, misses}]
    let currentSection = null;
    const noteResults = new Map(); // key -> judgment object

    // Position-aware score ledger. One compact entry per COUNTED judgment,
    // keyed by the SAME key as noteResults (so the two prune in lockstep) but
    // never garbage-collected — noteResults is pruned for memory (see the gc
    // interval), so it can't be replayed to rebuild the score after a big
    // seek-back. This ledger is the source of truth for _recomputeScoreToPosition,
    // which fires when the player repositions BACKWARD in the song (Restart
    // button, scrub-back) so the HUD reflects only the notes up to the new
    // playhead instead of keeping the stale cumulative total. Entry shape:
    // { t: chart-note time (s), hit: bool, chord: bool }. Cleared in resetScoring().
    const _scoreLedger = new Map();
    // song:seek subscription (per-instance, bound from enable(), torn down in
    // destroy() — survives the per-song silent-disable like the reArm/endOfSong
    // listeners). See _onSongSeekReposition / _seekResetBindEvents.
    let seekResetSubscribed = false;
    let seekResetOnSeekFn = null;

    // Read-only verifier rejection log (last N chart-verify failures).
    const _ND_VERIFIER_REJECT_MAX = 20;
    const _ndVerifierRejects = [];
    const _ndRejectDedup = new Set();   // note/chord keys already logged this session
    const _ndVerifyFailSnap = new Map(); // noteKey -> last scoreChord !hit snapshot (legacy path)
    const _ND_REJECT_REASON_LABEL = {
        NO_VERDICT: 'engine no verdict',
        SILENCE_GATE: 'silence gate',
        STRING_VERIFY_FAIL: 'string verify fail',
        CHORD_RATIO_FAIL: 'chord ratio fail',
        TIMING_FAIL: 'timing fail',
        PITCH_FAIL: 'pitch fail',
        RETIRE_NO_MATCH: 'retire no match',
        UNKNOWN: 'unknown',
    };
    // A/V auto-calibrate subsystem (K) — extracted to src/av-calibrate.js.
    // All mutable deps passed as accessor functions (LIVE-ACCESSOR RULE).
    const _avCal = createAvCalibrate({
        getHw:                  () => hw,
        getAutoCalibrate:       () => autoCalibrate,
        getIsDefault:           () => isDefault,
        getDetectedMidi:        () => detectedMidi,
        getLatencyOffset:       () => latencyOffset,
        getDetectPreference:    () => detectPreference,
        getCurrentArrangement:  () => currentArrangement,
        getCurrentStringCount:  () => currentStringCount,
        getTuningOffsets:       () => tuningOffsets,
        getCapo:                () => capo,
        getTimingHitThreshold:  () => timingHitThreshold,
        getPitchTolerance:      () => pitchTolerance,
        calibrationNotes:       _ndCalibrationNotes,
        calibrateOffsetMs:      _ndCalibrateOffsetMs,
        dispatchInstanceEvent,
    });

    // ── Reference-recording capture (#254 follow-up) ──────────────────
    // State and functions moved to src/recording-capture.js (nd-carve-7 cut 7).
    // _recCapture is constructed below (after _diagCatalog and _summaryUi).
    // Declared here so the _diagCatalog DI accessor can close over it lazily.
    let _recCapture;
    // _summaryDeferred, _ndAutoExitRelease, _xpSubmittedTake moved to
    // createSummaryUi closure (nd-carve-5 cut 2). Access via _summaryUi.
    // slopsmith#254 — per-sustained-hit-note "still being held on-pitch"
    // grace timestamps: key -> performance.now() ms before which the
    // sustain still counts as actively held. Smooths the gap between
    // ~30 fps pitch frames and 60 fps highway render so the lit-gem glow
    // doesn't flicker. Pruned alongside noteResults; cleared on reset.
    const _susActiveUntil = new Map();

    // Last playhead checkMisses() saw — for spotting a backward seek (drill A-B
    // loop wrap or manual seek-back) on the browser path so the replayed
    // section re-scores. null = no scan yet (startup / post-reset).
    let _ndLastMissScanT = null;

    // Drill mode (slopsmith plugin-API: loop:restart event from #198).
    // Activates whenever slopsmith has an A-B loop set; each loop wrap
    // snapshots the just-finished iteration's per-iteration scoring
    // into drillIterations so the user sees iteration-by-iteration
    // accuracy on a repeated passage. Per-iteration counters live
    // alongside (not in place of) the global session counters above —
    // session totals stay correct even while drilling.
    // ── Drill state → createDrillConductor (nd-carve-5 cut 3) ───────────────
    // drillEnabled, drillIterations, drillIter*, drillSubscribed,
    // drillOnLoop*/drillOnSongChanged*, drillActiveLoop*, drillNextIdx,
    // DRILL_MAX_ITERATIONS, drillDirty, drillConductor*, _drillBeat*,
    // _CLICK_LOOKAHEAD_S, _ndPerfNow, _ndMmSs, _autoDrill* — all live in
    // _drillConductor closure. (reArmSubscribed / reArmOnLoadedFn stay here.)
    let reArmSubscribed = false;
    let reArmOnLoadedFn = null;

    // Detection state
    let detectedMidi = -1;
    let detectedConfidence = 0;
    let detectedString = -1;
    let detectedFret = -1;
    let detectedDisplayMidi = -1;
    let underBufferWarned = false;
    // Timing-free verify target (see _runVerifyTarget / setVerifyTarget). An
    // array of {s, f, ...technique flags} or null. When set, every frame
    // scores it against the live audio and emits notedetect:verify on a hit.
    let _verifyTarget = null;
    // Optional caller-supplied tuning context for the verify target
    // ({ arrangement, stringCount, offsets, capo }), or null to score against
    // the host song's live tuning. Lets a non-chart consumer (contained
    // playback) verify against the player's real instrument rather than the
    // loaded chart — see _ndSanitizeVerifyCtx.
    let _verifyTargetCtx = null;
    // Strong fingerprint of the tuning context captured when the target was
    // registered. A (string, fret) only maps to a pitch under a specific
    // arrangement + tuning + capo, so a target is meaningless once that
    // context changes. We bind the target to this fingerprint and drop it on
    // mismatch, so a song/arrangement switch can never emit notedetect:verify
    // for the wrong context (independent of whether the consumer remembers to
    // clear it). When _verifyTargetCtx is set the fingerprint comes from the
    // override, so a host song-switch underneath does NOT drop the target.
    let _verifyTargetSig = null;
    // The tuning context the verify target is scored under: the caller's
    // override when one was supplied, else the host song's live state.
    function _ndVerifyActiveCtx() {
        if (_verifyTargetCtx) return _verifyTargetCtx;
        return {
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            offsets: tuningOffsets,
            capo,
        };
    }
    function _ndVerifyActiveSig() {
        const c = _ndVerifyActiveCtx();
        return _ndVerifySigFor(c.arrangement, c.stringCount, c.offsets, c.capo);
    }
    // Last chord constraint result — shown in HUD when no single note is detected.
    // Reset on song change via resetScoring(). `lastChordTime` is the
    // chart timestamp of the chord that produced these readings; the HUD
    // uses it to age the display out so a stale chord readout doesn't
    // linger past the chord's timing window during silence/noise.
    let lastChordScore = null;
    let lastChordHit = 0;
    let lastChordTotal = 0;
    // Per-chord-key cache of the most recent _ndScoreChord result so
    // checkMisses() can attach hs/tt/sc to a chord miss judgment. Keyed
    // by the same `<time>_chord` string the rest of the chord plumbing
    // uses. Cleared on resetScoring (song change / detect toggle) so a
    // stale per-chord result from one take can't leak into a later one.
    const _chordLastResult = new Map();
    let lastChordTime = -Infinity;

    // Bass miss rescue: a bass DI's fundamental is weak and the live 4096-pt
    // detection window can't resolve a 55 Hz note, so correctly-played low
    // notes retire as misses. Instead we buffer recent raw audio and, when a
    // bass single note is about to retire, re-check its pitch on a long window
    // CENTERED on its expected time (the chart tells us where it should be) with
    // the harmonic-comb rescue in _ndConstraintCheckString. Ported from
    // slopsmith note_detect 1.39.1. Bass-only; cleared on resetScoring.
    const _RESCUE_BUF_MAX = 32768;   // ~680 ms @ 48 kHz — covers retire lag + half-window
    const _RESCUE_WIN = 16384;       // ~340 ms — resolves a 55 Hz fundamental
    let _rescueBuf = new Float32Array(0);
    let _rescueBufEndT = 0;          // hw time (s) of the newest sample in _rescueBuf
    let _rescueCalls = 0, _rescueWindows = 0, _rescueHits = 0, _rescueSkippedSilent = 0;
    // Per-tick rescue-FFT budget. One conceded bass miss can fire up to ~5
    // rescue windows (_tryBassRescue) + 1 attribution FFT (_missAnalysisAtNote),
    // all 16384-pt. Normal play concedes ~1 miss/tick — well under this. But
    // after a backward seek / lag spike / drill-loop wrap a whole batch of misses
    // retires on a single checkMisses tick; unbounded that is hundreds of ms of
    // synchronous FFT and dropped frames. Cap the windows spent per tick (≈4
    // misses' worth); once spent, the remaining conceded bass misses this tick
    // retire as PLAIN misses (no rescue, no attribution). Rescue is purely
    // additive — it only upgrades a miss to a hit — so one landing a frame late,
    // or not at all under a storm, is invisible to scoring.
    const _RESCUE_WINDOWS_PER_TICK = 24;

    // Tuning — per-instance so panels can be on different songs.
    // tuningOffsets is resized to match the actual string count on enable();
    // the initial 6-element array is a safe default for 6-string guitar
    // and is overwritten from hw.getSongInfo() before any detection runs.
    let currentArrangement = 'guitar';
    let tuningOffsets = [0, 0, 0, 0, 0, 0];
    let capo = 0;
    let currentStringCount = 6; // kept in sync with tuningOffsets.length

    // Audio buffers
    let accumBuffer = new Float32Array(0);
    let pendingBuffer = null;
    let processingFrame = false;

    // Timers
    let detectInterval = null;
    let levelRaf = null;
    // nd-carve-5 cut 4: _vuPanelEl/_vuBarEl/_vuPeakEl/_vuPanelAbsent moved to
    // settings-panel.js (local VU state per createSettingsPanel instance).
    let bridgeLevelTimer = null;  // setInterval for the desktop-bridge level meter
    // Capability latch: true once we confirm the bridge engine has no
    // getLevels, so the sustain glow can fall back to a fixed alpha. Distinct
    // from `!bridgeLevelTimer` (which is also true mid-startup/after teardown);
    // defaults false so we level-gate until the capability is actually known.
    let bridgeLevelsUnavailable = false;
    let missCheckInterval = null;
    let gcInterval = null;

    // Set to true when startAudio() routed through the slopsmith-desktop
    // (Electron) audio bridge instead of opening its own getUserMedia
    // stream. Used by the bridge poll/level-meter timers to bail out
    // after their `await` resolves on a since-disabled instance — the
    // existing Web-Audio teardown in stopAudio() is null-checked, so it
    // doesn't need its own branch on this flag.
    let usingDesktopBridge = false;
    // Per-instance identity for the cross-instance ML gate refcount.
    const _ndGateToken = {};
    // Arm/suspend engine ML for THIS instance. ML is read only when the per-tick
    // loop runs matchNotes/detectNotes/scoreChord — i.e. detection is live, on
    // the desktop bridge, and NEITHER the host engine-verifier NOR a contained
    // verifier is driving the chart slot (both score via the harmonic-comb
    // NoteVerifier and never read ML). Native-frame mode and the non-verifier
    // fallback keep both flags false, so they arm ML. Driven every detection
    // tick (below) so it converges to the right state no matter how those flags
    // changed — far more robust than syncing at each individual transition.
    function _ndUpdateMlGate() {
        // Mirror exactly the conditions under which the detection tick does
        // ML-reading work: live + on the bridge + not the host verifier + the
        // chart slot isn't held by a contained chart (ours OR a same-source
        // sibling's — both bail the tick before any ML read).
        const wantsMl = !!(enabled && usingDesktopBridge && !_ndUsingEngineVerifier
            && !_ndHostChartSuspended && !_ndOtherOwnsOurSlot());
        _ndSyncMlGate(_ndGateToken, wantsMl, _ndBridgeAudio());
    }
    // Opt-in (gear toggle, `nativeDetection`) sub-mode of the desktop
    // bridge: pull the engine's post-gate PCM via getRawAudioFrame and run
    // note_detect's OWN YIN/HPS/CREPE on it, instead of consuming the
    // engine's pitch verdicts. usingDesktopBridge stays true, so chords
    // still score through the engine's harmonic-comb ChordScorer
    // (scoreChord) and levels/source-binding are unchanged — only the
    // per-frame monophonic detection moves in-plugin. Reset in stopAudio().
    let usingNativeFrames = false;
    // Cached engine sample rate for the bridge path. There's no
    // audioCtx on this branch so any code that needs a sampleRate
    // reads it from here instead. Note that chord scoring on the
    // bridge does NOT consult this value — audio.scoreChord runs
    // inside the engine and reads the rate natively. The cache is
    // kept around for the monophonic detection helpers and any
    // future bridge-side consumer that still needs the renderer
    // view of the rate. Browser path uses audioCtx.sampleRate
    // directly. The engine rate is fixed for a session; if the user
    // changes audio device the detector restarts via the
    // restartAudio chain and refreshes this value.
    let bridgeSampleRate = 48000;
    // Cached `window.feedBackDesktop` reference captured at
    // startAudio() when the bridge path is active, so matchNotes()'s
    // chord branch can dispatch `audio.scoreChord(ctx)` without
    // re-resolving from window on every tick. Cleared by stopAudio().
    let bridgeDesktop = null;

    // ── Multi-input engine source binding (desktop bridge only) ───────────
    // Each detector instance can score its OWN engine input source so several
    // detectors (split-screen panels / a 4-input interface) run independently.
    // `sourceId` selects which engine source the bridge calls target:
    //   null  → the legacy default source 0, via the un-suffixed bridge methods
    //           (setChart / scoreChord / getNoteVerdicts / getRawPitch …). The
    //           default singleton and any instance that doesn't opt in stay here,
    //           so the single-player path is byte-identical.
    //   >= 0  → a dedicated source, via the *Source* bridge methods.
    // A caller may pass an explicit `opts.sourceId` (caller owns its lifecycle),
    // or `opts.ownSource: true` to have this instance allocate one on enable
    // (addSource) and free it on destroy (removeSource).
    let sourceId = (typeof opts.sourceId === 'number' && opts.sourceId >= 0)
        ? opts.sourceId : null;
    const _ndWantOwnSource = sourceId == null && !isDefault && opts.ownSource === true;
    let _ndOwnsSource = false;  // true once WE allocated sourceId (free on destroy)
    // Owned sources we unbound but couldn't free yet (removeSource missing/threw
    // — only reachable on a hypothetical mid-session addon downgrade). A list, so
    // a second orphan can't overwrite an earlier one; every entry is retried on the
    // next ready enable and on destroy, so an owned source can never leak silently.
    const _ndOrphanSourceIds = [];

    // Bridge-method routing: pick the *Source* variant when this instance is
    // bound to a dedicated source, else the legacy (source-0) method. Each
    // returns the native promise (or a resolved null when unavailable), and the
    // *Available helpers gate the bridge path the same way the inline typeof
    // checks used to. `a` is bridgeDesktop.audio.
    function _ndBridgeAudio() { return (bridgeDesktop && bridgeDesktop.audio) || null; }
    // Resolve the engine audio bridge FRESH — the cached bridgeDesktop is only set
    // while detection is enabled, but the calibration wizard can run earlier in
    // onboarding; fall back to the cached handle.
    function _ndResolveAudioBridge() {
        const d = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
        return (d && d.audio) || _ndBridgeAudio();
    }
    // Set the engine input gain live (bridge setGain('input', …)). Used both to
    // measure at unity during calibration and to apply the calibrated value.
    // Returns true if the bridge accepted it (i.e. we're on desktop).
    function _ndSetEngineGain(g) {
        const a = _ndResolveAudioBridge();
        if (a && typeof a.setGain === 'function') {
            try { a.setGain('input', g); return true; } catch (_) { /* best-effort */ }
        }
        return false;
    }
    // Re-assert the calibrated engine input gain (the wizard's result). No-op
    // until the user calibrates, or off-desktop.
    function _ndApplyEngineGain() {
        if (engineInputGain == null) return false;
        return _ndSetEngineGain(engineInputGain);
    }
    // True only when the addon exposes the FULL source-indexed scoring API this
    // instance routes to once bound. Binding a source without these would silently
    // break scoring on a downlevel/partial addon — so we never bind unless ready.
    function _ndDesktopSourceApiReady(a) {
        return !!a
            && typeof a.scoreSourceChord === 'function'
            && typeof a.setSourceChart === 'function'
            && typeof a.getSourceNoteVerdicts === 'function'
            && typeof a.getSourcePitchDetection === 'function';
    }
    function _ndBridgeScoreAvailable() {
        const a = _ndBridgeAudio(); if (!a) return false;
        return sourceId != null
            ? typeof a.scoreSourceChord === 'function'
            : typeof a.scoreChord === 'function';
    }
    function _ndBridgeScoreChord(ctx) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.scoreSourceChord === 'function')
            return a.scoreSourceChord(sourceId, ctx);
        if (sourceId == null && typeof a.scoreChord === 'function')
            return a.scoreChord(ctx);
        return Promise.resolve(null);
    }
    function _ndBridgeVerifierAvailable() {
        const a = _ndBridgeAudio(); if (!a) return false;
        return sourceId != null
            ? (typeof a.setSourceChart === 'function' && typeof a.getSourceNoteVerdicts === 'function')
            : (typeof a.setChart === 'function' && typeof a.getNoteVerdicts === 'function');
    }
    function _ndBridgeSetChart(chart) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.setSourceChart === 'function')
            return a.setSourceChart(sourceId, chart);
        if (sourceId == null && typeof a.setChart === 'function')
            return a.setChart(chart);
        return Promise.resolve(null);
    }
    function _ndBridgeGetVerdicts(songTime, playing) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.getSourceNoteVerdicts === 'function')
            return a.getSourceNoteVerdicts(sourceId, songTime, playing);
        if (sourceId == null && typeof a.getNoteVerdicts === 'function')
            return a.getNoteVerdicts(songTime, playing);
        return Promise.resolve(null);
    }
    // Post-gate raw YIN (sustain glow): prefer getRawPitch; fall back to the
    // active-pitch query on an addon that predates it (same as the legacy path).
    function _ndBridgeRawPitch() {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null) {
            if (typeof a.getSourceRawPitch === 'function') return a.getSourceRawPitch(sourceId);
            if (typeof a.getSourcePitchDetection === 'function') return a.getSourcePitchDetection(sourceId);
            return Promise.resolve(null);
        }
        if (typeof a.getRawPitch === 'function') return a.getRawPitch();
        if (typeof a.getPitchDetection === 'function') return a.getPitchDetection();
        return Promise.resolve(null);
    }
    // Pull a frame of post-gate mono PCM from the engine for the
    // native-frame detection mode. Routes to the source-indexed pull for a
    // bound (multi-input) source, else the default-source pull. Returns a
    // Float32Array (up to `numSamples`, zero-padded on a cold ring) or null
    // when the addon predates the API (caller then can't enter the mode).
    function _ndBridgeRawAudioFrame(numSamples) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null) {
            if (typeof a.getSourceRawAudioFrame === 'function') return a.getSourceRawAudioFrame(sourceId, numSamples);
            return Promise.resolve(null);
        }
        if (typeof a.getRawAudioFrame === 'function') return a.getRawAudioFrame(numSamples);
        return Promise.resolve(null);
    }
    // Whether the engine exposes the raw-audio-frame pull this instance
    // would use (source-indexed when bound, default otherwise). Gates entry
    // into native-frame detection — a downlevel addon keeps the verdict path.
    function _ndBridgeRawFramesAvailable() {
        const a = _ndBridgeAudio(); if (!a) return false;
        if (sourceId != null) return typeof a.getSourceRawAudioFrame === 'function';
        return typeof a.getRawAudioFrame === 'function';
    }
    // Active (ML-or-YIN) detection for the monophonic scoring branch.
    function _ndBridgePitch() {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.getSourcePitchDetection === 'function')
            return a.getSourcePitchDetection(sourceId);
        if (sourceId == null && typeof a.getPitchDetection === 'function')
            return a.getPitchDetection();
        return Promise.resolve(null);
    }
    // Free an engine source we allocated. Re-resolves window.feedBackDesktop
    // because stopAudio() clears bridgeDesktop before destroy() runs.
    // Best-effort removeSource(id). Re-resolves window.feedBackDesktop because
    // stopAudio() clears bridgeDesktop. Returns true iff the source was freed
    // (or there was nothing to free).
    function _ndTryFreeSource(id) {
        if (id == null) return true;
        const d = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
        const a = d && d.audio;
        if (!a || typeof a.removeSource !== 'function') return false;
        try {
            const r = a.removeSource(id);
            // removeSource is async IPC on the desktop bridge — the call is
            // dispatched (the engine removes the source) regardless of the result,
            // so we count it as freed; swallow any rejection so a transient failure
            // can't surface as an unhandled promise rejection.
            if (r && typeof r.then === 'function') r.then(undefined, () => {});
            return true;
        } catch (_) { return false; }
    }
    // Retry freeing every previously-orphaned source (see _ndOrphanSourceIds);
    // keep the ones that still can't be freed.
    function _ndFlushOrphanSources() {
        for (let i = _ndOrphanSourceIds.length - 1; i >= 0; i--) {
            if (_ndTryFreeSource(_ndOrphanSourceIds[i])) _ndOrphanSourceIds.splice(i, 1);
        }
    }
    // Free the source we own (called from destroy). Also retries any orphans from
    // an earlier downgrade — at destroy the addon is usually ready again, so those
    // get reclaimed. If the current source can't be freed (removeSource missing —
    // a downlevel addon), the engine reclaims it on its own teardown; the orphan
    // list can't help on a dead instance (no later enable), so we don't pretend to.
    function _ndReleaseOwnedSource() {
        _ndFlushOrphanSources();
        if (_ndOwnsSource && sourceId != null) _ndTryFreeSource(sourceId);
        _ndOwnsSource = false;
        sourceId = null;
    }

    // ── Onboarding-selected input source (audio-input capability domain) ───────
    // The PHYSICAL input device + input channel are chosen ONCE in the onboarding
    // Input Setup wizard (input_setup → audio-input 'select-source'). Opening the
    // domain's CURRENTLY-selected source runs the audio_engine provider's
    // source.open, which calls setDevice()+startAudio() on the native engine for
    // THAT device (ASIO included). We open it before BOTH live detection and
    // calibration so whatever device + input the user picks in the wizard is what
    // note detection uses — and re-opening picks up a selection that changed
    // since enable. The channel is applied on top by the engine's saved device
    // settings (set during the wizard's calibration) + our setSourceInputChannel.
    // Degrades to a no-op (returns false) on a host without the capability
    // runtime / domain — the caller's legacy startAudio is the fallback. Distinct
    // requester ids keep the detect-lifetime ref and the transient calibration
    // ref independent (the domain ref-counts per requester).
    const ND_AUDIO_REQUESTER = 'note_detect';
    const ND_AUDIO_CAL_REQUESTER = 'note_detect:calibration';
    async function _ndOpenSelectedInputSource(requesterId, purpose) {
        const caps = (typeof window !== 'undefined') && window.slopsmith && window.slopsmith.capabilities;
        if (!caps || typeof caps.command !== 'function') return false;
        try {
            const res = await caps.command('audio-input', 'open-source', {
                requester: requesterId,
                // No requiredChannelShape: open the source at its native shape
                // (the compat check then always passes — mono or stereo device).
                // Note detection picks its own input channel via the engine's
                // setSourceInputChannel, independent of the session channel shape.
                payload: { purpose: purpose || 'note-detection' },
            });
            return !!(res && (res.outcome === 'handled' || res.status === 'open'));
        } catch (_) { return false; }
    }
    async function _ndCloseSelectedInputSource(requesterId) {
        const caps = (typeof window !== 'undefined') && window.slopsmith && window.slopsmith.capabilities;
        if (!caps || typeof caps.command !== 'function') return;
        try { await caps.command('audio-input', 'close-source', { requester: requesterId, payload: {} }); }
        catch (_) { /* best-effort */ }
    }
    // True when the desktop engine exposes the continuous chart-verifier
    // API (audio.setChart / audio.getNoteVerdicts) AND a chart has been
    // pushed for the current song. When set, the desktop detect loop drains
    // engine-finalized verdicts instead of running the per-tick matchNotes()
    // scoreChord IPC — the engine scores the chart on its own background
    // thread, so a starved renderer event loop no longer drops note runs.
    // false on a downlevel addon (pre-NoteVerifier build), where the old
    // matchNotes path stays in force unchanged.
    let _ndUsingEngineVerifier = false;
    // Chart-note lookup for the verifier path: noteKey -> the chart note
    // object ({ s, f, t, sus, ho... }), so a drained verdict can be mapped
    // back to its note for the judgment pipeline. Rebuilt on each chart push.
    let _ndVerifierChartById = new Map();
    // Chord grouping for the verifier path. The engine scores every chord
    // constituent as an independent note; these maps let the drain step
    // regroup the per-constituent verdicts into one chord judgment with
    // N-of-M leniency (chordHitRatio), matching the legacy chord path.
    //   _ndVerifierChords     : chordKey -> { t, memberIds[], memberNotes[], maxSus }
    //   _ndVerifierChordKeyOf : constituent noteKey -> chordKey
    //   _ndPendingChords      : chordKey -> Map(noteKey -> verdict) still arriving
    let _ndVerifierChords = new Map();
    let _ndVerifierChordKeyOf = new Map();
    let _ndPendingChords = new Map();
    // Signature of the chart last pushed to the engine (note/chord counts +
    // arrangement). The chart loads asynchronously — `hw.getNotes()` is empty
    // for a moment after `song:loaded` — so the detect loop re-pushes whenever
    // the live signature diverges from this, covering late chart load and
    // mid-session arrangement switches.
    let _ndVerifierChartSig = '';
    // Engine-drain health counters (surfaced in the diagnostic export). Every
    // way a drained verdict can fail to reach the HUD is silent by
    // construction — a `continue` in the drain loop — so a scoring counter that
    // freezes or leaps has no on-disk trace. These give one.
    //   dropUnknownId       : verdict whose id isn't in _ndVerifierChartById.
    //                         Non-zero => the engine's chart and ours disagree,
    //                         and those notes are scored by neither.
    //   suppressedRedelivery: verdict for a note we already counted, arriving
    //                         again. Non-zero is EXPECTED after a mid-song
    //                         setChart (which un-finalizes the whole chart
    //                         engine-side); it means the ledger guard below did
    //                         its job. Before that guard existed these
    //                         double-counted.
    //   maxBatch            : largest single drain. drainVerdicts() is an
    //                         uncapped swap, so a big batch means the engine ran
    //                         a long stretch we never picked up.
    const _ndDrainStats = { dropUnknownId: 0, suppressedRedelivery: 0, maxBatch: 0 };
    // Last playhead pushed to the engine, in corrected song time. Lets
    // _ndDrainEngineVerdicts spot a backward jump (drill A-B loop wrap or a
    // manual seek-back) and clear the dedup entries the engine is re-opening.
    let _ndLastPushedPlayhead = 0;

    // ── Contained-playback verifier (setContainedChart / pushContainedPlayhead
    //    / drainContainedVerdicts / releaseContainedChart) ────────────────────
    // A non-chart consumer (SlopScale, Chord Sprint) runs its OWN exercise
    // transport — its own generated chart, scored against the player's real
    // tuning, independent of the host song's playhead. It can't ride the host
    // setChart slot (that's owned for the host song; overwriting it would
    // clobber host scoring), so this is an ADDITIVE path that drives the SAME
    // engine NoteVerifier with the plugin's chart + the plugin's playhead,
    // SUSPENDING host-song scoring while armed (one engine chart slot).
    //
    // Unlike the host path, verdicts are NOT run through recordJudgment / the
    // HUD / notedetect:* events — they are buffered RAW and the consumer drains
    // them and owns judgment. This keeps the contained path a thin verdict pipe
    // that can't pollute the host detector's stats/diagnostics.
    let _ndContainedActive = false;
    // Generation token, bumped on every release/disable (and a fresh arm). An
    // async setContainedChart / pushContainedPlayhead captures it before its
    // await and bails on resume if it changed — so a release/disable/newer-arm
    // that ran during the IPC can't resurrect contained mode or write stale
    // state (the single engine slot stays consistent with the latest intent).
    let _ndContainedGen = 0;
    // Cap the raw verdict buffer so a consumer that stalls drainContainedVerdicts()
    // can't grow it without bound — keep the most recent, drop the oldest.
    const _ND_CONTAINED_BUF_MAX = 512;
    // verdict.id -> the caller's note object, so the caller can map a drained
    // verdict back to its exercise note. The caller supplies the ids.
    let _ndContainedById = new Map();
    // Sanitized tuning ctx (_ndSanitizeVerifyCtx output) the contained chart is
    // scored under, or null when it tracks the host song's live tuning.
    let _ndContainedCtx = null;
    // Raw engine verdicts awaiting drainContainedVerdicts().
    let _ndContainedVerdictBuf = [];
    // Last playhead the caller pushed (for backward-jump dedup of the buffer).
    let _ndContainedLastPlayhead = 0;
    // True while a contained chart is armed: the host detect loop must not
    // re-push or drain the host chart, and a host song:loaded must not clobber
    // the engine slot. Cleared on release, which re-pushes the host chart (so
    // _ndUsingEngineVerifier is re-derived — no saved copy needed).
    let _ndHostChartSuspended = false;
    // Whether the desktop engine's polyphonic ML detector (Basic Pitch) is
    // actually active this session — queried once at bridge startup via
    // `audio.isMlNoteDetection()`. false on a downlevel addon or when the ML
    // model failed to load (the engine then runs the YIN fallback). Stamped
    // into the diagnostic export so a session can be tied to its detector.
    let bridgeMlActive = false;
    // Detector identity captured DURING detection (not read at diagnostic-
    // Onset-event state for the desktop ML bridge — used to gate CHORD timing.
    // Each detectNotes note carries a per-pitch `onsetSeq` counter; when it
    // increases, that pitch was struck anew. A chord commits a hit only on a
    // poll where one of its pitches has a fresh onset, so the chord's pitches
    // ringing on through the riff don't drag the match early.
    //   bridgeOnsetSeqSeen — last consumed onsetSeq per MIDI pitch
    //   bridgeNewOnsets    — onsets first seen on the current poll:
    //                        midi -> { ageMs, conf }
    //   bridgeOnsetPrimed  — false until the first poll has recorded a seq
    //                        baseline (so pre-existing onsets aren't replayed)
    let bridgeOnsetSeqSeen = new Map();
    let bridgeNewOnsets = new Map();
    let bridgeOnsetPrimed = false;

    // DOM refs
    const container = opts.container || document.getElementById('player');
    const instanceRoot = document.createElement('div');
    instanceRoot.className = 'nd-instance-root';
    instanceRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    // Skin attribute drives every nd-* component's CSS custom properties
    // (assets/plugin.css). Stamped per instance — splitscreen panels stay
    // independent of <body>-level state.
    try { instanceRoot.setAttribute('data-nd-skin', _ndLoadSkin()); } catch (e) {}
    let detectBtn = null;
    let gearBtn = null;

    // Shared live-state snapshot passed to subsystems. Returns all scoring,
    // detection, and settings vars both HUD and summary-ui need. Called at
    // up to 30fps (HUD) and once per summary build — cost is trivial.
    const _factoryState = () => ({
        hw: resolveHw(),
        enabled,
        hits, misses, streak, bestStreak, score, multiplier, maxMultiplier,
        detectedString, detectedConfidence, detectedDisplayMidi, detectedMidi, detectedFret,
        lastChordScore, lastChordHit, lastChordTotal, lastChordTime,
        edgeFlashEnabled, latencyOffset, detectionConfidenceMin,
        missMarkerDuration, hitGlowDuration, showTimingErrors, showPitchErrors,
        noteResults,
        // summary-ui extras
        sectionStats, tuningMode, _recArmedForTraining: _recCapture.getRecArmedForTraining(),
        _diagBreakdown: _diagCatalog.getDiagBreakdown(),
        _diagTimingErrors: _diagCatalog.getDiagTimingErrors(),
        _diagPitchErrors: _diagCatalog.getDiagPitchErrors(),
        // settings-panel extras (slider init + applySettings write surface)
        timingTolerance, pitchTolerance,
        timingHitThreshold, chordTimingHitThreshold, pitchHitThreshold,
        detectionMethod, detectionMethodUserSet, nativeDetection,
        inputGain, chordHitRatio,
        selectedChannel, selectedDeviceId,
    });

    // Drill conductor subsystem (nd-carve-5 cut 3). Constructed before createHUD
    // so drillCallbacks can reference _drillConductor methods directly.
    const _drillConductor = createDrillConductor({
        getHw: resolveHw,
        getAudioCtx: () => audioCtx,
        instanceRoot,
        clearWindow: (a, b) => _drillClearWindow(a, b),
        getChartNotes: (h) => _ndChartNotes(h),
        getChartChords: (h) => _ndChartChords(h),
        getAutoDrillMissesSetting: _ndAutoDrillMissesSetting,
        getChartOnsets: (h) => _ndChartOnsets(h),
        getEnabled: () => enabled,
        enable,
        getNoteResults: () => noteResults,
    });

    // HUD + draw-overlay subsystem (nd-carve-5 cut 1). All scoring/detection
    // state is exposed via getState() so the HUD module stays free of factory
    // closure imports. drillCallbacks wired from _drillConductor (nd-carve-5 cut 3).
    const _hud = createHUD({
        instanceRoot,
        loadSkin: _ndLoadSkin,
        noteKey,
        noteStateFor,
        getState: _factoryState,
        drillCallbacks: {
            syncFromLoopState: _drillConductor.syncFromLoopState,
            conductorTick: _drillConductor.conductorTick,
            render: _drillConductor.render,
        },
    });

    // Diagnostic-catalog subsystem (nd-carve cut 6). Owns all diagnostic state,
    // live-judgment streaming, miss-breakdown counters, downloadable-JSON payload,
    // the diagnostic track catalog, and the post-play structured report.
    // All mutable factory deps passed as accessor functions (LIVE-ACCESSOR RULE).
    const _diagCatalog = createDiagnosticCatalog({
        getHw:                      resolveHw,
        getHits:                    () => hits,
        getMisses:                  () => misses,
        getBestStreak:              () => bestStreak,
        getSectionStats:            () => sectionStats,
        getRescueCalls:             () => _rescueCalls,
        getRescueWindows:           () => _rescueWindows,
        getRescueHits:              () => _rescueHits,
        getRescueSkippedSilent:     () => _rescueSkippedSilent,
        getNdUsingEngineVerifier:   () => _ndUsingEngineVerifier,
        getNdDrainStats:            () => _ndDrainStats,
        getDetectionMethod:         () => detectionMethod,
        getTimingTolerance:         () => timingTolerance,
        getTimingHitThreshold:      () => timingHitThreshold,
        getChordTimingHitThreshold: () => chordTimingHitThreshold,
        getPitchTolerance:          () => pitchTolerance,
        getPitchHitThreshold:       () => pitchHitThreshold,
        getChordHitRatio:           () => chordHitRatio,
        getDetectionConfidenceMin:  () => detectionConfidenceMin,
        getLatencyOffset:           () => latencyOffset,
        getInputGain:               () => inputGain,
        getSelectedChannel:         () => selectedChannel,
        getTuningMode:              () => tuningMode,
        getRecArmedForTraining:     () => _recCapture.getRecArmedForTraining(),
        getCurrentFilename:         () => _ndShared.currentFilename,
        getDiagnosticReturn:        () => _ndShared.diagnosticReturn,
        clearDiagnosticReturnState: () => _ndClearDiagnosticReturnState(),
        ndVersion:                  _ND_VERSION,
    });

    // Summary UI subsystem (nd-carve-5 cut 2). Manages end-of-song overlay,
    // XP submission, deferred reveal, and end-of-song event subscription.
    const _summaryUi = createSummaryUi({
        getHw: resolveHw,
        getState: _factoryState,
        instanceRoot,
        isDefault,
        disable,
        dispatchInstanceEvent,
        getCurrentFilename: () => _ndShared.currentFilename,
        getDiagnosticReturn: () => _ndShared.diagnosticReturn,
        getSetLog: () => _ndSetLog,
        setSetLog: (v) => { _ndSetLog = v; },
        ndLoadSkin: _ndLoadSkin,
        ndResultsGlowOn: _ndResultsGlowOn,
        ndAutoSaveEnabled: _ndAutoSaveEnabled,
        ndQueueShowScores: _ndQueueShowScores,
        ndQueueSetSummaryEnabled: _ndQueueSetSummaryEnabled,
        ndQueueDelaySeconds: _ndQueueDelaySeconds,
        ndSongBestId: _ndSongBestId,
        ndReadSongBest: _ndReadSongBest,
        ndWriteSongBest: _ndWriteSongBest,
        ndSaveCard: _ndSaveCard,
        ndShareCardClick: _ndShareCardClick,
        ndReturnToPreviousSong: _diagCatalog.ndReturnToPreviousSong,
        downloadDiagnostic: _diagCatalog.downloadDiagnostic,
        getDiagnosticTrack: _diagCatalog.getDiagnosticTrackForSession,
        buildDiagnosticPlayReport: _diagCatalog.buildDiagnosticPlayReport,
        renderDiagnosticPlayHtml: _diagCatalog.renderDiagnosticPlayHtml,
        diagPercentile: _diagCatalog.diagPercentile,
    });
    // Reference-recording capture subsystem (nd-carve-7 cut 7). Moved from
    // main.js to src/recording-capture.js; constructed here after _diagCatalog
    // and _summaryUi so both can be passed as live accessors.
    _recCapture = createRecordingCapture({
        getHw:                  resolveHw,
        getSelectedChannel:     () => selectedChannel,
        getSelectedDeviceId:    () => selectedDeviceId,
        getInputGain:           () => inputGain,
        getLatencyOffset:       () => latencyOffset,
        getTuningMode:          () => tuningMode,
        getAutoRecord:          () => autoRecord,
        getDetectPreference:    () => detectPreference,
        isDefault,
        getCurrentFilename:     () => _ndShared.currentFilename,
        getDiagCatalog:         () => _diagCatalog,
        getSummaryUi:           () => _summaryUi,
        getDetectionMethod:     () => detectionMethod,
        getTimingTolerance:     () => timingTolerance,
        getTimingHitThreshold:  () => timingHitThreshold,
        getPitchTolerance:      () => pitchTolerance,
        getUsingDesktopBridge:  () => usingDesktopBridge,
        getEnabled:             () => enabled,
        openInstrumentStream,
        getTrainingChartSnapshot: _ndTrainingChartSnapshot,
    });
    // Calibration Wizard subsystem (nd-carve-8 cut 8).
    const _calWizard = createCalibrationWizard({
        // Live accessors — LIVE-ACCESSOR RULE: read at call time, never captured.
        getInputLevel:              () => inputLevel,
        getInputPeak:               () => inputPeak,
        getDetectedMidi:            () => detectedMidi,
        getDetectedConfidence:      () => detectedConfidence,
        getDetectedString:          () => detectedString,
        getDetectedFret:            () => detectedFret,
        getDetectedDisplayMidi:     () => detectedDisplayMidi,
        getDetectionConfidenceMin:  () => detectionConfidenceMin,
        getLatencyOffset:           () => latencyOffset,
        getInputGain:               () => inputGain,
        getEngineInputGain:         () => engineInputGain,
        getEnabled:                 () => enabled,
        getUsingDesktopBridge:      () => usingDesktopBridge,
        getAudioCtx:                () => audioCtx,
        getBridgeSampleRate:        () => bridgeSampleRate,
        getBridgeDesktop:           () => bridgeDesktop,
        getSelectedDeviceId:        () => selectedDeviceId,
        getSelectedChannel:         () => selectedChannel,
        getCurrentArrangement:      () => currentArrangement,
        getCurrentStringCount:      () => currentStringCount,
        getTuningOffsets:           () => tuningOffsets,
        getHits:                    () => hits,
        getMisses:                  () => misses,
        getDetectionMethod:         () => detectionMethod,
        getDiagCatalog:             () => _diagCatalog,
        // Write-back callbacks — wizard calls these to mutate factory state.
        setInputGain:          (v) => { inputGain = v; if (gainNode) gainNode.gain.value = v; },
        setLatencyOffset:      (v) => { latencyOffset = v; },
        setEngineInputGain:    (v) => { engineInputGain = v; },
        setCurrentArrangement: (v) => { currentArrangement = v; },
        setSelectedChannel:    (v) => { selectedChannel = v; },
        // Stable fn refs — hoisted function declarations, safe at construction time.
        resolveHw,
        enable,
        saveSettings,
        applyEngineGain:          _ndApplyEngineGain,
        openInputSource:          _ndOpenSelectedInputSource,
        closeInputSource:         _ndCloseSelectedInputSource,
        syncChartFromHw:          _syncChartStateFromHw,
        resetCalibrationSamples:  _resetCalibrationSamples,
        ndSetEngineGain:          _ndSetEngineGain,
        ndResolveAudioBridge:     _ndResolveAudioBridge,
        ndMidiToName:             _ndMidiToName,
        ndMidiFromStringFret:     _ndMidiFromStringFret,
        ndStandardMidiFor:        _ndStandardMidiFor,
        ndNearestOctaveCents:     _ndNearestOctaveCents,
        ndFormatMs:               _ndFormatMs,
        ndEscapeHtml:             _ndEscapeHtml,
        ndHealthDetectedLine:     _ndHealthDetectedLine,
        ndHealthInputChannelLabel: _ndHealthInputChannelLabel,
        ndHealthDetectorPathLabel: _ndHealthDetectorPathLabel,
        formatLevel:              calibrationFormatLevel,
        calRequester:             ND_AUDIO_CAL_REQUESTER,
        restartAudio,
        openCalibrationLab:       openInstrumentCalibrationLab,
    });
    // Settings panel subsystem (nd-carve-5 cut 4). showSettings, drawSettingsVU,
    // VU state, populateDevices, onDeviceChange, onChannelChange, setMethod all
    // live in settings-panel.js; main.js exposes the write seam (applySettings).
    const _settingsPanel = createSettingsPanel({
        instanceRoot,
        saveSettings,
        getState: _factoryState,
        getInputLevel: () => inputLevel,
        getInputPeak:  () => inputPeak,
        applySettings,
        attachInstanceRoot,
        setChannel,
        loadCrepe: _ndLoadCrepe,
        restartAudio,
        getEnabled: () => enabled,
        getRecordingState:    () => _recCapture.getRecordingState(),
        armRecording:         () => _recCapture.armRecording(),
        disarmRecording:      () => _recCapture.disarmRecording(),
        armRecordingForTraining: () => _recCapture.armRecordingForTraining(),
        saveRecordingNow:     () => _recCapture.saveRecordingNow(),
        discardRecording:     () => _recCapture.discardRecording(),
        renderDetectionHealth,
        openCalibrationWizard,
        openInstrumentCalibrationLab,
        launchDiagnosticTrack:    _diagCatalog.ndLaunchDiagnosticTrack,
        wireRangeScrollLock:      _ndWireSettingsRangeScrollLock,
    });
    // Draw hook — registered once per instance; removed in destroy().
    // The hook itself early-returns when !enabled, so the cost is
    // minimal for a disabled instance. Stored so removeDrawHook() can
    // find the same reference. If `hw` isn't resolved at construction
    // time (plugin loaded before highway), ensureDrawHook retries on
    // first enable.
    const drawHookFn = _hud.drawOverlay;
    let drawHookRegistered = false;
    function ensureDrawHook() {
        if (drawHookRegistered) return;
        const h = resolveHw();
        if (h && h.addDrawHook) {
            h.addDrawHook(drawHookFn);
            drawHookRegistered = true;
        }
        // slopsmith#254 — publish per-note judgments so the active
        // renderer lights up the gem itself (and keeps a held sustain
        // glowing) instead of us drawing an overlay ring near it. The
        // provider returns null while disabled, so registering it once
        // and leaving it across enable/disable cycles is harmless; it's
        // only cleared in destroy(). Per-instance hw (splitscreen panels
        // each have their own createHighway()), so no cross-panel clash.
        // The core API is last-wins; we still avoid stomping a provider
        // some other plugin registered first (we'd be re-registering our
        // own `noteStateFor` across a disable→enable, which is a no-op).
        if (h && h.setNoteStateProvider) {
            const existing = (typeof h.getNoteStateProvider === 'function') ? h.getNoteStateProvider() : null;
            if (existing == null || existing === noteStateFor) h.setNoteStateProvider(noteStateFor);
        }
    }

    // ── Settings persistence (only the default singleton writes) ──────
    function saveSettings() {
        if (!isDefault) return;
        try {
            localStorage.setItem(_ND_STORAGE_KEY, JSON.stringify({
                deviceId: selectedDeviceId,
                channel: selectedChannel,
                method: detectionMethod,
                // Explicit override flag so the loader can tell a deliberate
                // method choice from the always-persisted default (see load).
                methodUserSet: detectionMethodUserSet,
                nativeDetection,
                timingTolerance,
                pitchTolerance,
                timingHitThreshold,
                chordTimingHitThreshold,
                pitchHitThreshold,
                showTimingErrors,
                showPitchErrors,
                edgeFlash: edgeFlashEnabled,
                tuningMode,
                autoRecord,
                frameSize,
                autoCalibrate,
                detectEnabled: detectPreference,
                missMarkerDuration,
                hitGlowDuration,
                inputGain,
                engineInputGain,
                latencyOffset,
                chordHitRatio,
                detectionConfidenceMin,
            }));
        } catch (e) { /* unavailable */ }
    }

    // Pure var-assign dispatcher so settings-panel.js can write settings closure
    // vars without holding a reference to each var individually. Hot-path vars
    // (timingTolerance etc.) stay in the main closure so matchNotes reads them
    // directly — no getter indirection in the scoring inner loop.
    // nd-carve-5 cut 4 — settings-panel subsystem writes through this seam.
    function applySettings(changes) {
        if ('timingTolerance' in changes) timingTolerance = changes.timingTolerance;
        if ('pitchTolerance' in changes) pitchTolerance = changes.pitchTolerance;
        if ('timingHitThreshold' in changes) timingHitThreshold = changes.timingHitThreshold;
        if ('chordTimingHitThreshold' in changes) chordTimingHitThreshold = changes.chordTimingHitThreshold;
        if ('pitchHitThreshold' in changes) pitchHitThreshold = changes.pitchHitThreshold;
        if ('detectionMethod' in changes) detectionMethod = changes.detectionMethod;
        if ('detectionMethodUserSet' in changes) detectionMethodUserSet = changes.detectionMethodUserSet;
        if ('nativeDetection' in changes) nativeDetection = changes.nativeDetection;
        if ('inputGain' in changes) inputGain = changes.inputGain;
        if ('chordHitRatio' in changes) chordHitRatio = changes.chordHitRatio;
        if ('selectedDeviceId' in changes) selectedDeviceId = changes.selectedDeviceId;
        if ('selectedChannel' in changes) selectedChannel = changes.selectedChannel;
        if ('latencyOffset' in changes) latencyOffset = changes.latencyOffset;
        if ('edgeFlashEnabled' in changes) edgeFlashEnabled = changes.edgeFlashEnabled;
        if ('showTimingErrors' in changes) showTimingErrors = changes.showTimingErrors;
        if ('showPitchErrors' in changes) showPitchErrors = changes.showPitchErrors;
        if ('missMarkerDuration' in changes) missMarkerDuration = changes.missMarkerDuration;
        if ('hitGlowDuration' in changes) hitGlowDuration = changes.hitGlowDuration;
        if ('detectionConfidenceMin' in changes) detectionConfidenceMin = changes.detectionConfidenceMin;
    }

    // Open an instrument capture stream, relaxing over-constrained inputs.
    // Two device classes break a strict getUserMedia on macOS in particular:
    //   - mono-only USB interfaces (e.g. the chart Real Tone Cable)
    //     reject `channelCount: 2`;
    //   - a stale saved `deviceId` (device unplugged since last session)
    //     rejects `deviceId: { exact }`.
    // OverconstrainedError.constraint names the offending constraint, so we
    // drop exactly that one and retry rather than guessing — dropping the
    // device when the real problem is the channel count would needlessly
    // discard the user's chosen interface, and dropping channelCount for an
    // unrelated constraint would mask the real failure. We therefore only
    // relax the *named* constraint (the supported browsers — Chrome/Edge —
    // always populate `e.constraint`); an unnamed failure is treated as the
    // documented mono-only-device case since channelCount is the only other
    // constraint we set that can over-constrain. Anything else rethrows. The
    // loop relaxes one constraint per failure and is guaranteed to terminate
    // (each branch deletes a still-present key or rethrows). Mutates
    // `constraints` in place.
    //
    // `allowDeviceFallback` gates the *destructive* part of the deviceId
    // path. A device that's still enumerating at startup (the exact race the
    // auto-enable retry addresses) also fails the `deviceId: { exact }` match
    // transiently — so forgetting the saved device on the first such failure
    // would permanently switch a Real-Tone-Cable user back to the default
    // input on a cold load. The construct-time auto-enable therefore passes
    // `false` on its silent first attempt: a deviceId overconstraint is
    // surfaced (not forgotten), letting the delayed retry try the real device
    // again. User-initiated enables and the retry pass `true`, where a deviceId
    // failure does mean a genuinely stale device → forget it and fall back.
    async function openInstrumentStream(constraints, { allowDeviceFallback = true } = {}) {
        for (;;) {
            try {
                return await navigator.mediaDevices.getUserMedia(constraints);
            } catch (e) {
                if (e.name !== 'OverconstrainedError') throw e;
                if (e.constraint === 'deviceId' && constraints.audio.deviceId) {
                    if (!allowDeviceFallback) {
                        // Silent auto-enable attempt — the device may just be
                        // mid-enumeration. Don't forget it or fall back; surface
                        // the failure so the caller's delayed retry can re-try
                        // the real device.
                        throw e;
                    }
                    // Saved device is gone — forget it so future opens default.
                    selectedDeviceId = '';
                    saveSettings();
                    delete constraints.audio.deviceId;
                } else if ((e.constraint === 'channelCount' || !e.constraint)
                           && constraints.audio.channelCount !== undefined) {
                    // Mono-only device (e.g. Real Tone Cable): drop stereo and
                    // keep the user's selected device.
                    delete constraints.audio.channelCount;
                } else {
                    // A constraint we can't safely relax without discarding the
                    // user's intent (or an already-relaxed one) — surface it.
                    throw e;
                }
            }
        }
    }

    // ── Audio pipeline ────────────────────────────────────────────────
    async function startAudio() {
        try {
            // Desktop (Electron) bridge path. When the slopsmith-desktop
            // shell is hosting us, the native JUCE engine already owns
            // the audio device — see src/main/audio-bridge.ts in
            // slopsmith-desktop. Drive monophonic detection from its
            // `audio:getPitchDetection` IPC and polyphonic chord
            // scoring from its `audio:scoreChord` IPC (native
            // ChordScorer + lock-free input ring), instead of opening
            // a parallel getUserMedia/Web-Audio chain. That parallel
            // path fails on Linux Electron builds (Chromium denies
            // `media` for the localhost-served renderer with no
            // permission handler set) and duplicates work the engine
            // is already doing every frame.
            //
            // The bridge feature-detects each IPC method separately,
            // so an older slopsmith-desktop without scoreChord still
            // gets the monophonic path; chord scoring is skipped
            // (the chord branch in matchNotes() short-circuits when
            // the IPC is missing, same as the pre-bridge browser
            // path's no-buffer guard).
            //
            // Borrower mode (caller supplied a stream or AudioContext)
            // skips this branch — those callers own the lifecycle and
            // expect a real Web-Audio graph, e.g. for tap-tempo or
            // visualisation taps.
            const desktop = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
            const canUseDesktopBridge = !externalStream && !externalAudioCtx
                && desktop && desktop.isDesktop
                && desktop.audio
                && typeof desktop.audio.getPitchDetection === 'function'
                && typeof desktop.audio.isAvailable === 'function';
            if (canUseDesktopBridge) {
                let bridgeReady = false;
                try {
                    bridgeReady = await desktop.audio.isAvailable();
                } catch (_) { /* treat as unavailable */ }
                if (bridgeReady) {
                    // Tie live detection to the onboarding Input Setup wizard's
                    // selected input: open the audio-input domain's selected
                    // source, which configures + starts the native engine on that
                    // device (ASIO included) before we read pitch. No-op without
                    // the domain — the legacy startAudio below is the fallback.
                    await _ndOpenSelectedInputSource(ND_AUDIO_REQUESTER, 'note-detection');
                    // Start the engine if the Audio Plugins panel hasn't
                    // already done so — without it getPitchDetection
                    // returns sentinel values (frequency: -1) forever.
                    // (When open-source above handled it, the engine is already
                    // running on the selected device, so this is a no-op.)
                    try {
                        const running = typeof desktop.audio.isAudioRunning === 'function'
                            ? await desktop.audio.isAudioRunning()
                            : false;
                        if (!running && typeof desktop.audio.startAudio === 'function') {
                            await desktop.audio.startAudio();
                        }
                    } catch (_) { /* engine surfaces its own errors */ }

                    usingDesktopBridge = true;
                    bridgeDesktop = desktop;
                    accumBuffer = new Float32Array(0);

                    // Bind a dedicated engine input source when this instance opted
                    // in (multi-input / split-screen) — but ONLY when the addon
                    // exposes the FULL source-indexed scoring API. A partial/
                    // downlevel addon (e.g. addSource without scoreSourceChord)
                    // must NOT leave us bound to a source we can't score, which
                    // would silently stop scoring. In that case we stay on source 0
                    // (legacy methods). Allocate once and keep it across disable/
                    // enable (freed only on destroy); the default singleton + un-
                    // opted instances stay on source 0 — byte-identical.
                    if (_ndDesktopSourceApiReady(desktop.audio)) {
                        // A ready addon can also reclaim any earlier orphans.
                        _ndFlushOrphanSources();
                        // Re-bind a caller-managed sourceId that an earlier degraded
                        // enable cleared (opts.sourceId is the source of truth).
                        if (sourceId == null && !_ndOwnsSource
                            && typeof opts.sourceId === 'number' && opts.sourceId >= 0) {
                            sourceId = opts.sourceId;
                        }
                        if (_ndWantOwnSource && sourceId == null
                            && typeof desktop.audio.addSource === 'function') {
                            try {
                                const id = await desktop.audio.addSource(_ndChannelIndex, _ndDeviceKey);
                                if (typeof id === 'number' && id >= 0) {
                                    sourceId = id;
                                    _ndOwnsSource = true;
                                }
                            } catch (_) { /* stay on source 0 */ }
                        }
                        // Keep the bound source's input channel in sync with the
                        // current selection. A fresh addSource already bound it, but a
                        // REUSED owned source — OR a caller-managed opts.sourceId — may
                        // have had its channel changed (via setChannel) while detect was
                        // disabled, so re-route on every enable for any non-default
                        // source this detector drives (matches setChannel's sourceId!==0
                        // contract). Never source 0 (the shared default).
                        if (sourceId != null && sourceId !== 0
                            && typeof desktop.audio.setSourceInputChannel === 'function') {
                            try {
                                desktop.audio.setSourceInputChannel(sourceId, _ndChannelIndex);
                            } catch (_) { /* best-effort */ }
                        }
                        // Apply the user-dialed capture-latency correction to the
                        // bound source (no-op at 0 / for source 0).
                        if (sourceId != null) _ndApplyVerifierOffset();
                    } else if (sourceId != null) {
                        // This addon can't score per source (downlevel, or — in
                        // theory — downgraded since a prior enable bound us). Don't
                        // stay bound to a source we can't route to: best-effort free
                        // an owned source (remembering it as an orphan if that fails)
                        // and fall back to the legacy source-0 path, so
                        // `sourceId != null` always implies the routed *Source*
                        // methods exist.
                        if (!_ndOwnsSource) {
                            console.warn('[note_detect] desktop addon lacks the source-indexed '
                                + 'scoring API; ignoring opts.sourceId and using the default input');
                        } else if (!_ndTryFreeSource(sourceId)) {
                            _ndOrphanSourceIds.push(sourceId);
                        }
                        sourceId = null;
                        _ndOwnsSource = false;
                    }

                    // Record whether the engine's polyphonic ML detector
                    // (Basic Pitch) is actually active — stamped into the
                    // diagnostic export so a session is unambiguously tied to
                    // ML vs the YIN fallback. typeof-guarded for downlevel
                    // addons that predate the query.
                    bridgeMlActive = false;
                    if (typeof desktop.audio.isMlNoteDetection === 'function') {
                        try {
                            bridgeMlActive = (await desktop.audio.isMlNoteDetection()) === true;
                        } catch (_) { /* leave false */ }
                    }
                    console.log(`[note_detect] desktop bridge active — ML detection: ${bridgeMlActive ? 'ON' : 'OFF (YIN fallback)'}`);

                    // Cache the engine sample rate for any consumer
                    // that needs the bridge-side rate (the chord
                    // branch in matchNotes() doesn't — it dispatches
                    // through audio:scoreChord which reads the rate
                    // inside the engine). Reset to the 48000 default
                    // first so a transient throw or stale cached
                    // rate from a previous session can't leak in
                    // after a device-change-driven restart.
                    bridgeSampleRate = 48000;
                    if (typeof desktop.audio.getSampleRate === 'function') {
                        try {
                            const sr = await desktop.audio.getSampleRate();
                            if (Number.isFinite(sr) && sr > 0) bridgeSampleRate = sr;
                        } catch (_) { /* keep the 48000 default */ }
                    }

                    // Whether this desktop build exposes the raw polyphonic
                    // transcription API. Captured once — the addon's method
                    // set is fixed for the session.
                    const hasDetectNotes = typeof desktop.audio.detectNotes === 'function';

                    // Native-frame detection (gear opt-in): run note_detect's
                    // own detector on engine-captured PCM instead of the
                    // engine's verdicts. Requires the raw-audio-frame pull.
                    // Captured per-session like hasDetectNotes — the gate is
                    // re-evaluated on the next enable/restart, so flipping the
                    // toggle takes effect after restartAudio().
                    usingNativeFrames = nativeDetection && _ndBridgeRawFramesAvailable();
                    if (usingNativeFrames) {
                        console.log('[note_detect] native-frame detection active — local '
                            + `${detectionMethod || 'yin'} on engine audio; chords via engine scoreChord`);
                    }

                    detectInterval = setInterval(async () => {
                        // Converge the ML gate every tick — arms in modes that
                        // read ML (native-frame / non-verifier fallback), suspends
                        // under the host or contained verifier. Cheap: a Set check
                        // that only hits the bridge on an actual state change.
                        _ndUpdateMlGate();
                        if (!enabled || processingFrame) return;
                        processingFrame = true;
                        const gen = sessionGen;
                        try {
                            // A contained-playback verifier (setContainedChart)
                            // has taken over the single engine chart slot with
                            // its own chart + playhead. Host-song scoring is
                            // suspended; the consumer drives the engine from its
                            // own tick via pushContainedPlayhead — this loop
                            // must do nothing that touches the chart slot or
                            // re-pushes the host chart over the contained one.
                            // _ndHostChartSuspended covers THIS instance when it
                            // owns the slot; _ndOtherOwnsOurSlot() covers a
                            // sibling instance on the same engine source.
                            if (_ndHostChartSuspended || _ndOtherOwnsOurSlot()) return;
                            // Native-frame detection (gear opt-in): pull the
                            // engine's post-gate mono PCM and run note_detect's
                            // OWN YIN/HPS/CREPE on it via the SAME processFrame
                            // → matchNotes pipeline the browser path uses. On
                            // the bridge, matchNotes routes chords to the
                            // engine's harmonic-comb ChordScorer (scoreChord),
                            // so this is "own monophonic detector + engine
                            // chord verifier" on engine-captured audio. The
                            // engine-verifier path is suppressed in this mode
                            // (_ndPushChartToBridge bails on usingNativeFrames),
                            // so _ndUsingEngineVerifier is always false here.
                            if (usingNativeFrames) {
                                const want = _ndMinAnalysisSamples(currentArrangement, bridgeSampleRate);
                                let frame = null;
                                try { frame = await _ndBridgeRawAudioFrame(want); }
                                catch (_) { frame = null; }
                                if (!enabled || gen !== sessionGen) return;
                                // processFrame derives its sample rate from
                                // bridgeSampleRate when there's no audioCtx
                                // (the bridge case), so the engine rate flows
                                // through to YIN/HPS/FFT math unchanged.
                                //
                                // processFrame runs the selected YIN/HPS/CREPE on
                                // the engine PCM, sets detectedMidi/detectedConfidence
                                // for the live HUD/pitch-display, then calls
                                // matchNotes(buffer). matchNotes routes single-note
                                // and chord VERIFICATION through _ndBridgeScoreChord
                                // (harmonic-comb engine) because usingDesktopBridge
                                // is still true — this is intentional: the engine's
                                // spectral verifier is more reliable for hit/miss than
                                // a raw frequency estimate, and the feature goal is
                                // "chosen detector for live HUD + engine verifier for
                                // final scoring" (matching how getPitchDetection +
                                // scoreChord work on the normal bridge path). It is NOT
                                // a replacement verification backend.
                                if (frame && frame.length >= want) await processFrame(frame);
                                return;
                            }
                            // Engine-verifier path: the engine scores the
                            // pushed chart on its own background thread, so
                            // this loop just drains finalized verdicts and
                            // feeds them through the judgment pipeline. No
                            // detectNotes / matchNotes work runs here — that
                            // is exactly the per-tick load this change moves
                            // off the renderer event loop.
                            if (_ndUsingEngineVerifier) {
                                // The chart loads asynchronously after
                                // song:loaded (and can switch mid-session);
                                // re-push whenever the live chart diverges
                                // from what the engine currently holds.
                                if (_ndChartSignature() !== _ndVerifierChartSig) {
                                    await _ndPushChartToBridge();
                                    if (!enabled || gen !== sessionGen) return;
                                }
                                await _ndDrainEngineVerdicts();
                                if (!enabled || gen !== sessionGen) return;
                                // Live monophonic pitch for provisional on-strike
                                // gem feedback (see noteStateFor). The engine's
                                // final verdict only lands after a note's sustain
                                // window closes — often after the highway culls the
                                // gem — so polling the live detector here lets a
                                // struck note light immediately. One extra IPC per
                                // tick alongside the verdict drain.
                                //
                                // Use getRawPitch, NOT getPitchDetection: it reads
                                // the POST-noise-gate signal and returns midiNote
                                // -1 the moment the string stops ringing (gate
                                // closes), so the 'active' glow extinguishes when
                                // the player mutes. getPitchDetection holds the
                                // note through its decay, which kept muted sustains
                                // lit. Fall back to getPitchDetection only if the
                                // addon predates getRawPitch.
                                try {
                                    // Routes to getSourceRawPitch for a bound
                                    // source, else the legacy getRawPitch (with the
                                    // same getPitchDetection downlevel fallback).
                                    const lp = await _ndBridgeRawPitch();
                                    if (!enabled || gen !== sessionGen) return;
                                    if (lp && typeof lp.midiNote === 'number' && lp.midiNote >= 0
                                        && typeof lp.confidence === 'number'
                                        // Strict `>` to match _sustainStillHeld's
                                        // gate — a confidence landing exactly on
                                        // the threshold must not store a pitch the
                                        // hold logic would then ignore (flicker).
                                        && lp.confidence > detectionConfidenceMin) {
                                        detectedMidi = lp.midiNote;
                                        detectedConfidence = lp.confidence;
                                        // This branch returns before matchNotes(),
                                        // so log the calibration detection here or
                                        // auto-calibrate would never see a sample
                                        // under the engine verifier (dets stays 0).
                                        _avCal.logDetection();
                                    } else {
                                        detectedMidi = -1;
                                        detectedConfidence = 0;
                                    }
                                } catch (_) {
                                    // Clear on failure, don't keep-last: the sustain
                                    // glow is driven from detectedMidi, and
                                    // _sustainStillHeld refreshes its grace window
                                    // every render. Holding a stale pitch across
                                    // repeated IPC failures would keep a muted note
                                    // glowing indefinitely. Clearing still lets
                                    // NOTE_SUS_GRACE_MS bridge a one-off hiccup, then
                                    // expire if the failures persist.
                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                }
                                _diagCatalog.setDiagDetector({
                                    desktop_bridge: true,
                                    ml: bridgeMlActive,
                                    path: 'desktop-engine-verifier',
                                });
                                // The engine-verifier path returns before
                                // matchNotes(), so run the timing-free verify
                                // target here too (else notedetect:verify never
                                // fires under the engine verifier). Done LAST so
                                // the playhead-dependent drain/live-pitch above
                                // run against this frame's playhead, not a
                                // post-IPC-shifted one. Bridge path → scoreChord
                                // IPC; the null buffer is unused there.
                                if (_verifyTarget) await _runVerifyTarget(null);
                                return;
                            }
                            // Onset-event detection. detectNotes carries a
                            // per-pitch onsetSeq counter; a higher value than
                            // we last consumed means that pitch was struck
                            // anew. Consuming each onset once makes the
                            // single-note path edge-triggered (fires at the
                            // attack) instead of matching a pitch for its
                            // whole ring. The matched judgment is timestamped
                            // at the current playhead — not back-dated by the
                            // onset age, which is not a reliable per-onset
                            // duration. Chords are scored separately via the
                            // scoreChord IPC, gated on a fresh chord-pitch
                            // onset in bridgeNewOnsets.
                            let detection = null;
                            if (hasDetectNotes) {
                                try { detection = await desktop.audio.detectNotes(); }
                                catch (_) { detection = null; }
                                if (!enabled || gen !== sessionGen) return;
                            }

                            if (detection && Array.isArray(detection.notes)) {
                                bridgeNewOnsets.clear();
                                for (const n of detection.notes) {
                                    if (!n || typeof n.midi !== 'number'
                                        || typeof n.onsetSeq !== 'number') continue;
                                    const prev = bridgeOnsetSeqSeen.get(n.midi);
                                    if (prev !== undefined && n.onsetSeq <= prev) continue;
                                    bridgeOnsetSeqSeen.set(n.midi, n.onsetSeq);
                                    // The first poll only primes the seq
                                    // baseline — pre-existing onsets from
                                    // before enable must not replay as a burst.
                                    if (bridgeOnsetPrimed
                                        && typeof n.confidence === 'number'
                                        && n.confidence >= detectionConfidenceMin) {
                                        bridgeNewOnsets.set(n.midi, {
                                            ageMs: Number.isFinite(n.onsetMs) ? n.onsetMs : 0,
                                            conf: n.confidence,
                                        });
                                    }
                                }
                                bridgeOnsetPrimed = true;

                                // Single-note pick = highest-confidence active
                                // note (level-triggered). Edge-triggering the
                                // single-note path on the onset posteriorgram
                                // alone proved too sparse for fast guitar and
                                // dropped notes; the onset events above are
                                // used only to gate chord timing.
                                let best = null;
                                for (const n of detection.notes) {
                                    if (n && typeof n.midi === 'number'
                                        && (best === null || n.confidence > best.confidence)) {
                                        best = n;
                                    }
                                }
                                if (best && best.confidence >= detectionConfidenceMin) {
                                    detectedMidi = best.midi;
                                    detectedConfidence = best.confidence;
                                } else {
                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                    detectedString = -1;
                                    detectedFret = -1;
                                }
                            } else {
                                bridgeNewOnsets.clear();
                                const p = await _ndBridgePitch();
                                if (!enabled || gen !== sessionGen) return;
                                if (p && typeof p.midiNote === 'number' && p.midiNote >= 0
                                    && typeof p.confidence === 'number' && p.confidence >= detectionConfidenceMin) {
                                    detectedMidi = p.midiNote;
                                    detectedConfidence = p.confidence;
                                } else {
                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                    detectedString = -1;
                                    detectedFret = -1;
                                }
                            }
                            // Stamp the detector identity from the path that
                            // actually ran this tick (read back by the
                            // diagnostic export).
                            _diagCatalog.setDiagDetector({
                                desktop_bridge: true,
                                ml: bridgeMlActive,
                                path: bridgeMlActive ? 'desktop-ml-basicpitch' : 'desktop-yin',
                            });
                            // The chord branch in matchNotes() dispatches the
                            // audio:scoreChord IPC — no raw audio buffer is
                            // threaded here, the engine reads its own input
                            // ring. Pass null; the single-note path is gated
                            // on detectedMidi >= 0 and skips itself regardless,
                            // and checkMisses() is independent.
                            await matchNotes(null);
                        } catch (e) {
                            console.warn('[note_detect] bridge poll failed:', e && e.message ? e.message : e);
                        } finally {
                            processingFrame = false;
                        }
                    }, 50);

                    startBridgeLevelMeter(desktop);
                    _settingsPanel.populateDevices();
                    return true;
                }
                // bridge present but engine unavailable — fall through
                // to the getUserMedia path so the user sees a concrete
                // error (and can troubleshoot the engine separately)
                // rather than silent failure.
            }

            // Acquire the stream — use the supplied one or open
            // getUserMedia for our own.
            if (externalStream) {
                stream = externalStream;
            } else {
                const constraints = {
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                        channelCount: 2,
                    }
                };
                if (selectedDeviceId) {
                    constraints.audio.deviceId = { exact: selectedDeviceId };
                }

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    const isHttp = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
                    const msg = isHttp
                        ? 'Microphone access requires HTTPS. You are accessing Slopsmith over HTTP from a non-localhost address. Either:\n\n1. Use a reverse proxy with HTTPS (recommended)\n2. Access via localhost\n3. Add a self-signed certificate to the server'
                        : 'Microphone access is not available in this browser. Use Chrome or Edge.';
                    throw new Error(msg);
                }
                // On the silent first auto-enable attempt, don't let a
                // transiently-unmatched (still-enumerating) saved device be
                // forgotten — the delayed retry re-tries the real device.
                stream = await openInstrumentStream(constraints, {
                    allowDeviceFallback: !autoEnableTrial,
                });
            }

            // Acquire the context independently — a caller can supply
            // just one of {stream, context} and we create the other.
            // `latencyHint: 'interactive'` asks the browser for the
            // lowest-latency input/output config the platform supports —
            // Chromium otherwise picks platform-defaults that can add
            // 10-30 ms of buffer for no reason. Real-time pitch-detect
            // is exactly the case the hint exists for. Falls back
            // gracefully if a host hands us an externalAudioCtx that's
            // already constructed.
            audioCtx = externalAudioCtx || new (window.AudioContext || window.webkitAudioContext)({
                latencyHint: 'interactive',
            });

            sourceNode = audioCtx.createMediaStreamSource(stream);
            const streamChannels = sourceNode.channelCount;
            // Watch this stream's track for a mid-session interface drop.
            try { _bindStreamHealth(stream); } catch (_) {}

            gainNode = audioCtx.createGain();
            gainNode.gain.value = inputGain;

            if (streamChannels >= 2 && selectedChannel !== 'mono') {
                splitterNode = audioCtx.createChannelSplitter(2);
                sourceNode.connect(splitterNode);
                mergerNode = audioCtx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                splitterNode.connect(mergerNode, chIdx, 0);
                mergerNode.connect(gainNode);
            } else {
                sourceNode.connect(gainNode);
            }

            levelAnalyser = audioCtx.createAnalyser();
            levelAnalyser.fftSize = 512;
            levelAnalyser.smoothingTimeConstant = 0.8;
            gainNode.connect(levelAnalyser);

            const processor = audioCtx.createScriptProcessor(frameSize, 1, 1);
            worklet = processor;
            accumBuffer = new Float32Array(0);
            pendingBuffer = null;

            processor.onaudioprocess = (e) => {
                // Heartbeat: stamp every callback (even when disabled) so the
                // scoring watchdog can tell a stalled audio graph from a quiet
                // instrument. Also track the worst inter-callback gap — the
                // direct measure of main-thread starvation. Cheap; runs ~20×/s.
                const _cbNow = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
                if (_lastAudioCbT) {
                    const gap = _cbNow - _lastAudioCbT;
                    if (gap > _maxCbGapMs) _maxCbGapMs = gap;
                }
                _lastAudioCbT = _cbNow;
                if (!enabled) return;
                const input = e.inputBuffer.getChannelData(0);
                const prev = accumBuffer;
                const combined = new Float32Array(prev.length + input.length);
                combined.set(prev);
                combined.set(input, prev.length);
                // Bass needs a longer window to resolve its low fundamental;
                // size the analysis frame from the arrangement + device rate.
                const minSamples = _ndMinAnalysisSamples(currentArrangement, audioCtx.sampleRate);
                if (combined.length >= minSamples) {
                    const start = combined.length - minSamples;
                    pendingBuffer = combined.slice(start, start + minSamples);
                    accumBuffer = new Float32Array(0);
                } else {
                    accumBuffer = combined;
                }
            };

            // Detection runs on a timer, not in the audio callback. The
            // in-flight guard matters when CREPE inference takes longer
            // than the 50 ms tick — without it, multiple processFrame
            // promises can be alive at once and resolve out of order,
            // letting a stale detection overwrite a newer one.
            detectInterval = setInterval(() => {
                if (processingFrame || !pendingBuffer) return;
                const buf = pendingBuffer;
                pendingBuffer = null;
                processingFrame = true;
                processFrame(buf).finally(() => { processingFrame = false; });
            }, 50);

            gainNode.connect(processor);
            processor.connect(audioCtx.destination);

            startLevelMeter();
            _settingsPanel.populateDevices();

            return true;
        } catch (e) {
            console.error('Note detect: mic access denied or failed:', e);
            // Suppress the user-facing alert if the instance is no
            // longer enabled — the enable/restart was superseded by a
            // concurrent disable (e.g. song switch while the mic
            // permission prompt was open). Surfacing an error the
            // user never asked to see in that case is just noise.
            // The console.error still goes to devtools for
            // diagnostics. autoEnableTrial silences the automatic
            // first auto-enable attempt (a transient not-ready USB device
            // shouldn't pop a dialog on load — the retry surfaces it).
            if (enabled && !autoEnableTrial) {
                alert('Note Detection: Could not access audio input.\n\n' + e.message);
            }
            // Partial-init cleanup — if we got as far as acquiring the
            // stream or creating any AudioNodes before the throw, we
            // own the teardown. stopAudio is null-safe for every
            // resource and respects ownsStream / ownsAudioCtx, so it
            // handles partial state regardless of where we failed.
            stopAudio();
            return false;
        }
    }

    // Watch the live input MediaStreamTrack for the interface dropping out
    // mid-session (USB/driver glitch, audio focus loss). `ended`/`mute` mark the
    // input lost + surface it (not left guessing why nothing scored) and, after
    // a short grace for the device to self-heal, re-acquire ONCE — throttled so
    // a flapping device can't thrash getUserMedia. `unmute` clears it.
    // Detach the ended/mute/unmute listeners bound by a previous
    // _bindStreamHealth. On the shared externalStream path the same track
    // survives restart cycles, so without this each startAudio() would stack
    // another set of closures on it and fire markLost() N times per drop.
    function _unbindStreamHealth() {
        if (!_healthHandlers) return;
        const { track, ended, mute, unmute } = _healthHandlers;
        try {
            track.removeEventListener('ended', ended);
            track.removeEventListener('mute', mute);
            track.removeEventListener('unmute', unmute);
        } catch (_) { /* track event API unavailable */ }
        _healthHandlers = null;
    }

    function _bindStreamHealth(s) {
        if (!s || typeof s.getAudioTracks !== 'function') return;
        const track = s.getAudioTracks()[0];
        if (!track) return;
        // Drop any prior binding first so restart cycles don't accumulate
        // duplicate listeners on a reused track.
        _unbindStreamHealth();
        _healthTrack = track;   // captured for the dropout-telemetry record
        const markLost = (why) => {
            if (_inputLost || !enabled) return;
            _inputLost = true;
            console.warn(`[note_detect] input ${why} — the audio interface dropped the input stream`);
            try { updateButton(); } catch (_) {}
            setTimeout(() => {
                if (!enabled || !_inputLost) return;
                const now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
                if (now - _lastInputRecover < 4000) return;
                _lastInputRecover = now;
                console.warn('[note_detect] re-acquiring input after drop');
                try { restartAudio(); } catch (_) {}
            }, 1500);
        };
        const onEnded = () => markLost('ended');
        const onMute = () => markLost('muted');
        const onUnmute = () => {
            if (!_inputLost) return;
            _inputLost = false;
            try { updateButton(); } catch (_) {}
        };
        try {
            track.addEventListener('ended', onEnded);
            track.addEventListener('mute', onMute);
            track.addEventListener('unmute', onUnmute);
            _healthHandlers = { track, ended: onEnded, mute: onMute, unmute: onUnmute };
        } catch (_) { /* track event API unavailable */ }
    }

    // Scoring watchdog. Bound ONCE at construction (default singleton), NOT
    // inside startAudio: the worst failure (a getUserMedia race that makes
    // startAudio return false and silently turns Detect off) happens precisely
    // when startAudio never succeeds, so a watchdog created there would never
    // run for it. Instead this keys on intent: the user wants detection AND the
    // song is playing, but nothing is scoring — covering BOTH a never-started
    // detector and a mid-play input drop, recovering each the right way.
    function _bindScoringWatchdog() {
        if (!isDefault || scoringWatchdog) return;
        scoringWatchdog = setInterval(_scoringWatchdogTick, 1000);
        // Don't pin the Node event loop open in tests (no-op in the browser).
        if (scoringWatchdog && typeof scoringWatchdog.unref === 'function') scoringWatchdog.unref();
    }

    function _scoringWatchdogTick() {
        const now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
        // In split mode the default singleton is suppressed — a panel owns
        // capture. Without this guard the watchdog would call enable() on the
        // suppressed default and bring the main HUD/mic back on top of P1.
        // Mirrors the check in _reArmOnSongLoaded() and construct-time auto-enable.
        if (typeof window !== 'undefined' && window.__ndSuppressDefault) {
            _wdPlayStartT = 0; _clearScoringStall(); return;
        }
        const playing = !!(window.slopsmith && window.slopsmith.isPlaying);
        // Only meaningful while playing AND the user wants detection on.
        if (!playing || !detectPreference) { _wdPlayStartT = 0; _clearScoringStall(); return; }
        if (!_wdPlayStartT) { _wdPlayStartT = now; _maxCbGapMs = 0; }  // fresh play: reset starvation gauge
        // Grace: let enable()/startAudio come up after Play before judging.
        if (now - _wdPlayStartT < 2500) return;
        // Healthy = detection enabled AND the audio callback fired recently. The
        // bridge path doesn't use onaudioprocess, so treat enabled-on-bridge as
        // healthy — its own input handling owns that case.
        const cbFresh = (now - _lastAudioCbT) < 1800;
        if (_ndScoringHealthy(enabled, usingDesktopBridge, _extActive, cbFresh)) { _clearScoringStall(); return; }
        // Keys/piano arrangements are scored by an external MIDI provider, never
        // the mic. A keys song idle-waiting for its provider to bind is legitimately
        // enabled=false (enableImpl bails without opening the mic) — not a dropped
        // input. The _extWatchOpen watcher owns (re)binding, so never banner or
        // re-open the mic here regardless of enabled/_extActive state.
        if (_ndIsExternalScoredArrangement()) { _clearScoringStall(); return; }
        // Wants detection, song playing, but not scoring. Surface loudly NOW
        // (seconds in, not at song end) and auto-recover the right way:
        // re-enable if Detect fell off, or re-acquire the input if it's
        // enabled-but-dead. Throttled.
        if (!_scoringStalled) {
            _scoringStalled = true;
            _inputLost = true;
            console.warn(`[note_detect] scoring watchdog: playing + detect wanted, but not scoring (enabled=${enabled}, cbAgeMs=${now - _lastAudioCbT}) — recovering`);
            try { updateButton(); } catch (_) {}
            try { _showScoringStallBanner(); } catch (_) {}
            try { _logInputDropout(now - _lastAudioCbT); } catch (_) {}
        }
        if (now - _lastInputRecover >= 4000) {
            _lastInputRecover = now;
            if (!enabled) {
                console.warn('[note_detect] scoring watchdog: re-enabling detection');
                try { Promise.resolve(enable()).catch(() => {}); } catch (_) {}
            } else {
                console.warn('[note_detect] scoring watchdog: re-acquiring input');
                try { restartAudio(); } catch (_) {}
            }
        }
    }

    function _clearScoringStall() {
        if (!_scoringStalled) return;
        _scoringStalled = false;
        _inputLost = false;
        try { updateButton(); } catch (_) {}
        try { _hideScoringStallBanner(); } catch (_) {}
    }

    // A loud banner the moment scoring goes dead mid-play — caught in seconds,
    // not at the end-of-song summary. Self-heals (auto-reconnect above); a
    // manual button is offered in case the device needs a kick.
    function _showScoringStallBanner() {
        let banner = instanceRoot.querySelector('.nd-scoring-stall');
        if (!banner) {
            banner = document.createElement('div');
            banner.className = 'nd-scoring-stall fixed top-3 left-1/2 -translate-x-1/2 z-[300] flex items-center gap-3 bg-red-900/95 border-2 border-red-500 rounded-xl px-4 py-2.5 shadow-2xl text-sm';
            banner.innerHTML = '<span class="text-red-100 font-semibold">⚠ Detect is ON but not hearing your instrument — input dropped. Reconnecting…</span>'
                + '<button class="nd-scoring-stall-retry px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-xs text-white">Reconnect now</button>';
            instanceRoot.appendChild(banner);
            const retry = banner.querySelector('.nd-scoring-stall-retry');
            if (retry) retry.onclick = () => { try { restartAudio(); } catch (_) {} };
        }
        banner.style.display = '';
    }

    function _hideScoringStallBanner() {
        const banner = instanceRoot.querySelector('.nd-scoring-stall');
        if (banner) banner.remove();
    }

    // Dropout telemetry — captures the discriminating state at the moment
    // scoring went dead so a single occurrence settles rig-vs-program without a
    // replay (audio_ctx_state parked = OS/rig; track ended/muted = device
    // dropped; live + running + high heap = main-thread starvation). Streamed to
    // the live JSONL (correlates with the session) + console.
    function _logInputDropout(sinceCbMs) {
        let heapMb = null;
        try {
            if (typeof performance !== 'undefined' && performance.memory) {
                heapMb = Math.round(performance.memory.usedJSHeapSize / 1048576);
            }
        } catch (_) {}
        const rec = {
            type: 'input_dropout',
            schema: 'note_detect.live.input_dropout.v1',
            ts: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            since_last_cb_ms: sinceCbMs,
            enabled,
            audio_ctx_state: (audioCtx && audioCtx.state) || null,
            sample_rate: (audioCtx && audioCtx.sampleRate) || null,
            frame_size: frameSize,
            processing_frame: processingFrame,
            max_cb_gap_ms: _maxCbGapMs,
            rec_armed: _recCapture.isArmedOrTraining(),
            using_bridge: usingDesktopBridge,
            arrangement: currentArrangement || null,
            track_ready: (_healthTrack && _healthTrack.readyState) || null,
            track_muted: _healthTrack ? !!_healthTrack.muted : null,
            track_enabled: _healthTrack ? !!_healthTrack.enabled : null,
            heap_mb: heapMb,
        };
        try { console.warn('[note_detect] input_dropout', JSON.stringify(rec)); } catch (_) {}
        try { if (_diagCatalog.getLiveSessionId()) _diagCatalog.streamLiveJudgment(rec); } catch (_) {}
    }

    function stopAudio() {
        // Drop this instance's ML-gate claim while the bridge is still
        // resolvable (bridgeDesktop is cleared below) so the engine ML pipeline
        // suspends once no other detector instance still needs it. Explicit
        // false rather than _ndUpdateMlGate() — usingDesktopBridge is still true
        // here, so the predicate could otherwise miscompute a stale arm.
        _ndSyncMlGate(_ndGateToken, false, _ndBridgeAudio());
        _inputLost = false;
        _unbindStreamHealth();
        _healthTrack = null;
        stopLevelMeter();
        stopBridgeLevelMeter();
        if (detectInterval) { clearInterval(detectInterval); detectInterval = null; }
        pendingBuffer = null;
        // Bridge path doesn't own the JUCE engine — leave audio
        // running for the Audio Plugins panel / other features. Drop
        // the cached preload reference and the flag so a subsequent
        // enable re-resolves window.feedBackDesktop fresh.
        usingDesktopBridge = false;
        usingNativeFrames = false;
        bridgeDesktop = null;
        // Drop the engine-verifier state — a subsequent enable re-pushes a
        // fresh chart via _ndPushChartToBridge(). Any chart still held by the
        // engine is harmless: nothing drains its verdicts once the flag is off.
        _ndUsingEngineVerifier = false;
        _ndVerifierChartById = new Map();
        _ndVerifierChords = new Map();
        _ndVerifierChordKeyOf = new Map();
        _ndPendingChords = new Map();
        _ndLastPushedPlayhead = 0;
        bridgeMlActive = false;
        bridgeOnsetSeqSeen = new Map();
        bridgeNewOnsets = new Map();
        bridgeOnsetPrimed = false;
        // Disconnect the full node chain in reverse-connect order.
        // Critical in borrower mode (external audioCtx): we leave the
        // caller's context open, and any node we don't disconnect
        // stays live in its graph across enable/disable cycles.
        if (worklet) {
            worklet.onaudioprocess = null;
            try { worklet.disconnect(); } catch (e) { /* already disconnected */ }
            worklet = null;
        }
        if (levelAnalyser) {
            try { levelAnalyser.disconnect(); } catch (e) {}
            levelAnalyser = null;
        }
        if (gainNode) {
            try { gainNode.disconnect(); } catch (e) {}
            gainNode = null;
        }
        if (mergerNode) {
            try { mergerNode.disconnect(); } catch (e) {}
            mergerNode = null;
        }
        if (splitterNode) {
            try { splitterNode.disconnect(); } catch (e) {}
            splitterNode = null;
        }
        if (sourceNode) {
            try { sourceNode.disconnect(); } catch (e) {}
            sourceNode = null;
        }
        // Tear down each resource only if we own it. Ownership is
        // tracked per-resource (see ownsStream / ownsAudioCtx at the
        // top of the factory) so a caller can pass just a stream or
        // just a context without leaking the other.
        if (stream && ownsStream) {
            stream.getTracks().forEach(t => t.stop());
        }
        stream = null;
        if (audioCtx && ownsAudioCtx) {
            try { audioCtx.close(); } catch (e) { /* may already be closed */ }
        }
        audioCtx = null;
        inputLevel = 0;
        inputPeak = 0;
        accumBuffer = new Float32Array(0);
    }

    // Per-instance promise chain that serializes ALL audio-lifecycle
    // operations that await startAudio — both restartAudio and the
    // startAudio call from enable. A generation-only check isn't
    // enough on its own because startAudio() writes to shared
    // instance vars (stream, audioCtx, sourceNode, gainNode, ...)
    // BEFORE the post-await gen check fires. If two operations
    // overlap on getUserMedia, the second's resolved write clobbers
    // the first's refs, and the first's gen-check stopAudio then
    // disconnects the SECOND one's graph. Chaining start/stop onto a
    // single promise prevents overlap entirely.
    let audioOpChain = Promise.resolve();
    function queueAudioOp(fn) {
        const queued = audioOpChain.then(fn);
        // .catch on the chain itself so one rejected op doesn't
        // poison every subsequent call. The caller still sees the
        // unswallowed promise.
        audioOpChain = queued.catch(() => {});
        return queued;
    }

    function restartAudio() {
        return queueAudioOp(async () => {
            sessionGen++;
            const gen = sessionGen;
            stopAudio();
            if (!enabled) return;
            const ok = await startAudio();
            // Treat a restart failure (e.g. mic permission revoked,
            // device unplugged, selected deviceId no longer exists)
            // as a hard disable. Without this, the instance would
            // stay `enabled=true` with HUD + miss-check intervals
            // still running, racking up misses against no audio and
            // showing the Detect button as active. Only fire the
            // disable if we're still the winning operation —
            // otherwise a newer restart or a concurrent disable
            // already owns the teardown.
            if (!ok) {
                if (gen === sessionGen && enabled) {
                    disable({ silent: true });
                }
                return;
            }
            // Even within the chain, disable() can still bump
            // sessionGen and set !enabled between our stop/start
            // and our return. Tear down what startAudio just
            // acquired in that case.
            if (gen !== sessionGen || !enabled) {
                stopAudio();
            }
        });
    }

    // ── Level meter ───────────────────────────────────────────────────

    // Desktop-bridge equivalent of startLevelMeter(). The engine already
    // computes RMS + peak on the audio thread; here we just poll those
    // and drive the same DOM bar the Web-Audio path drives. Polled on
    // setInterval rather than rAF so the IPC round-trip doesn't pin
    // requestAnimationFrame to the IPC cadence when the renderer
    // throttles in the background.
    function startBridgeLevelMeter(desktop) {
        stopBridgeLevelMeter();
        // Bail before installing the timer if the engine doesn't expose
        // getLevels — otherwise we'd run a no-op poll forever, leak the
        // interval, and never surface the missing capability.
        if (!desktop || !desktop.audio) {
            // Bridge/audio not ready yet — a timing state, NOT a capability
            // verdict. Don't latch unavailable here, or a pre-init call would
            // wrongly force fixed full glow; leave the latch for a confirmed
            // missing getLevels below.
            return;
        }
        if (typeof desktop.audio.getLevels !== 'function') {
            bridgeLevelsUnavailable = true;
            return;
        }
        bridgeLevelsUnavailable = false;
        // In-flight guard — if an IPC `getLevels()` round-trip takes
        // longer than the 50 ms timer, queueing further calls would
        // build up a backlog and process stale readings out-of-order.
        // Same pattern as the pitch poll's `processingFrame` guard.
        let levelsInFlight = false;
        bridgeLevelTimer = setInterval(async () => {
            if (!enabled || !usingDesktopBridge || levelsInFlight) return;
            levelsInFlight = true;
            try {
                // A BOUND source (multi-input panel) must gate on ITS OWN device's
                // level — not the global/primary level. Otherwise the silence gate
                // (which can force a detected note to a miss when its level window
                // looks silent) reads the primary device, which is silent while the
                // user plays a DIFFERENT bound interface, and force-fails every hit.
                let levels;
                if (sourceId != null && sourceId !== 0) {
                    // A NON-DEFAULT (owned / extra-device) source must gate on ITS OWN
                    // meter. If the addon is too old to expose getSourceLevels, do NOT
                    // fall back to the global getLevels() — that reads the primary
                    // device, which is silent while the user plays this interface, so
                    // the silence gate would force EVERY note on it to a miss. Skip the
                    // poll instead (the gate then has no data and never force-fails).
                    if (typeof desktop.audio.getSourceLevels !== 'function') {
                        // Older addon: can't read THIS source's level. Latch
                        // unavailable so the sustain-glow fixed-fallback engages (and
                        // we don't gate on the wrong meter). DROP any level history from
                        // a prior metered session so the silence gate sees "no data"
                        // rather than force-failing on the previous source's levels.
                        bridgeLevelsUnavailable = true;
                        _ndLevelSamples.length = 0;
                        return;
                    }
                    levels = await desktop.audio.getSourceLevels(sourceId);
                } else {
                    levels = await desktop.audio.getLevels();
                }
                // Re-check after the await: disable()/destroy() can fire
                // between the IPC round-trip and the resolve, and the
                // bridge timer doesn't track sessionGen the way the
                // pitch poller does. Without this we'd race-write
                // inputLevel/inputPeak and touch the DOM on a torn-down
                // instance.
                if (!enabled || !usingDesktopBridge) return;
                if (!levels) return;
                // Engine reports peaks in 0..1 already; the Web-Audio
                // branch scales RMS by 5 for headroom. Use the engine's
                // value directly — overdriving the bar is a worse UX
                // than a slightly conservative reading.
                // Nullish-coalesce so a legitimate `0` reading (silence)
                // isn't replaced by the fallback — `0 || x` falls through to
                // x, which would inflate the bar during quiet moments.
                const rawLevel = Number.isFinite(levels.inputLevel) ? levels.inputLevel : 0;
                inputLevel = Math.min(1, Math.max(0, rawLevel));
                // Record (songT, level) for the silence gate in the engine
                // verdict drain. The buffer assumes songT advances
                // monotonically; on a backward jump (seek, drill loop
                // restart) we'd otherwise keep stale post-jump high-time
                // samples that the shift()-prune never removes, mixing two
                // timelines into the same window and forcing false misses.
                // Clear the buffer on any backward jump.
                if (hw && typeof hw.getTime === 'function') {
                    const avO = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
                    const songT = hw.getTime() + avO;
                    const last = _ndLevelSamples.length
                        ? _ndLevelSamples[_ndLevelSamples.length - 1].songT
                        : -Infinity;
                    if (songT < last - 0.05) {
                        // Time went backward (seek / drill wrap). Reset.
                        _ndLevelSamples.length = 0;
                    }
                    _ndLevelSamples.push({ songT, level: inputLevel });
                    const cutoff = songT - _ND_LEVEL_HISTORY_S;
                    while (_ndLevelSamples.length > 0 && _ndLevelSamples[0].songT < cutoff) {
                        _ndLevelSamples.shift();
                    }
                    // Pause-safe cap: songT-only pruning relies on songT
                    // advancing, but if playback is paused (or stuck in a
                    // menu) while this 50 ms timer keeps firing, every new
                    // sample has the same songT and the time-based prune
                    // never fires. Enforce a hard sample-count cap as a
                    // safety net so the buffer can't grow unbounded across
                    // a paused session. 6 s of 50 ms polls → 120 samples,
                    // so 240 (2× headroom) is plenty for active playback
                    // and still bounded during pauses.
                    while (_ndLevelSamples.length > 240) {
                        _ndLevelSamples.shift();
                    }
                }
                const rawPeak = Number.isFinite(levels.inputPeak) ? levels.inputPeak : inputLevel;
                const peak = Math.min(1, Math.max(0, rawPeak));
                if (peak > inputPeak) {
                    inputPeak = peak;
                    peakDecay = 30;
                } else if (peakDecay > 0) {
                    peakDecay--;
                } else {
                    inputPeak *= 0.95;
                }
                _settingsPanel.drawSettingsVU();
            } catch (_) { /* one bad poll shouldn't stop the meter */ }
            finally { levelsInFlight = false; }
        }, 50);
    }

    function stopBridgeLevelMeter() {
        if (bridgeLevelTimer) {
            clearInterval(bridgeLevelTimer);
            bridgeLevelTimer = null;
        }
    }

    function startLevelMeter() {
        stopLevelMeter();
        // Cache the analyser read buffer across rAF ticks. At 60 fps
        // with fftSize=512 this was allocating ~120 kB/s per enabled
        // instance; reusing a single Float32Array (re-allocating only
        // if fftSize changes) keeps the meter out of the GC path.
        let levelBuf = null;
        let levelBufSize = 0;
        const tick = () => {
            if (!levelAnalyser) return;
            const fftSize = levelAnalyser.fftSize;
            if (!levelBuf || levelBufSize !== fftSize) {
                levelBuf = new Float32Array(fftSize);
                levelBufSize = fftSize;
            }
            levelAnalyser.getFloatTimeDomainData(levelBuf);
            let sum = 0;
            for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
            const rms = Math.sqrt(sum / levelBuf.length);
            inputLevel = Math.min(1, rms * 5);
            if (inputLevel > inputPeak) {
                inputPeak = inputLevel;
                peakDecay = 30;
            } else if (peakDecay > 0) {
                peakDecay--;
            } else {
                inputPeak *= 0.95;
            }
            _settingsPanel.drawSettingsVU();
            levelRaf = requestAnimationFrame(tick);
        };
        levelRaf = requestAnimationFrame(tick);
    }

    function stopLevelMeter() {
        if (levelRaf) {
            cancelAnimationFrame(levelRaf);
            levelRaf = null;
        }
    }

    // nd-carve-5 cut 4: _vuSetPanel and drawSettingsVU moved to settings-panel.js.
    // Call via _settingsPanel.vuSetPanel(null) and _settingsPanel.drawSettingsVU().

    // ── Frame processing ──────────────────────────────────────────────
    async function processFrame(buffer) {
        // Append to the rolling raw-audio buffer for the bass miss rescue
        // (checkMisses). Bass only — guitar's higher fundamentals resolve in
        // the short window, so it doesn't need (or pay for) this.
        if (currentArrangement === 'bass' && buffer && buffer.length) {
            const keep = Math.min(_RESCUE_BUF_MAX, _rescueBuf.length + buffer.length);
            const nb = new Float32Array(keep);
            const fromBuf = Math.min(buffer.length, keep);
            nb.set(buffer.subarray(buffer.length - fromBuf), keep - fromBuf);
            const remain = keep - fromBuf;
            if (remain > 0) nb.set(_rescueBuf.subarray(_rescueBuf.length - remain), 0);
            _rescueBuf = nb;
            if (hw && hw.getTime) _rescueBufEndT = hw.getTime();
        }
        // Record the per-frame input level into the level-history time series so
        // the silence gate ("was the player silent here") works on the BROWSER
        // path too (it was desktop-only — fed from the engine's level callback).
        // Without this, a stretch where the player stopped playing is
        // indistinguishable from a low-bass detection gap downstream. Same rms*5
        // scaling + 0.02 threshold the desktop path uses; skip on the bridge
        // path (its level callback already records). Pruning / backward-jump
        // reset mirror the desktop block.
        if (!usingDesktopBridge && buffer && buffer.length && hw && typeof hw.getTime === 'function') {
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
            const lvl = Math.min(1, Math.max(0, Math.sqrt(sum / buffer.length) * 5));
            const avO = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
            const songT = hw.getTime() + avO;
            const last = _ndLevelSamples.length ? _ndLevelSamples[_ndLevelSamples.length - 1].songT : -Infinity;
            if (songT < last - 0.05) _ndLevelSamples.length = 0;   // seek / drill-wrap → reset
            _ndLevelSamples.push({ songT, level: lvl });
            const cutoff = songT - _ND_LEVEL_HISTORY_S;
            while (_ndLevelSamples.length > 0 && _ndLevelSamples[0].songT < cutoff) _ndLevelSamples.shift();
            while (_ndLevelSamples.length > 240) _ndLevelSamples.shift();
        }
        let result;
        let detectorUsed;
        // Capture the session generation at frame start. disable()
        // increments sessionGen, so any frame that was already running
        // past an `await` sees a changed generation and bails rather
        // than apply stale hits / fire stale events. Without this
        // guard a CREPE inference in flight during song switch would
        // score against the old session's chart.
        const gen = sessionGen;
        // On the desktop bridge there is no audioCtx; use the engine
        // sample rate cached at startAudio() time instead. Browser
        // path keeps reading audioCtx.sampleRate.
        const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
        const activeMethod = _ndEffectiveDetectionMethod();
        switch (activeMethod) {
            case 'crepe':
                if (_ndShared.model) {
                    result = await _ndCrepeDetect(buffer);
                    detectorUsed = 'crepe';
                    if (result.freq <= 0 || result.confidence < detectionConfidenceMin) {
                        result = _ndYinDetect(buffer, sr);
                        detectorUsed = 'yin';
                    }
                    break;
                }
                result = _ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
                break;
            case 'hps':
                result = _ndHpsDetect(buffer, sr);
                detectorUsed = 'hps';
                break;
            case 'yin':
            default:
                result = _ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
        }

        // If the instance was disabled (or re-enabled into a new
        // session) while CREPE was awaiting, drop this result on the
        // floor — don't touch detection state or fire events.
        if (!enabled || gen !== sessionGen) return;

        if (result.freq <= 0 || result.confidence < detectionConfidenceMin) {
            if (result.underBuffered && !underBufferWarned) {
                console.warn(`[note_detect] ${detectorUsed} received an undersized buffer — low-frequency (bass) notes will drop silently. Check the frame accumulation path.`);
                underBufferWarned = true;
            }
            detectedMidi = -1;
            detectedConfidence = 0;
            detectedString = -1;
            detectedFret = -1;
            detectedDisplayMidi = -1;
            // Fall through to matchNotes — the chord path doesn't need a
            // single confident pitch (it scores per-string energy bands),
            // and chord audio is the case where YIN/HPS most often
            // returns low confidence. Single-note matching inside
            // matchNotes() is gated on detectedMidi >= 0, so it skips
            // itself; only chord groups get evaluated here.
        } else {
            detectedMidi = _ndFreqToMidi(result.freq);
            detectedConfidence = result.confidence;
        }

        // Stamp the detector identity for the diagnostic. Use `detectorUsed`
        // (the detector that actually ran this frame), so an auto-HPS bass
        // frame reports as hps AND a crepe→yin low-confidence/missing-model
        // fallback reports the real yin, not the requested crepe. The same
        // JS-DSP detector runs for both the browser path and the desktop
        // native-frame mode; only the audio SOURCE differs, so distinguish
        // them in the path tag (and flag desktop_bridge in native-frame mode).
        _diagCatalog.setDiagDetector(usingNativeFrames
            ? { desktop_bridge: true, ml: false, path: 'desktop-native-' + (detectorUsed || activeMethod) }
            : { desktop_bridge: false, ml: false, path: 'web-' + (detectorUsed || activeMethod) });

        // Pass the current frame's buffer through to matchNotes so the
        // chord scorer can run on the same audio that was just analysed
        // for pitch. The shared `pendingBuffer` is cleared by the timer
        // (see detectInterval) before processFrame is called, so reading
        // it later from matchNotes would either skip (null) or pick up a
        // newer buffer captured mid-processing.
        await matchNotes(buffer);

        // Reference-recording capture: tap the same audio the detector
        // just analysed. Cap, song-playing gate, and chunk accounting all
        // live in _recCapture.pushFrame() (nd-carve-7 cut 7).
        if (_recCapture.isArmed()) {
            _recCapture.pushFrame(buffer, audioCtx ? audioCtx.sampleRate : (bridgeSampleRate || 44100));
        }
    }

    // ── Note matching ─────────────────────────────────────────────────
    function noteKey(note, time) {
        return `${time.toFixed(3)}_${note.s}_${note.f}`;
    }

    // ── Renderer note-state provider (slopsmith#254) ──────────────────
    // How long (s) a missed note's gem stays red-washed on the highway.
    // Short on purpose — the slide-down miss marker (drawOverlay) carries
    // the longer-lived feedback; the gem wash is just an instant cue.
    const NOTE_MISS_GEM_TTL = 0.6;
    // Grace (ms) after an on-pitch detection during which a sustained
    // note still counts as actively held — smooths render-vs-pitch frame
    // rate mismatch (see _susActiveUntil).
    const NOTE_SUS_GRACE_MS = 250;

    // Provisional on-strike feedback (slopsmith#254 follow-up). On the desktop
    // engine-verifier path the authoritative verdict for a note only lands after
    // its sustain window elapses (~sus + 0.1 s), which is usually AFTER the
    // highway has culled the gem — so a struck *sustained* note would otherwise
    // never light. While a note has no verdict yet, if it's at/near the strike
    // line and the live monophonic detector currently hears its pitch, glow it
    // now; the engine verdict reconciles HUD totals later. Lead/tail tolerances
    // bracket the note's [chartTime, chartTime+sus] window in the visual clock.
    const NOTE_LIVE_LEAD = 0.12;
    const NOTE_LIVE_TAIL = 0.12;

    // Sustain glow brightness follows the live input level: a held note lights
    // only while the string is ringing above NOTE_GLOW_LEVEL_THRESHOLD, and its
    // alpha scales with level up to NOTE_GLOW_REF_LEVEL (full glow). Below the
    // threshold the string is treated as silenced and the gem stops glowing, so
    // the glow fades naturally as the note decays and drops when muted. All
    // three are tunable to taste.
    const NOTE_GLOW_LEVEL_THRESHOLD = 0.015; // input level (0..1) = "still ringing" (just above the ~0.008 noise floor)
    const NOTE_GLOW_REF_LEVEL       = 0.25; // level mapped to full glow
    const NOTE_GLOW_MIN_ALPHA       = 0.30; // floor so a quiet-but-ringing note stays visible

    // Live-level → sustain-glow alpha. Returns 0 when the string isn't ringing
    // above the threshold (the caller then leaves the gem un-lit).
    function _ndSustainGlowAlpha() {
        // Fixed-glow fallback for bridge builds whose engine lacks getLevels:
        // startBridgeLevelMeter() bails (latching bridgeLevelsUnavailable), so
        // inputLevel never moves off 0 and a level-gated glow would never light
        // at all. Preserve the pre-level-metering behaviour (full glow) so
        // sustained notes still show as active on those builds. Keyed on the
        // capability latch — not `!bridgeLevelTimer`, which is also true during
        // startup/teardown and would wrongly force full glow then.
        if (usingDesktopBridge && bridgeLevelsUnavailable) return 1;
        if (!(inputLevel > NOTE_GLOW_LEVEL_THRESHOLD)) return 0;
        const span = NOTE_GLOW_REF_LEVEL - NOTE_GLOW_LEVEL_THRESHOLD;
        const a = span > 0 ? (inputLevel - NOTE_GLOW_LEVEL_THRESHOLD) / span : 1;
        return Math.max(NOTE_GLOW_MIN_ALPHA, Math.min(1, a));
    }

    // Registered via highway.setNoteStateProvider(). The active renderer
    // calls this per visible chart note / chord-note. Returns null (render
    // normally), or { state, alpha } where state ∈ {'active','hit','miss'}:
    //   'active' — sustained note still ringing AND currently on-pitch (full glow)
    //   'hit'    — recently struck cleanly (glow fading over hitGlowDuration)
    //   'miss'   — recently judged a miss (brief red wash)
    // `note` is the chart note object; for chord notes `chartTime` is the
    // chord's time (matches how noteResults keys chord notes). Must stay
    // cheap: called per note per renderer per frame.
    function noteStateFor(note, chartTime) {
        if (!enabled || !note || !Number.isFinite(chartTime)) return null;
        const key = noteKey(note, chartTime);
        const j = noteResults.get(key);
        if (!j) {
            // No verdict yet — provisional live glow so a struck note (esp. a
            // long sustain whose engine verdict lands after the gem is culled)
            // lights immediately. Only while the note straddles the strike line
            // AND the live detector hears its pitch (see NOTE_LIVE_LEAD above).
            const songTLive = ((hw && hw.getTime) ? hw.getTime() : 0)
                + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);
            const susLive = +note.sus || 0;
            if (songTLive >= chartTime - NOTE_LIVE_LEAD
                && songTLive <= chartTime + susLive + NOTE_LIVE_TAIL
                && _sustainStillHeld(key, note)) {
                const a = _ndSustainGlowAlpha();
                if (a > 0) return { state: 'active', alpha: a, live: true };
            }
            return null;  // not judged / not ringing above threshold — render normally
        }

        // Renderer clock for the visual age / TTL math — `getTime() +
        // avOffset` is the same basis `drawOverlay()` uses for its slide-
        // down miss markers and matches when the user *sees* the note
        // cross the strike line. The `-latencyOffset` correction is for
        // *audio* timing (correlating mic input to chart notes in
        // matchNotes/checkMisses); applying it here would start the
        // post-hit fade ~latencyOffset (default 80 ms) before the gem
        // visually arrived, shortening the visible glow window.
        const songT = ((hw && hw.getTime) ? hw.getTime() : 0)
            + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);

        // Anchor the post-strike glow / miss-wash age on when the verdict
        // landed (_ndDisplayFrom, stamped in recordJudgment), not the note's
        // chart time. An engine verdict arrives ~0.4 s after the note
        // crosses the line; measuring the fade from chart time would leave
        // only a sliver of the window — or none — by the time the gem can
        // actually be tinted. clamp to chartTime so a verdict that somehow
        // predates the note can't start the fade early.
        const dispAnchor = Number.isFinite(j._ndDisplayFrom)
            ? Math.max(chartTime, j._ndDisplayFrom) : chartTime;

        if (j.hit) {
            // Score-pop channel for the renderer: per-note points stamped by
            // recordJudgment. Chord MEMBER judgments carry no points of their
            // own — the chord-level judgment (keyed `<t>_chord`) owns the
            // value — so fall back to it and hand back ITS key as popKey,
            // letting the renderer dedupe to one pop per chord instead of
            // one per gem. Singles use their own key.
            let points = j._ndPoints, mult = j._ndMult, popKey = key;
            if (points === undefined) {
                const chordKey = `${chartTime.toFixed(3)}_chord`;
                const cj = noteResults.get(chordKey);
                if (cj && cj.hit && cj._ndPoints !== undefined) {
                    points = cj._ndPoints;
                    mult = cj._ndMult;
                    popKey = chordKey;
                }
            }
            const sus = +note.sus || 0;
            // Sustained note still inside its ring window AND still audibly
            // ringing on-pitch → hold it lit, brightness tracking the live
            // input level. Below the level threshold, fall through to the
            // post-strike hit fade (the note has decayed / been muted).
            if (sus > 0.05 && songT < chartTime + sus + 0.05 && _sustainStillHeld(key, note)) {
                const a = _ndSustainGlowAlpha();
                if (a > 0) return { state: 'active', alpha: a, live: true, points, mult, popKey };
            }
            // Otherwise: brief post-strike glow that fades out over
            // hitGlowDuration (measured from when the verdict landed).
            const age = songT - dispAnchor;
            if (age < 0) return { state: 'hit', alpha: 1, points, mult, popKey };  // struck a hair early
            const glowDur = Math.max(0.1, hitGlowDuration);
            if (age >= glowDur) return null;
            return { state: 'hit', alpha: 1 - age / glowDur, points, mult, popKey };
        }
        // Missed (timing window expired, or matched-but-not-clean).
        const age = songT - dispAnchor;
        if (age < 0 || age >= NOTE_MISS_GEM_TTL) return null;
        return { state: 'miss', alpha: 1 - age / NOTE_MISS_GEM_TTL };
    }

    // Is the live monophonic detection on target for `note`? Maintains a
    // short grace window in _susActiveUntil so a held note doesn't flicker
    // between audio frames. Chord notes don't get a per-frame polyphonic
    // re-score today — for a sustained chord this returns false once the
    // monophonic detector loses the pitch, so the chord falls through to
    // the post-strike glow fade in noteStateFor.
    // TODO(slopsmith#254 follow-up): re-run the constraint chord scorer
    // per audio frame for sustained-and-hit chords so held chords glow
    // the same way held single notes do.
    function _sustainStillHeld(key, note) {
        const nowMs = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        if (detectedMidi >= 0 && detectedConfidence > detectionConfidenceMin) {
            const expectedMidi = _ndMidiFromStringFret(
                note.s, note.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            if (Number.isFinite(expectedMidi)
                && Math.abs(_ndNearestOctaveCents(detectedMidi, expectedMidi)) <= pitchTolerance) {
                _susActiveUntil.set(key, nowMs + NOTE_SUS_GRACE_MS);
                return true;
            }
        }
        const until = _susActiveUntil.get(key);
        return Number.isFinite(until) && until > nowMs;
    }

    function bsearch(arr, target) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function dispatchInstanceEvent(type, detail) {
        // Global dispatch preserves back-compat (practice journal and
        // other consumers listen on `window`). Per-instance dispatch
        // on `instanceRoot` lets splitscreen and other multi-panel
        // consumers attach listeners scoped to a single detector.
        const init = { detail, bubbles: true };
        try { window.dispatchEvent(new CustomEvent(type, init)); } catch (e) {}
        try { instanceRoot.dispatchEvent(new CustomEvent(type, init)); } catch (e) {}
    }

    function emitSlopsmithJudgment(judgment) {
        if (!window.slopsmith || typeof window.slopsmith.emit !== 'function') return;
        try {
            window.slopsmith.emit(judgment.hit ? 'note:hit' : 'note:miss', judgment);
        } catch (e) {}
    }

    function dispatchJudgment(judgment) {
        dispatchInstanceEvent(judgment.hit ? 'notedetect:hit' : 'notedetect:miss', judgment);
        emitSlopsmithJudgment(judgment);
    }

    // Session-level FX broadcast for renderers (multiplier tier changes,
    // streak milestones, streak breaks). Fires both as a bubbling DOM
    // CustomEvent (dispatchInstanceEvent — lets splitscreen renderers scope
    // to their own panel via the event path) and on the slopsmith bus for
    // bus-only consumers. Fields per fxType:
    //   multiplier  — { mult, prevMult, streak }
    //   milestone   — { streak, mult }
    //   streakBreak — { lostStreak, prevMult }
    // All events also carry { isDefault, ts }. Additive-only contract: new
    // fxTypes/fields may appear, existing ones never change meaning.
    function dispatchFx(detail) {
        detail.isDefault = isDefault;
        detail.ts = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        dispatchInstanceEvent('notedetect:fx', detail);
        if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
            try { window.slopsmith.emit('notedetect:fx', detail); } catch (e) {}
        }
    }

    // The `extra.chord ? chordTimingHitThreshold : timingHitThreshold`
    // selector below is the chord-vs-single-note threshold split for
    // issue #38. _ndMakeJudgment is threshold-agnostic — it honours
    // whatever `timingThresholdMs` we pass — so the entire chord-window
    // policy lives at THIS call site (and its sibling `makeMissJudgment`
    // below). End-to-end coverage of the selector lives in
    // tools/regression-fixtures.json (Bad Habit): if this ternary ever
    // inverts or drops chord-judgment widening, the fixture score
    // collapses by ~10pp on a fixed input. Unit-level coverage of
    // _ndMakeJudgment's threshold handling itself is in
    // test/judgment.test.js.
    function makeMatchedJudgment(cn, noteTime, t, expectedMidi, detectedMidiForJudgment, confidence, extra = {}) {
        const hasExplicitPitchError = Object.prototype.hasOwnProperty.call(extra, 'pitchError');
        const pitchError = hasExplicitPitchError
            ? extra.pitchError
            : (Number.isFinite(detectedMidiForJudgment) ? (detectedMidiForJudgment - expectedMidi) * 100 : null);
        const expectedFreq = 440 * Math.pow(2, (expectedMidi - 69) / 12);
        const detectedFreq = Number.isFinite(detectedMidiForJudgment)
            ? 440 * Math.pow(2, (detectedMidiForJudgment - 69) / 12)
            : null;
        return _ndMakeJudgment({
            matched: true,
            note: extra.note || { s: cn.s, f: cn.f },
            notes: extra.notes || null,
            chord: !!extra.chord,
            chartNote: extra.chartNote || cn,
            noteTime,
            judgedAt: t,
            expectedMidi,
            detectedMidi: detectedMidiForJudgment,
            confidence,
            pitchError,
            expectedFreq,
            detectedFreq,
            timingThresholdMs: (extra.chord ? chordTimingHitThreshold : timingHitThreshold) * 1000,
            // A bend / slide / harmonic note's pitch is intentionally not at
            // the chart pitch — the caller passes a widened threshold so the
            // hit is not gated on a moving target.
            pitchThresholdCents: Number.isFinite(extra.pitchThresholdCents)
                ? extra.pitchThresholdCents : pitchHitThreshold,
            // Same widened-window signal drives the clean *pitch* skip: an
            // intentionally off-chart bend/slide/harmonic must not be graded
            // looseReason:'pitch'. Clean timing still applies.
            pitchWindowWidened: Number.isFinite(extra.pitchThresholdCents),
            cleanTimingThresholdMs: cleanTimingThreshold * 1000,
            cleanPitchThresholdCents: cleanPitchThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            monophonicDetected: extra.monophonicDetected,
            lateGraceMs: extra.lateGraceMs,
        });
    }

    // Bass long-window rescue: a bass single note about to retire as a miss is
    // re-checked on a 16384-pt window CENTERED on its expected chart time, which
    // resolves the low fundamental the live 4096-pt frame can't. Scans
    // center-outward ±160 ms (the live audio path drifts vs the chart stamp) and
    // only accepts the EXPECTED pitch, so it never admits a wrong note. Returns
    // a matched judgment on rescue, else null. Bass-only. See _RESCUE_WIN.
    function _tryBassRescue(cn, noteTime, expectedMidi) {
        if (currentArrangement !== 'bass' || _rescueBuf.length < _RESCUE_WIN) return null;
        const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
        if (!(sr > 0) || !Number.isFinite(expectedMidi)) return null;
        _rescueCalls++;
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        // The note's audio sits at hw time = noteTime - avOffset + latency
        // (inverse of the match clock t = hwTime + avOffset - latency).
        const noteHwTime = noteTime - avOffsetSec + latencyOffset;
        const samplesBack = Math.round((_rescueBufEndT - noteHwTime) * sr);
        const center = _rescueBuf.length - samplesBack;
        // Scan CENTER-OUTWARD (0, +STEP, -STEP, …) and take the first hit; on a
        // repeated note center-outward prefers the on-time instance. ±160 ms in
        // 80 ms steps → 5 windows (0, ±80, ±160); the 340 ms windows overlap by
        // ~260 ms so a mis-timed played note is still caught.
        const SEARCH = Math.round(0.16 * sr);
        const STEP = Math.round(0.08 * sr);
        const maxK = Math.floor(SEARCH / STEP);
        // Cheap early-out: the 340 ms center window catches any note in ±160 ms
        // range, so if the center has essentially no band energy the note wasn't
        // played here — skip the remaining 16384-pt FFTs. Floor sits below the
        // 0.015 hit gate so a bleed-masked real miss is never skipped.
        const _RESCUE_SILENT_BAND = 0.008;
        let r = null;
        for (let k = 0; k <= maxK && !r; k++) {
            for (const d of (k === 0 ? [0] : [k * STEP, -k * STEP])) {
                const start = center + d - (_RESCUE_WIN >> 1);
                if (start < 0 || start + _RESCUE_WIN > _rescueBuf.length) continue;
                const win = _rescueBuf.subarray(start, start + _RESCUE_WIN);
                _rescueWindows++;
                const cand = _ndConstraintCheckString(
                    win, sr, cn.s, cn.f, currentArrangement, currentStringCount,
                    tuningOffsets, capo, _ND_VERIFY_PITCH_CENTS_BASS, 0.015
                );
                if (cand && cand.hit) { r = cand; break; }
                // After the center window, bail the whole scan if silent.
                if (k === 0 && cand && cand.bandEnergy < _RESCUE_SILENT_BAND) {
                    _rescueSkippedSilent++;
                    return null;
                }
            }
        }
        if (!r) return null;
        _rescueHits++;
        // Report on-pitch: the 60c band-verify gate is the bass standard; the
        // tighter pitchHitThreshold is too fine for coarse low bins.
        const detMidi = Number.isFinite(r.centsError) ? expectedMidi + r.centsError / 100 : expectedMidi;
        return makeMatchedJudgment(cn, noteTime, noteTime, expectedMidi, detMidi, 1, { pitchError: 0, rescued: true });
    }

    // Single-FFT miss analysis for a CONCEDED bass miss: read the 16384-pt
    // rescue window ONCE and derive all three coaching signals — per-string
    // energy (wrong-string / ambient), mute-fail (open string rang instead of
    // the fretted note), and note-presence (the expected note's harmonic comb
    // is there → the player DID play it, the detector just dropped it). Firing
    // three separate 16384-pt FFTs per miss starved the render loop (the
    // highway-stutter regression), so they share one FFT. Bass only.
    function _missAnalysisAtNote(chartNote, noteTime) {
        const blank = { stringEnergy: null, muteFail: false, presenceComb: 0 };
        if (currentArrangement !== 'bass' || _rescueBuf.length < _RESCUE_WIN) return blank;
        const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
        if (!(sr > 0)) return blank;
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const noteHwTime = noteTime - avOffsetSec + latencyOffset;
        const samplesBack = Math.round((_rescueBufEndT - noteHwTime) * sr);
        const center = _rescueBuf.length - samplesBack;
        const start = center - (_RESCUE_WIN >> 1);
        if (start < 0 || start + _RESCUE_WIN > _rescueBuf.length) return blank;
        const win = _rescueBuf.subarray(start, start + _RESCUE_WIN);
        try {
            const { magnitudes, binHz } = _ndFftMagnitude(win, sr);   // the ONE FFT
            const total = _ndTotalEnergy(magnitudes);
            // Per-string energy — the wrong-string / ambient signal on a miss.
            const stringEnergy = new Array(currentStringCount);
            for (let s = 0; s < currentStringCount; s++) {
                const [lo, hi] = _ndStringBandHz(s, currentArrangement, currentStringCount, tuningOffsets, capo);
                stringEnergy[s] = Math.round(_ndBandEnergy(magnitudes, binHz, lo, hi, total) * 1000) / 1000;
            }
            // Charted string's expected pitch + band peak — shared by both checks.
            const expectedMidi = _ndMidiFromStringFret(chartNote.s, chartNote.f, currentArrangement, currentStringCount, tuningOffsets, capo);
            const expHz = 440 * Math.pow(2, (expectedMidi - 69) / 12);
            const [loHz, hiHz] = _ndStringBandHz(chartNote.s, currentArrangement, currentStringCount, tuningOffsets, capo);
            const loBin = Math.max(0, Math.floor(loHz / binHz));
            const hiBin = Math.min(magnitudes.length - 1, Math.ceil(hiHz / binHz));
            let bandPk = 0;
            for (let k = loBin; k <= hiBin; k++) if (magnitudes[k] > bandPk) bandPk = magnitudes[k];
            // Mute-fail (fretted notes only): did the open string ring instead?
            let muteFail = false;
            if (Number.isFinite(chartNote.f) && chartNote.f > 0) {
                const openMidi = _ndMidiFromStringFret(chartNote.s, 0, currentArrangement, currentStringCount, tuningOffsets, capo);
                const openHz = 440 * Math.pow(2, (openMidi - 69) / 12);
                muteFail = _ndDetectMuteFail(magnitudes, binHz, expHz, openHz, bandPk);
            }
            // Presence: was the expected note actually there (player played it)?
            const presenceComb = _ndHarmonicCombCount(magnitudes, binHz, expHz, bandPk);
            return { stringEnergy, muteFail, presenceComb };
        } catch (_) { return blank; }
    }

    // Was the player SILENT at a missed note's time (stopped / didn't play),
    // vs the detector's low-string blind spot (string ringing, pitch unresolved)?
    // Level samples are in visual time (songT = getTime + avOffset); the note's
    // audio time maps to visual time + latencyOffset. true/false, or null if no
    // level telemetry covers the window.
    function _wasSilentAtNote(noteTime) {
        return _ndIsSilentWindow(_ndLevelSamples, noteTime + latencyOffset, _ND_LEVEL_WIN_HALF, _ND_SILENCE_THRESHOLD);
    }

    function makeMissJudgment(cn, noteTime, t, expectedMidi, extra = {}) {
        return _ndMakeJudgment({
            matched: false,
            note: extra.note || { s: cn.s, f: cn.f },
            notes: extra.notes || null,
            chord: !!extra.chord,
            chartNote: extra.chartNote || cn,
            noteTime,
            judgedAt: t,
            expectedMidi,
            timingThresholdMs: (extra.chord ? chordTimingHitThreshold : timingHitThreshold) * 1000,
            pitchThresholdCents: pitchHitThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            lateGraceMs: extra.lateGraceMs,
        });
    }

    // Bin one judgment into the diagnostic counters. Called from inside
    // recordJudgment under the same `count` gate so this never double-
    // counts (chord events fire one chord-level judgment plus per-string
    // ones; only the chord-level passes count=true). One miss → exactly
    // one primary-cause bin (chord events into chordPartial regardless
    // of axis; non-chord misses chosen as pure → timing → pitch in that
    // priority, so a single bar height adds up to total misses).
    //
    // NOTE: per-string counters here only see the chord-level chartNote
    // (lead constituent). Chord constituents go through
    // _diagCatalog.recordPerStringForChord at their stash sites so
    // per-string stats reflect each string's actual outcome.
    // (extracted to diagnostic-catalog.js cut 6)

    // Has this key already been COUNTED into hits/misses?
    //
    // noteResults cannot answer this on its own: the gc interval prunes it for
    // memory (entries more than 5 s behind the playhead, once it passes 500),
    // so on the engine path a pruned entry silently disarms the drain's
    // double-count guard. The engine re-delivers old notes routinely — any
    // setChart un-finalizes the ENTIRE chart (NoteVerifier::setChart), so every
    // note behind the playhead re-finalizes and comes back in one uncapped
    // drain — and a mid-song setChart is not rare: the detect loop re-pushes
    // whenever _ndChartSignature() changes, which includes the timing/pitch
    // tolerance sliders. Result: nudge a slider mid-song and the whole chart
    // behind you scores a second time.
    //
    // _scoreLedger carries one entry per counted judgment under the SAME key and
    // is never GC'd, so it is the authority. Check both: the ledger skips a
    // judgment with no derivable note time, which noteResults still holds.
    //
    // The browser path's own noteResults.has() guards don't need this —
    // checkMisses only scans back ~2.2 s (scanStartT), well inside the GC's 5 s
    // horizon, so it never revisits a pruned note.
    function _ndAlreadyCounted(key) {
        return noteResults.has(key) || _scoreLedger.has(key);
    }

    function recordJudgment(key, judgment, { count = true, emit = true } = {}) {
        // slopsmith#254 — stamp the song-time at which this verdict became
        // known. noteStateFor() measures the highway gem's hit/miss display
        // window from here, not from the note's chart time: the engine
        // verifier reports verdicts ~0.4 s after the note crosses the line,
        // so anchoring on chart time would burn most of the glow window
        // before the verdict even exists. Browser-path judgments are
        // recorded near chart time, so this is effectively a no-op there.
        if (judgment && !Number.isFinite(judgment._ndDisplayFrom)) {
            judgment._ndDisplayFrom = ((hw && hw.getTime) ? hw.getTime() : 0)
                + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);
        }
        noteResults.set(key, judgment);
        if (count) {
            if (judgment && !judgment.hit) {
                _ndLogVerifierRejectFromJudgmentIfNew(key, judgment);
            }
            _diagCatalog.recordDiagnostic(judgment);
            // No per-judgment sync — the host getLoop() poll would land
            // on the scoring hot path. Instead we sync at enable()
            // (closes the post-enable gap) and rely on updateHUD's
            // 33 ms tick for ongoing tracking. Mid-drill bounds changes
            // lag by at most one frame, which the user can't perceive.
            if (judgment.hit) {
                hits++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
                const prevMult = multiplier;
                multiplier = _ndMultiplierForStreak(streak);
                if (multiplier > maxMultiplier) maxMultiplier = multiplier;
                const pts = (judgment.chord ? ND_BASE_CHORD : ND_BASE_SINGLE) * multiplier;
                score += pts;
                // Stash the per-note value on the judgment so noteStateFor()
                // can hand the highway renderer the score-pop amount without
                // a second lookup. Underscore-prefixed: internal annotation,
                // not part of the judgment's public shape.
                judgment._ndPoints = pts;
                judgment._ndMult = multiplier;
                if (multiplier !== prevMult) {
                    dispatchFx({ fxType: 'multiplier', mult: multiplier, prevMult, streak });
                }
                if (_ndIsStreakMilestone(streak)) {
                    dispatchFx({ fxType: 'milestone', streak, mult: multiplier });
                }
                updateSectionStat('hit');
                // (auto-drill miss tracking + iter counters → _drillConductor.onJudgment)
            } else {
                const lostStreak = streak;
                misses++;
                streak = 0;
                // Only celebrate-the-loss when there was a multiplier going —
                // a miss at ×1 with a short streak isn't a "break" moment.
                if (lostStreak >= 10) {
                    dispatchFx({ fxType: 'streakBreak', lostStreak, prevMult: multiplier });
                }
                multiplier = 1;
                updateSectionStat('miss');
            }
            // Auto-drill tracking + per-iteration drill counters (nd-carve-5 cut 3).
            _drillConductor.onJudgment(judgment);
            // Record this counted judgment in the position-aware ledger so a
            // backward reposition can rebuild the score (see _scoreLedger /
            // _recomputeScoreToPosition). Use the chart-note time — noteTime is
            // populated on every chart-path judgment and the external/contained
            // paths pass it explicitly; chartNote.t is the fallback. A judgment
            // with no derivable time (shouldn't happen) is simply not ledgered,
            // so it can't be rolled back — better than poisoning the ledger with
            // NaN and dropping a survivor on every recompute.
            const _ledgerT = Number.isFinite(judgment && judgment.noteTime)
                ? judgment.noteTime
                : (judgment && judgment.chartNote && Number.isFinite(judgment.chartNote.t))
                    ? judgment.chartNote.t
                    : NaN;
            if (Number.isFinite(_ledgerT)) {
                _scoreLedger.set(key, { t: _ledgerT, hit: !!judgment.hit, chord: !!judgment.chord });
            }
        }
        if (emit) dispatchJudgment(judgment);
    }

    // Timing-free, chart-aware verify hook. When a consumer (e.g. Step Mode,
    // which freezes the playhead ON a note) has registered a target via
    // setVerifyTarget(), score that note set against the live audio EVERY
    // frame, regardless of the playhead, and emit notedetect:verify on a hit.
    // This is the same harmonic-comb verifier the chart path uses
    // (_ndScoreChord / scoreChord IPC) but WITHOUT the playhead-relative
    // timing gate that makes notedetect:hit unusable on a frozen playhead
    // (#468 / #630). Runs only while a target is set, so it costs nothing in
    // normal play.
    async function _runVerifyTarget(frameBuffer) {
        const target = _verifyTarget;
        if (!target || !target.length) return;
        // The target only makes sense on the chart it was registered for —
        // drop it outright if the arrangement/tuning/capo changed, so a stale
        // target can never score (or emit verify) against a different chart.
        if (_verifyTargetSig !== _ndVerifyActiveSig()) {
            _verifyTarget = null;
            _verifyTargetSig = null;
            _verifyTargetCtx = null;
            return;
        }
        // Tuning context the target is scored under: the caller's override
        // when one was registered (contained playback verifying against the
        // player's real instrument), else the host song's live state.
        const ctx = _ndVerifyActiveCtx();
        // Same arrangement-aware harmonic-comb verify window the single-note
        // path uses. Passing the user's tight pitch_tolerance_cents straight
        // into the DSP scorer rejects ~90% of correctly-played notes (a
        // spectral peak is far coarser than a ±10-cent gate), so use the
        // deliberately-generous verify window instead.
        const verifyParams = _ndVerifyParamsFor(ctx.arrangement);
        let result;
        if (usingDesktopBridge) {
            if (!_ndBridgeScoreAvailable()) return;
            const gen = sessionGen;
            try {
                result = await _ndBridgeScoreChord({
                    arrangement: ctx.arrangement,
                    stringCount: ctx.stringCount,
                    offsets: ctx.offsets.slice(0, ctx.stringCount),
                    capo: ctx.capo,
                    pitchCheckCents: verifyParams.pitchCheckCents,
                    minHitRatio: _ND_VERIFY_MIN_HIT_RATIO,
                    bypassMl: true,               // force the DSP scorer, not the ML path
                    harmonicVerify: true,         // harmonic-comb check, not band-energy/total
                    harmonicSnr: verifyParams.harmonicSnr,
                    fundamentalRatio: verifyParams.fundamentalRatio,
                    notes: target,
                });
            } catch (e) { return; }
            if (!enabled || gen !== sessionGen) return;
            // The IPC round-trip yields; if the consumer cleared/replaced the
            // target, or its tuning context changed during it, this result is
            // for a stale note — drop it so we don't fire verify for the
            // wrong step.
            if (_verifyTarget !== target || _verifyTargetSig !== _ndVerifyActiveSig()) return;
        } else {
            if (!frameBuffer) return;
            const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
            result = _ndScoreChord(
                frameBuffer, sr, target,
                ctx.arrangement, ctx.stringCount, ctx.offsets, ctx.capo,
                verifyParams.pitchCheckCents, _ND_VERIFY_MIN_HIT_RATIO
            );
        }
        if (result && result.isHit) {
            dispatchInstanceEvent('notedetect:verify', {
                isHit: true,
                score: result.score,
                hitStrings: result.hitStrings,
                totalStrings: result.totalStrings,
                notes: target.map(n => ({ s: n.s, f: n.f })),
            });
        }
    }

    async function matchNotes(frameBuffer) {
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const t = hw.getTime() + avOffsetSec - latencyOffset;
        // A/V auto-calibration tap (browser + desktop-yin/ml paths). The
        // engine-verifier path returns before matchNotes(), so it taps
        // _avCal.logDetection() directly — see the poll loop.
        _avCal.logDetection();
        // Don't bail on detectedMidi < 0 here — chord scoring uses the
        // raw audio buffer and doesn't need a confident monophonic pitch.
        // The single-note path below is gated on detectedMidi >= 0 and
        // skips itself when detection wasn't confident.

        const notes = _ndChartNotes();
        const chords = _ndChartChords();

        // Timing-free verify target. Run it AFTER snapshotting t / notes /
        // chords above so the awaited scoreChord IPC (bridge path) can't shift
        // the chart-scoring playhead by a frame. It's a yield point, so a
        // notedetect:verify listener may disable detection or switch songs
        // synchronously — re-validate the session before we score the chart
        // below, or we'd book stale-session judgments against the old chart.
        if (_verifyTarget) {
            const vgen = sessionGen;
            const vtarget = _verifyTarget;
            const vsig = _ndChartSignature();
            await _runVerifyTarget(frameBuffer);
            // Abort the chart-scoring below if anything a notedetect:verify
            // listener could touch synchronously changed during the dispatch:
            // the session (sessionGen), the chart (signature — a song/
            // arrangement switch doesn't bump sessionGen), or the verify
            // target itself (a listener calling setVerifyTarget). Otherwise
            // we'd score the pre-await t/notes/chords snapshot under changed
            // state and could book a stale judgment for the previous step.
            if (!enabled || vgen !== sessionGen
                || _verifyTarget !== vtarget || _ndChartSignature() !== vsig) return;
        }

        const tolerance = timingTolerance;
        const centsTolerance = pitchTolerance;

        const candidateNotes = [];

        // For sus-marked chart notes, allow late detection — the note is
        // still audibly ringing past its nominal `t + tolerance`, and
        // YIN may need ~80–100 ms of accumulated buffer to confidently
        // lock on (longer for low E). Without this, players who pluck
        // slightly late on a half- or whole-note get no judgment recorded
        // at all (pure miss) instead of a hit-while-ringing. Cap the
        // grace at MAX_SUS_LATE_GRACE so a 4-second sustain doesn't
        // accept detections seconds after the strike.
        const MAX_SUS_LATE_GRACE = 1.0;  // seconds
        if (notes && notes.length > 0) {
            // Bsearch from `t - tolerance - MAX_SUS_LATE_GRACE` so the
            // scan picks up sus-marked notes whose nominal window has
            // already closed but whose sustain envelope hasn't. The
            // per-note filter below ensures non-sus notes still age out
            // at the strict ±tolerance boundary.
            const start = bsearch(notes, t - tolerance - MAX_SUS_LATE_GRACE);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > t + tolerance) break;
                if (n.mt) continue;
                // Non-sus notes use the strict past edge; sus notes get
                // a grace bounded by both the chart's declared sustain
                // and the global cap.
                const susSec = Number.isFinite(n.sus) && n.sus > 0 ? n.sus : 0;
                const lateGrace = susSec > 0 ? Math.min(susSec, MAX_SUS_LATE_GRACE) : 0;
                if (n.t < t - tolerance - lateGrace) continue;
                // Spread the chart note so technique flags (ho/po/b/sl/hm)
                // travel with the candidate. _ndScoreChord reads these to
                // adjust per-string thresholds, so dropping them here would
                // make hammer-on/bend/harmonic adjustments dead code in
                // actual gameplay.
                candidateNotes.push({ ...n });
            }
        }
        if (chords && chords.length > 0) {
            // Chord candidate window extends past the strict upper edge
            // the same way single notes do: a chord that says "ring for
            // 1.5 s" is still audibly the right chord 800 ms after the
            // chart strike, and a player strumming late should still be
            // matched against it. The chord scorer (_ndScoreChord) does
            // its own per-string pitch + energy check on whatever audio
            // buffer is current, so an extended candidate window just
            // gives matchNotes more frames in which to attempt scoring
            // — it doesn't loosen the per-string check itself.
            //
            // Take the max sus across chord constituents so a chord with
            // mixed sustains doesn't drop out the moment its shortest
            // string would have decayed.
            const start = bsearch(chords, t - tolerance - MAX_SUS_LATE_GRACE);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > t + tolerance) break;
                let chordSus = 0;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    if (Number.isFinite(cn.sus) && cn.sus > chordSus) chordSus = cn.sus;
                }
                const lateGrace = chordSus > 0 ? Math.min(chordSus, MAX_SUS_LATE_GRACE) : 0;
                if (c.t < t - tolerance - lateGrace) continue;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    // Chord constituent notes don't carry their own time —
                    // the chord's `c.t` is the timestamp.
                    candidateNotes.push({ ...cn, t: c.t });
                }
            }
        }

        // Display fingering is only meaningful when we have a confident
        // monophonic pitch to map back to a (string, fret). With no pitch
        // (chord-heavy frames) leave the HUD's last detected position
        // alone — the per-string chord HUD takes over from there.
        if (detectedMidi >= 0) {
            const disp = _ndResolveDisplayFingering(
                detectedMidi, candidateNotes, currentArrangement,
                currentStringCount, tuningOffsets, capo, centsTolerance
            );
            detectedString = disp.string;
            detectedFret = disp.fret;
            detectedDisplayMidi = Number.isFinite(disp.displayMidi) ? disp.displayMidi : detectedMidi;
        }

        // ── Single-note path (existing YIN/HPS/CREPE result) ──────────
        // Group candidate notes by chord time so we can route chord events
        // to the constraint scorer and single notes to the MIDI comparator.
        // A chord is any group of ≥2 simultaneous candidates sharing a time.
        const byTime = new Map();
        for (const cn of candidateNotes) {
            const tk = cn.t.toFixed(3);
            if (!byTime.has(tk)) byTime.set(tk, []);
            byTime.get(tk).push(cn);
        }

        // ── Single notes: one batched DSP band-energy score per tick ──────
        // A single note is a 1-string chord. Scoring each one with its own
        // scoreChord IPC fires one round-trip per note per detect tick — on
        // a dense lead that floods the renderer event loop and visibly
        // stutters the highway. scoreChord already returns a per-note
        // results[] array, so the whole pending set is verified in ONE call
        // (one FFT). bypassMl forces the DSP spectral check over the
        // onset-driven ML path, which silently drops fast notes. The
        // open-domain detector still drives the live HUD readout.
        const _ndSingleNotes = [];   // cn objects, 1:1 with the batch results
        for (const [, group] of byTime) {
            if (group.length !== 1) continue;
            const cn = group[0];
            if (noteResults.has(noteKey(cn, cn.t))) continue;
            _ndSingleNotes.push(cn);
        }
        const _ndSingleResult = new Map();   // cn -> per-note band-energy result
        if (_ndSingleNotes.length > 0) {
            // Compute the arrangement-aware verify params once per tick — both
            // the desktop-bridge scoreChord call and the browser fallback below
            // read from this, instead of re-allocating the object per field.
            const verifyParams = _ndVerifyParamsFor(currentArrangement);
            let batch = null;
            if (usingDesktopBridge) {
                if (_ndBridgeScoreAvailable()) {
                    const ctx = {
                        arrangement: currentArrangement,
                        stringCount: currentStringCount,
                        offsets: tuningOffsets.slice(0, currentStringCount),
                        capo,
                        // Verification window, deliberately generous. This
                        // only confirms the chart note is the pitch ringing
                        // (and rejects a neighbouring fret, ~100 cents away).
                        // The strict hit/miss pitch call belongs to
                        // makeMatchedJudgment below, from the measured
                        // centsError. Passing the user's tight
                        // pitch_tolerance_cents straight into the DSP scorer
                        // made it reject ~90% of correctly-played notes — a
                        // spectral peak is far coarser than a ±10-cent gate.
                        // Bass relaxes the pitch window + fundamental-presence
                        // gate (see _ndVerifyParamsFor) — its DI fundamental is
                        // weak and its low bins resolve pitch coarsely.
                        pitchCheckCents: verifyParams.pitchCheckCents,
                        minHitRatio: chordHitRatio,   // unused — per-note results read directly
                        bypassMl: true,               // force the DSP scorer, not the ML path
                        harmonicVerify: true,         // harmonic-comb check, not band-energy/total
                        harmonicSnr: verifyParams.harmonicSnr,
                        fundamentalRatio: verifyParams.fundamentalRatio,
                        notes: _ndSingleNotes.map(cn => ({
                            s: cn.s, f: cn.f,
                            ho: !!cn.ho, po: !!cn.po,
                            b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                        })),
                    };
                    const gen = sessionGen;
                    try {
                        batch = await _ndBridgeScoreChord(ctx);
                    } catch (e) {
                        console.warn('[note_detect] scoreChord IPC failed:', e && e.message ? e.message : e);
                        batch = null;
                    }
                    // Re-validate after the IPC await (mirrors the chord path).
                    if (!enabled || gen !== sessionGen) return;
                }
            } else if (frameBuffer) {
                // Browser: _ndScoreChord is already a DSP band-energy check.
                const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
                batch = _ndScoreChord(
                    frameBuffer, sr,
                    _ndSingleNotes, currentArrangement, currentStringCount,
                    // Same arrangement-aware pitch window as the desktop-bridge
                    // path above, so bass gets the wider 60c gate in the browser
                    // fallback too (otherwise the fallback undercuts the bass
                    // improvement on low strings whose bins resolve coarsely).
                    tuningOffsets, capo,
                    verifyParams.pitchCheckCents,
                    chordHitRatio
                );
            }
            // results[] is aligned 1:1 with the notes[] array we sent.
            if (batch && Array.isArray(batch.results)) {
                for (let i = 0; i < _ndSingleNotes.length && i < batch.results.length; i++) {
                    _ndSingleResult.set(_ndSingleNotes[i], batch.results[i]);
                }
            }
        }

        for (const [, group] of byTime) {
            if (group.length === 1) {
                // ── Single-note path: DSP band-energy verification ──────────
                // Per-note result comes from the single batched score above —
                // a 1-string-chord spectral check at the expected fundamental,
                // not an open-domain pitch estimate or an ML onset.
                const cn = group[0];
                const key = noteKey(cn, cn.t);
                if (noteResults.has(key)) continue;

                const r = _ndSingleResult.get(cn);
                // Not verified on this frame (harmonic comb below the SNR
                // threshold, or off-pitch) — leave the note for a later
                // frame or for checkMisses() to retire.
                if (!r || !r.hit) {
                    try {
                        const expectedMidiSnap = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                        );
                        _ndVerifyFailSnap.set(key, {
                            noteTime: cn.t,
                            string: cn.s,
                            fret: cn.f,
                            expectedMidi: expectedMidiSnap,
                            pitchErrorCents: Number.isFinite(r && r.centsError) ? r.centsError : null,
                        });
                    } catch (_) { /* read-only */ }
                    continue;
                }

                // Energy + pitch verified. Build the judgment at the current
                // playhead, but COMMIT only when the timing is clean. An
                // isHit frame can land well before the chart time when the
                // note's string is still ringing from an earlier strike;
                // committing then would lock in an EARLY miss. Defer until a
                // frame lands inside the clean window — checkMisses() retires
                // the note if none ever does.
                const pitchError = Number.isFinite(r.centsError) ? r.centsError : null;
                const expectedMidi = _ndMidiFromStringFret(
                    cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                const detectedMidiForJudgment = Number.isFinite(pitchError)
                    ? expectedMidi + pitchError / 100
                    : null;
                const judgment = makeMatchedJudgment(
                    cn, cn.t, t, expectedMidi, detectedMidiForJudgment, detectedConfidence,
                    { pitchError }
                );
                if (judgment.hit) {
                    recordJudgment(key, judgment);
                } else {
                    const teReason = judgment.timingState === 'EARLY' || judgment.timingState === 'LATE'
                        ? 'TIMING_FAIL'
                        : (judgment.pitchState === 'SHARP' || judgment.pitchState === 'FLAT'
                            ? 'PITCH_FAIL'
                            : 'UNKNOWN');
                    _ndLogVerifierRejectOnce(key, {
                        reason: teReason,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi,
                        detectedMidi: detectedMidiForJudgment,
                        confidence: detectedConfidence,
                        timingErrorMs: judgment.timingError,
                        pitchErrorCents: judgment.pitchError,
                    });
                }
            } else {
                // ── Chord path: constraint-based per-string band analysis ──
                // Chord-level resolved key. checkMisses() honours this so a
                // failed chord becomes one miss event (not one per string).
                const chordKey = `${group[0].t.toFixed(3)}_chord`;
                if (noteResults.has(chordKey)) continue;

                // Two paths:
                //  - Browser: call _ndScoreChord against the FFT
                //    frame the ScriptProcessor just delivered.
                //  - Desktop bridge: dispatch audio:scoreChord IPC —
                //    the native ChordScorer reads from the engine's
                //    own input ring, so no audio buffer crosses IPC.
                //    Older slopsmith-desktop builds without the IPC
                //    skip the chord-scoring step entirely (same as
                //    the previous frameless guard).
                let chordResult;
                if (usingDesktopBridge) {
                    // Dispatch the scoreChord IPC. The native scorer is
                    // ML-backed when a model is loaded (judging each chart
                    // note against the ML detector's active pitch set), else
                    // the constraint scorer — and it times chords correctly,
                    // which a renderer-side detectNotes scorer did not.
                    if (!_ndBridgeScoreAvailable()) {
                        continue;
                    }
                    const ctx = {
                        arrangement: currentArrangement,
                        stringCount: currentStringCount,
                        offsets: tuningOffsets.slice(0, currentStringCount),
                        capo,
                        pitchCheckCents: centsTolerance,
                        minHitRatio: chordHitRatio,
                        notes: group.map(cn => ({
                            s: cn.s, f: cn.f,
                            ho: !!cn.ho, po: !!cn.po,
                            b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                        })),
                    };
                    const gen = sessionGen;
                    try {
                        chordResult = await _ndBridgeScoreChord(ctx);
                    } catch (e) {
                        console.warn('[note_detect] scoreChord IPC failed:', e && e.message ? e.message : e);
                        continue;
                    }
                    if (!chordResult) continue; // downlevel addon returned null
                    // Re-validate after the await. The IPC round-trip
                    // yields the event loop, so checkMisses() can fire
                    // on its own interval and record a miss for this
                    // chordKey while we're waiting on the scorer.
                    // (checkMisses always books the <t>_chord key
                    // first and short-circuits per-string for chord
                    // groups, so only the chord-level key needs
                    // checking here.) Without this guard a late-
                    // arriving hit would double-count against a miss
                    // already booked for the same chord timing.
                    // Bail out of the whole matchNotes() pass — not
                    // just this group — when the instance was disabled
                    // or session-bumped mid-await (settings change /
                    // device restart), so we don't fire more
                    // scoreChord IPCs for subsequent groups against
                    // an invalid session. Per-chord doublebook just
                    // skips this group; later groups are still valid.
                    if (!enabled || gen !== sessionGen) return;
                    if (noteResults.has(chordKey)) continue;
                } else if (!usingDesktopBridge) {
                    // Browser path needs the just-analysed buffer.
                    // Skip if no audio buffer was passed in (e.g.
                    // instance restart while a stale processFrame is
                    // unwinding).
                    if (!frameBuffer) continue;
                    const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
                    chordResult = _ndScoreChord(
                        frameBuffer, sr,
                        group, currentArrangement, currentStringCount,
                        tuningOffsets, capo,
                        centsTolerance,   // pitch check per string
                        chordHitRatio     // min fraction of strings required
                    );
                }

                // Update HUD chord display (latest reading, hit-or-miss)
                lastChordScore = chordResult.score;
                lastChordHit = chordResult.hitStrings;
                lastChordTotal = chordResult.totalStrings;
                lastChordTime = group[0].t;

                const lead = group[0];
                const expectedMidi = _ndMidiFromStringFret(
                    lead.s, lead.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                // Chord-level late-grace must come from the MAX sus
                // across constituents — not just `lead.sus` — so that
                // _ndMakeJudgment's timing classification matches the
                // candidate-inclusion and retire-extension grace logic
                // in matchNotes/checkMisses. Capped at MAX_SUS_LATE_GRACE
                // (mirrors matchNotes; see the constant below).
                let chordSusForGrace = 0;
                for (const cn of group) {
                    if (Number.isFinite(cn.sus) && cn.sus > chordSusForGrace) chordSusForGrace = cn.sus;
                }
                const chordLateGraceMs = chordSusForGrace > 0
                    ? Math.min(chordSusForGrace * 1000, 1000)
                    : 0;
                // Derive pitch error from the first string that actually has a
                // finite centsError measurement. Fall back to the monophonic
                // detector if available; leave null if no pitch data exists
                // (e.g. energy-only checks or lead string failed the pitch check).
                const firstFiniteCentsError = chordResult.results
                    ?.find(r => Number.isFinite(r?.centsError))?.centsError;
                const chordPitchError = firstFiniteCentsError !== undefined
                    ? firstFiniteCentsError
                    : (detectedMidi >= 0 ? _ndFoldOctaveCents((detectedMidi - expectedMidi) * 100) : null);
                const chordDetectedMidi = detectedMidi >= 0
                    ? detectedMidi
                    : (Number.isFinite(chordPitchError)
                        ? expectedMidi + chordPitchError / 100
                        : null);
                // Onset gate (desktop ML bridge): a chord only commits a hit
                // on a poll where one of its pitches was actually struck — a
                // fresh onset in bridgeNewOnsets. Otherwise the chord's
                // pitches ringing on through the surrounding riff drag the
                // match progressively earlier. chordFreshOnsetAge is the
                // freshest such onset (ms), used to back-date the judgment.
                let chordFreshOnsetAge = null;
                if (bridgeOnsetPrimed && bridgeNewOnsets.size > 0) {
                    for (const cn of group) {
                        const m = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount,
                            tuningOffsets, capo
                        );
                        const o = bridgeNewOnsets.get(m);
                        if (o && (chordFreshOnsetAge === null || o.ageMs < chordFreshOnsetAge)) {
                            chordFreshOnsetAge = o.ageMs;
                        }
                    }
                }
                const tChord = (chordFreshOnsetAge != null)
                    ? hw.getTime() + avOffsetSec - (chordFreshOnsetAge / 1000)
                    : t;

                const chordJudgment = makeMatchedJudgment(
                    lead, lead.t, tChord, expectedMidi,
                    chordDetectedMidi,
                    detectedConfidence,
                    {
                        notes: group.map(cn => ({ s: cn.s, f: cn.f })),
                        chord: true,
                        hitStrings: chordResult.hitStrings,
                        totalStrings: chordResult.totalStrings,
                        score: chordResult.score,
                        pitchError: chordPitchError,
                        monophonicDetected: detectedMidi >= 0,
                        lateGraceMs: chordLateGraceMs,
                    }
                );

                // Commit a chord hit only when it scored AND (on the ML
                // bridge) a chord pitch was freshly struck this poll. An
                // isHit frame with no fresh onset is just the chord's pitches
                // still ringing — cache its diagnostics and wait for the
                // strum poll (or checkMisses' voicing rescue).
                if (!chordResult.isHit
                    || (bridgeOnsetPrimed && chordFreshOnsetAge == null)) {
                    // Stash the chordResult before bailing so that when
                    // checkMisses() retires this chord as a miss, the
                    // miss judgment can carry the scorer's per-string
                    // diagnostic data (hitStrings / totalStrings / score).
                    // Without this we were blind on missed chords — the
                    // live JSONL + diagnostic event log just showed
                    // hs/tt/sc=undefined, which made "the scorer saw 2 of
                    // 5 strings — was that just the user's playing, or is
                    // the energy threshold too strict?" impossible to
                    // answer from data alone. The map is keyed by chord
                    // key and the snapshot lands the BEST-SCORE frame
                    // seen during the chord's match window (see the
                    // `useNewSnapshot` predicate below) — gives the
                    // reader "best the scorer got at any point in the
                    // window" rather than an arbitrary final frame which
                    // may be tail-end decay.
                    // Cache for checkMisses to consume on retire.
                    //
                    // Two pieces tracked separately:
                    //
                    //   • voicingHit — STICKY. Once ANY frame in this
                    //     chord's window registered as voicing-eligible
                    //     (≥2 chord strings rang at their expected
                    //     pitches), remember it forever for this chord.
                    //     A subsequent frame where some of those strings
                    //     momentarily failed pitch (decay below threshold
                    //     while the rest still rang, audio bleed shifted
                    //     things, etc.) MUST NOT retroactively cancel a
                    //     previously-eligible voicing. Earlier logic
                    //     here had a "higher score wins" rule that
                    //     accidentally demoted voicingHit:true frames
                    //     when a later !voicingHit but slightly higher
                    //     score frame arrived — which on real-song
                    //     data wiped out the rescue path entirely.
                    //
                    //   • score / hitStrings / totalStrings — best
                    //     frame's diagnostic snapshot, regardless of
                    //     voicingHit. Used by the live JSONL and the
                    //     event log so a reader can see "best the
                    //     scorer got" on this chord.
                    const prev = _chordLastResult.get(chordKey);
                    const voicingEver = !!((prev && prev.voicingHit) || chordResult.voicingHit);
                    const useNewSnapshot = !prev || chordResult.score > (prev.score || 0);
                    // Capture the frame time of the FIRST voicing-eligible
                    // frame for this chord. checkMisses uses this as the
                    // judgment's `judgedAt` so the resulting timingError
                    // reflects when voicing was actually satisfied — not
                    // the retire-tick time (which is by definition past
                    // the chord's match window and would classify the
                    // rescued judgment as LATE, defeating the rescue).
                    const voicingT = (prev && prev.voicingT)
                        ? prev.voicingT
                        : (chordResult.voicingHit ? t : null);
                    _chordLastResult.set(chordKey, {
                        score:        useNewSnapshot ? chordResult.score        : prev.score,
                        hitStrings:   useNewSnapshot ? chordResult.hitStrings   : prev.hitStrings,
                        totalStrings: useNewSnapshot ? chordResult.totalStrings : prev.totalStrings,
                        voicingHit:   voicingEver,
                        voicingT,
                    });
                    // Do not lock in a miss while the chord is still within
                    // its timing window. Chords can enter candidateNotes as
                    // early as (chordTime - timingTolerance), so an early
                    // non-hit frame may still be followed by a valid strum on
                    // a later frame. Let checkMisses() finalize the miss only
                    // after the window has fully elapsed.
                    continue;
                }

                // Chord cleared. Mark the chord-level key 'hit' so the
                // miss aggregator in checkMisses() treats it as a single
                // resolved unit and skips per-string miss accounting.
                // Per-string keys still record each string's actual
                // outcome from `chordResult.results` so the draw overlay
                // can colour gems individually (green / red per fret) on
                // lenient chord hits where some strings rang and some
                // didn't.
                recordJudgment(chordKey, chordJudgment, { count: true, emit: true });
                // Hit path doesn't need any cached miss-diagnostic for
                // this chord — drop the entry so the map only holds
                // truly-pending chords. Without this, the cache could
                // grow over a session as chords flicker through the
                // "scored low, then scored above threshold" pattern.
                _chordLastResult.delete(chordKey);
                // Build an (s,f)-keyed lookup so we don't rely on
                // `chordResult.results[i]` being positionally aligned
                // with `group[i]`. The browser `_ndScoreChord`
                // preserves that ordering by construction, and the
                // native ChordScorer does too — but treating the
                // result as a positional-only array makes
                // per-string gem colouring silently wrong if any
                // future IPC implementation reorders entries. The
                // lookup is O(N) per chord (N ≤ 8), so the
                // defensiveness is essentially free.
                const stringResByKey = new Map();
                if (Array.isArray(chordResult.results)) {
                    for (const r of chordResult.results) {
                        if (r && typeof r.s === 'number' && typeof r.f === 'number') {
                            stringResByKey.set(`${r.s}_${r.f}`, r);
                        }
                    }
                }
                for (let i = 0; i < group.length; i++) {
                    const cn = group[i];
                    const key = noteKey(cn, cn.t);
                    if (noteResults.has(key)) continue;
                    if (!chordJudgment.hit) {
                        // Chord passed energy/ratio threshold but missed the clean-hit
                        // threshold. Use makeMissJudgment so each per-string entry is
                        // internally consistent (no post-mutation of hit after _ndMakeJudgment
                        // has already computed it from timingState/pitchState).
                        const stringExpectedMidi = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                        );
                        // Per-string constituent stays as a single-note
                        // judgment (no chord:true flag): _ndMakeJudgment
                        // treats `chord: true` as timing-only for the
                        // hit calc, which would flip per-string SHARP /
                        // FLAT pitch misses into spurious hits. The
                        // chord-level judgment (which owns the wider
                        // timing window) is already recorded separately
                        // above — this entry only feeds per-string
                        // diagnostics, where pitch correctness matters.
                        const stringMiss = makeMissJudgment(cn, cn.t, t, stringExpectedMidi);
                        noteResults.set(key, stringMiss);
                        _diagCatalog.recordPerStringForChord(stringMiss);
                        continue;
                    }
                    const stringRes = stringResByKey.get(`${cn.s}_${cn.f}`);
                    const stringHit = stringRes && stringRes.hit;
                    const stringExpectedMidi = _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    );
                    const stringJudgment = stringHit
                        ? makeMatchedJudgment(
                            cn, cn.t, t, stringExpectedMidi,
                            Number.isFinite(stringRes?.centsError)
                                ? stringExpectedMidi + stringRes.centsError / 100
                                : null,
                            detectedConfidence,
                            { pitchError: Number.isFinite(stringRes?.centsError) ? stringRes.centsError : null }
                        )
                        : makeMissJudgment(cn, cn.t, t, stringExpectedMidi);
                    noteResults.set(key, stringJudgment);
                    _diagCatalog.recordPerStringForChord(stringJudgment);
                }
            }
        }
    }

    function checkMisses() {
        if (!enabled) return;
        // On the engine-verifier path the engine finalizes misses itself
        // (detected:false verdicts, drained by _ndDrainEngineVerdicts), so
        // this renderer-side retire scan is superseded. The browser path —
        // and any desktop session on a downlevel addon — still relies on it.
        if (_ndUsingEngineVerifier) return;
        // Reset the per-tick rescue-FFT budget (see _RESCUE_WINDOWS_PER_TICK).
        // checkNote spends against this; once exhausted, further conceded bass
        // misses this tick retire as plain misses instead of running FFTs.
        let rescueWinBudget = _RESCUE_WINDOWS_PER_TICK;
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const t = hw.getTime() + avOffsetSec - latencyOffset;
        const tolerance = timingTolerance;
        // Backward seek / restart: the playhead jumped back, so the user is
        // replaying a section (flubbed the intro, backed up, played it clean) or
        // a drill A-B loop wrapped. Re-open every note at/after the new playhead
        // — otherwise the first pass's verdicts stick and the replay never
        // re-scores (the note stays a hotspot the second time through). Seeking
        // back to the start clears everything → a clean fresh attempt. Decision
        // is the pure, tested _ndKeysToReopenOnSeek.
        for (const key of _ndKeysToReopenOnSeek(_ndLastMissScanT, t, tolerance, noteResults.keys())) {
            noteResults.delete(key);
            _susActiveUntil.delete(key);
            // Mirror _recomputeScoreToPosition: drop the chord voicing-rescue
            // cache too, so a reopened chord can't be rescued on the replay by a
            // stale voicingHit:true from the first pass through this section.
            _chordLastResult.delete(key);
        }
        _ndLastMissScanT = t;
        const missDeadline = t - tolerance * 2;
        // Mirror matchNotes' sus-late-grace policy. Without this, a sus
        // note whose match window matchNotes is willing to extend gets
        // retired here as a miss before that extended window has even
        // closed — matchNotes never gets a chance to record the late
        // hit. Cap matches matchNotes (kept loosely in sync via the
        // same constant pattern so both paths shift together).
        const MAX_SUS_LATE_GRACE = 1.0;
        const notes = _ndChartNotes();
        const chords = _ndChartChords();

        // Pass the full chart-note object (not just {s, f}) so the miss
        // judgment carries `sus` and technique flags through to the
        // diagnostic event log. Stripping to {s, f} here made every pure
        // miss look like a staccato note (sus=0) regardless of whether
        // the chart said it was sustained, which corrupts any
        // sus-conditioned analysis downstream.
        const checkNote = (chartNote, noteTime) => {
            const susSec = Number.isFinite(chartNote.sus) && chartNote.sus > 0 ? chartNote.sus : 0;
            const lateGrace = susSec > 0 ? Math.min(susSec, MAX_SUS_LATE_GRACE) : 0;
            // Effective retire threshold: a sus note isn't retired
            // until its sustain envelope has clearly elapsed, giving
            // matchNotes the same grace period to lock on.
            if (noteTime > missDeadline - lateGrace) return;
            const key = noteKey(chartNote, noteTime);
            if (!noteResults.has(key)) {
                const expectedMidi = _ndMidiFromStringFret(
                    chartNote.s, chartNote.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                // Bass long-window rescue before conceding: re-check the note's
                // pitch on a 16384-pt window centered on its expected time. A
                // correctly-played low note the live frame couldn't resolve is
                // credited here instead of retiring as a miss. Skipped once the
                // per-tick FFT budget is spent (batch retire) — the miss still
                // retires, just without the additive rescue upgrade.
                let rescued = null;
                if (rescueWinBudget > 0) {
                    const winBefore = _rescueWindows;
                    rescued = _tryBassRescue(chartNote, noteTime, expectedMidi);
                    rescueWinBudget -= (_rescueWindows - winBefore);
                }
                if (rescued) {
                    _ndVerifyFailSnap.delete(key);
                    recordJudgment(key, rescued);
                } else {
                const snap = _ndVerifyFailSnap.get(key);
                _ndLogVerifierRejectOnce(key, {
                    reason: snap ? 'STRING_VERIFY_FAIL' : 'RETIRE_NO_MATCH',
                    noteTime,
                    string: chartNote.s,
                    fret: chartNote.f,
                    expectedMidi,
                    pitchErrorCents: snap && Number.isFinite(snap.pitchErrorCents)
                        ? snap.pitchErrorCents
                        : null,
                });
                _ndVerifyFailSnap.delete(key);
                const missJudgment = makeMissJudgment(chartNote, noteTime, t, expectedMidi);
                // ONE FFT of the note's rescue window feeds all three signals
                // coaching reads on a miss: per-string energy (wrong-string /
                // ambient), mute-fail (open string rang instead of the fret),
                // and note-presence (player played it → detector blind-spot).
                // Behind the same per-tick budget as the rescue above; under a
                // batch retire the miss simply lands with no attribution.
                let an = { stringEnergy: null, muteFail: false, presenceComb: 0 };
                if (rescueWinBudget > 0) {
                    an = _missAnalysisAtNote(chartNote, noteTime);
                    rescueWinBudget -= 1;
                }
                if (an.stringEnergy) missJudgment.stringEnergy = an.stringEnergy;
                if (an.muteFail) missJudgment.muteFail = true;
                if (an.presenceComb >= _ND_PRESENCE_MIN_COMB) missJudgment.notePresent = true;
                if (an.presenceComb > 0) missJudgment.presenceComb = an.presenceComb;
                // Player silent here (stopped / didn't play) vs blind-spot.
                if (_wasSilentAtNote(noteTime) === true) missJudgment.silent = true;
                recordJudgment(key, missJudgment);
                }
            }
        };

        // Look back far enough that sus-marked notes whose grace just
        // expired are still visited by this scan. Without this, the
        // bsearch start moves forward each tick and overruns notes that
        // were intentionally held past their normal retire window — they
        // never get retired at all. The `+ 1` is the existing lookback
        // slack; `MAX_SUS_LATE_GRACE` is the per-note extension we added.
        const scanStartT = missDeadline - 1 - MAX_SUS_LATE_GRACE;
        if (notes && notes.length > 0) {
            const start = bsearch(notes, scanStartT);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > missDeadline) break;
                if (n.mt) continue;
                checkNote(n, n.t);
            }
        }
        if (chords && chords.length > 0) {
            const start = bsearch(chords, scanStartT);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > missDeadline) break;
                const liveNotes = (c.notes || []).filter(cn => !cn.mt);
                if (liveNotes.length === 0) continue;
                if (liveNotes.length === 1) {
                    // Degenerate "chord" of one — treat as a single note.
                    checkNote(liveNotes[0], c.t);
                    continue;
                }
                // Mirror the matchNotes-side chord candidate grace: a
                // chord with sus-marked constituents isn't retired until
                // its sustain envelope has clearly elapsed, so a late
                // strummer gets the same window to score that a single-
                // note late-detect-gets-credited late-player gets. Take
                // the max sus across constituents.
                let chordSus = 0;
                for (const cn of liveNotes) {
                    if (Number.isFinite(cn.sus) && cn.sus > chordSus) chordSus = cn.sus;
                }
                const chordLateGrace = chordSus > 0 ? Math.min(chordSus, MAX_SUS_LATE_GRACE) : 0;
                // Mirror the seconds-vs-milliseconds split: _ndMakeJudgment
                // wants late-grace in ms, but the retire-window comparisons
                // above use seconds.
                const chordLateGraceMs = chordLateGrace * 1000;
                if (c.t > missDeadline - chordLateGrace) continue;
                // Multi-note chord: judge as a single unit. matchNotes()
                // stores a judgment object at `<t>_chord` when the chord
                // cleared the ratio threshold; if that key is present, the
                // chord is already resolved and we leave the per-string keys alone.
                const chordKey = `${c.t.toFixed(3)}_chord`;
                if (noteResults.has(chordKey)) continue;
                const expectedMidi = _ndMidiFromStringFret(
                    liveNotes[0].s, liveNotes[0].f,
                    currentArrangement, currentStringCount, tuningOffsets, capo
                );
                // Pull the latest chord-scorer result (if any) so the
                // miss judgment carries hs/tt/sc. matchNotes stashes
                // this on every non-hit frame; the most recent stash
                // is "what the scorer last saw on this chord". If the
                // chord scorer never fired in window (no audio buffer,
                // monophonic detection failure path, etc.) the cache
                // is empty and we fall back to undefined-as-before.
                const cachedChord = _chordLastResult.get(chordKey);
                // Voicing-reduction rescue: if matchNotes never found a
                // strict-ratio frame but the chord was voicing-eligible
                // at some point (≥2 chord strings rang at their expected
                // pitches), record this retire as a HIT instead of a miss.
                // This is the "punk-rock power-chord interpretation of a
                // full-chord chart" path — see _ndScoreChord for the
                // detailed rationale and the trade-off vs eager-commit
                // in matchNotes (which we explicitly avoid to keep
                // strict-ratio frames' timing winning when they exist).
                const voicingRescue = !!(cachedChord && cachedChord.voicingHit);
                // Pass the cached voicing-eligible frame time as the
                // judgment's `judgedAt`, not the current retire-tick
                // time. The retire tick fires AFTER the chord window
                // has closed by 2 × timingTolerance + lateGrace, so
                // using `t` here would produce a timingError of
                // hundreds of milliseconds, the timingState would be
                // LATE, and the chord-branch hit calc
                // (`matched && timingState === 'OK'`) would flip the
                // rescue back to a miss — defeating the entire path.
                // The cached voicingT is the actual moment voicing
                // was first satisfied, which is by definition inside
                // the chord's match window.
                const judgedAtForRescue = (voicingRescue && Number.isFinite(cachedChord.voicingT))
                    ? cachedChord.voicingT
                    : t;
                const chordJudgment = voicingRescue
                    ? makeMatchedJudgment(
                        liveNotes[0], c.t, judgedAtForRescue, expectedMidi,
                        null,    // no monophonic detection at retire time
                        0,       // no pitch confidence to claim
                        {
                            chord: true,
                            notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                            hitStrings:   cachedChord.hitStrings,
                            totalStrings: cachedChord.totalStrings,
                            score:        cachedChord.score,
                            // No pitch error to report — voicing-reduction is
                            // an aggregate per-string verdict, not a monophonic
                            // pitch measurement. The pitchState ends up null,
                            // and _ndMakeJudgment's chord-branch hit calc
                            // (`matched && timingState === 'OK'`) lets it
                            // through.
                            pitchError: null,
                            lateGraceMs: chordLateGraceMs,
                        },
                    )
                    : makeMissJudgment(liveNotes[0], c.t, t, expectedMidi, {
                        notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                        chord: true,
                        hitStrings:   cachedChord ? cachedChord.hitStrings   : undefined,
                        totalStrings: cachedChord ? cachedChord.totalStrings : undefined,
                        score:        cachedChord ? cachedChord.score        : undefined,
                        lateGraceMs: chordLateGraceMs,
                    });
                if (!voicingRescue) {
                    _ndLogVerifierRejectOnce(chordKey, {
                        reason: cachedChord ? 'CHORD_RATIO_FAIL' : 'RETIRE_NO_MATCH',
                        noteTime: c.t,
                        chord: true,
                        expectedMidi,
                        hitStrings: cachedChord ? cachedChord.hitStrings : null,
                        totalStrings: cachedChord ? cachedChord.totalStrings : null,
                        chordScore: cachedChord ? cachedChord.score : null,
                    });
                }
                recordJudgment(chordKey, chordJudgment);
                // Free the cache entry — we've consumed it, no further
                // matchNotes frames will fire for this chord (it just
                // got finalized as a miss or voicing-rescue hit).
                _chordLastResult.delete(chordKey);
                for (const cn of liveNotes) {
                    const key = noteKey({ s: cn.s, f: cn.f }, c.t);
                    if (noteResults.has(key)) continue;
                    const stringMiss = makeMissJudgment(cn, c.t, t, _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    ));
                    noteResults.set(key, stringMiss);
                    // Bin per-string only when the chord retired as a
                    // miss. On voicing-rescue (chord-level hit) no
                    // per-string outcomes were measured — we'd be
                    // forcing miss-by-default fallbacks into the
                    // per-string panel and overstating misses on
                    // strings that may have rung fine.
                    if (!voicingRescue) _diagCatalog.recordPerStringForChord(stringMiss);
                }
            }
        }

        const sections = hw.getSections ? hw.getSections() : null;
        if (sections) {
            let current = null;
            for (const sec of sections) {
                if (sec.time <= t) current = sec.name;
                else break;
            }
            if (current && current !== currentSection) {
                currentSection = current;
                if (!sectionStats.find(s => s.name === current)) {
                    sectionStats.push({ name: current, hits: 0, misses: 0 });
                }
            }
        }
    }

    function updateSectionStat(type) {
        if (!currentSection) return;
        let sec = sectionStats.find(s => s.name === currentSection);
        if (!sec) {
            sec = { name: currentSection, hits: 0, misses: 0 };
            sectionStats.push(sec);
        }
        if (type === 'hit') sec.hits++;
        else sec.misses++;
    }

    // ── Verifier reject diagnostics (read-only) ───────────────────────
    function _ndVerifierPathLabel() {
        if (_ndUsingEngineVerifier) return 'desktop-engine-verifier';
        const _dd = _diagCatalog && _diagCatalog.getDiagDetector();
        if (_dd && _dd.path) return String(_dd.path);
        if (usingDesktopBridge) return 'desktop-yin';
        return 'web-' + (detectionMethod || 'yin');
    }

    // Level telemetry around a chart note's strike (visual clock ±200 ms).
    function _ndStrikeLevelContext(noteTimeAudio) {
        const levelAtLogPct = Math.round((inputLevel || 0) * 100);
        if (!Number.isFinite(noteTimeAudio)) {
            return {
                levelAtLogPct,
                strikePeakPct: Math.round((inputPeak || 0) * 100),
                strikeSamplesInWindow: null,
                silenceWouldTrigger: false,
            };
        }
        const cnCenterVisualT = noteTimeAudio + latencyOffset;
        let peakL = 0;
        let inWindow = 0;
        for (let i = _ndLevelSamples.length - 1; i >= 0; i--) {
            const s = _ndLevelSamples[i];
            if (!s || !Number.isFinite(s.songT)) continue;
            if (s.songT > cnCenterVisualT + _ND_LEVEL_WIN_HALF) continue;
            if (s.songT < cnCenterVisualT - _ND_LEVEL_WIN_HALF) break;
            inWindow++;
            if (s.level > peakL) peakL = s.level;
        }
        return {
            levelAtLogPct,
            strikePeakPct: inWindow > 0 ? Math.round(peakL * 100) : null,
            strikeSamplesInWindow: inWindow,
            silenceWouldTrigger: inWindow > 0 && peakL < _ND_SILENCE_THRESHOLD,
        };
    }

    function _ndSnapshotEngineVerdict(v) {
        if (!v || typeof v !== 'object') return null;
        try {
            const snap = {};
            for (const k of Object.keys(v)) {
                const val = v[k];
                if (val === undefined || typeof val === 'function') continue;
                if (typeof val === 'number' && Number.isFinite(val)) snap[k] = val;
                else if (typeof val === 'boolean') snap[k] = val;
                else if (typeof val === 'string') snap[k] = val;
            }
            return Object.keys(snap).length ? snap : null;
        } catch (_) {
            return null;
        }
    }

    function _ndOpenDomainPitchFields() {
        let detected = null;
        let conf = null;
        try {
            if (detectedMidi >= 0 && detectedConfidence > detectionConfidenceMin) {
                detected = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
                conf = detectedConfidence;
            }
        } catch (_) { /* read-only */ }
        return { detectedMidi: detected, confidence: conf };
    }

    function _ndPushVerifierReject(entry) {
        try {
            const row = entry && typeof entry === 'object' ? entry : {};
            _ndVerifierRejects.push(row);
            while (_ndVerifierRejects.length > _ND_VERIFIER_REJECT_MAX) {
                _ndVerifierRejects.shift();
            }
        } catch (_) { /* never throw */ }
    }

    function _ndLogVerifierRejectOnce(dedupKey, partial) {
        try {
            if (!partial || typeof partial !== 'object') return;
            if (dedupKey && _ndRejectDedup.has(dedupKey)) return;
            const strikeCtx = Number.isFinite(partial.noteTime)
                ? _ndStrikeLevelContext(partial.noteTime)
                : _ndStrikeLevelContext(null);
            const levels = {
                levelPct: strikeCtx.levelAtLogPct,
                peakPct: strikeCtx.strikePeakPct,
            };
            const skipOpenPitch = !!partial.skipOpenDomainPitchFallback
                || partial.reason === 'NO_VERDICT'
                || partial.reason === 'SILENCE_GATE';
            const open = skipOpenPitch ? { detectedMidi: null, confidence: null } : _ndOpenDomainPitchFields();
            const row = {
                at: Date.now(),
                path: partial.path || _ndVerifierPathLabel(),
                reason: partial.reason || 'UNKNOWN',
                noteTime: Number.isFinite(partial.noteTime) ? partial.noteTime : null,
                string: Number.isInteger(partial.string) ? partial.string : null,
                fret: Number.isInteger(partial.fret) ? partial.fret : null,
                chord: !!partial.chord,
                expectedMidi: Number.isFinite(partial.expectedMidi) ? partial.expectedMidi : null,
                detectedMidi: Number.isFinite(partial.detectedMidi)
                    ? partial.detectedMidi
                    : open.detectedMidi,
                confidence: Number.isFinite(partial.confidence)
                    ? partial.confidence
                    : open.confidence,
                hitStrings: Number.isFinite(partial.hitStrings) ? partial.hitStrings : null,
                totalStrings: Number.isFinite(partial.totalStrings) ? partial.totalStrings : null,
                chordScore: Number.isFinite(partial.chordScore) ? partial.chordScore : null,
                timingErrorMs: Number.isFinite(partial.timingErrorMs) ? partial.timingErrorMs : null,
                pitchErrorCents: Number.isFinite(partial.pitchErrorCents) ? partial.pitchErrorCents : null,
                inputLevelPct: Number.isFinite(partial.inputLevelPct)
                    ? partial.inputLevelPct
                    : levels.levelPct,
                inputPeakPct: Number.isFinite(partial.inputPeakPct)
                    ? partial.inputPeakPct
                    : levels.peakPct,
                // Enriched engine-verifier context (read-only telemetry).
                verifierId: typeof partial.verifierId === 'string' ? partial.verifierId : null,
                playheadAudio: Number.isFinite(partial.playheadAudio) ? partial.playheadAudio : null,
                engineDetected: typeof partial.engineDetected === 'boolean' ? partial.engineDetected : null,
                engineDetectedRaw: typeof partial.engineDetectedRaw === 'boolean'
                    ? partial.engineDetectedRaw
                    : null,
                detectedSongTime: Number.isFinite(partial.detectedSongTime)
                    ? partial.detectedSongTime
                    : null,
                silenceGateApplied: !!partial.silenceGateApplied,
                strikePeakPct: Number.isFinite(partial.strikePeakPct)
                    ? partial.strikePeakPct
                    : levels.peakPct,
                strikeSamplesInWindow: Number.isFinite(partial.strikeSamplesInWindow)
                    ? partial.strikeSamplesInWindow
                    : strikeCtx.strikeSamplesInWindow,
                inputLevelAtLogPct: Number.isFinite(partial.inputLevelAtLogPct)
                    ? partial.inputLevelAtLogPct
                    : levels.levelPct,
                rendererPitchPolled: partial.rendererPitchPolled !== undefined
                    ? !!partial.rendererPitchPolled
                    : !_ndUsingEngineVerifier,
                engineVerdict: partial.engineVerdict && typeof partial.engineVerdict === 'object'
                    ? { ...partial.engineVerdict }
                    : null,
            };
            _ndPushVerifierReject(row);
            if (dedupKey) _ndRejectDedup.add(dedupKey);
        } catch (_) { /* never throw */ }
    }

    function _ndRejectReasonFromJudgment(judgment) {
        if (!judgment) return 'UNKNOWN';
        if (judgment.chord) return 'CHORD_RATIO_FAIL';
        if (judgment.timingState === 'EARLY' || judgment.timingState === 'LATE') return 'TIMING_FAIL';
        if (judgment.pitchState === 'SHARP' || judgment.pitchState === 'FLAT') return 'PITCH_FAIL';
        if (judgment.detectedMidi == null) return 'RETIRE_NO_MATCH';
        return 'UNKNOWN';
    }

    function _ndLogVerifierRejectFromJudgmentIfNew(key, judgment) {
        try {
            if (!key || _ndRejectDedup.has(key)) return;
            const cn = judgment.chartNote || judgment.note || {};
            _ndLogVerifierRejectOnce(key, {
                reason: _ndRejectReasonFromJudgment(judgment),
                noteTime: Number.isFinite(judgment.noteTime) ? judgment.noteTime : null,
                string: Number.isInteger(cn.s) ? cn.s : null,
                fret: Number.isInteger(cn.f) ? cn.f : null,
                chord: !!judgment.chord,
                expectedMidi: Number.isFinite(judgment.expectedMidi) ? judgment.expectedMidi : null,
                detectedMidi: Number.isFinite(judgment.detectedMidi) ? judgment.detectedMidi : null,
                confidence: Number.isFinite(judgment.confidence) ? judgment.confidence : null,
                hitStrings: Number.isFinite(judgment.hitStrings) ? judgment.hitStrings : null,
                totalStrings: Number.isFinite(judgment.totalStrings) ? judgment.totalStrings : null,
                chordScore: Number.isFinite(judgment.score) ? judgment.score : null,
                timingErrorMs: Number.isFinite(judgment.timingError) ? judgment.timingError : null,
                pitchErrorCents: Number.isFinite(judgment.pitchError) ? judgment.pitchError : null,
            });
        } catch (_) { /* never throw */ }
    }

    function getVerifierRejects() {
        try {
            return _ndVerifierRejects.map((e) => ({ ...e }));
        } catch (_) {
            return [];
        }
    }

    // ── Detection Health (read-only gear popover) ─────────────────────
    function _ndFormatMs(n) {
        if (n == null || !Number.isFinite(n)) return '—';
        const r = Math.round(n);
        return (r >= 0 ? '+' + r : String(r)) + ' ms';
    }

    function _ndFormatPercent(ratio) {
        if (ratio == null || !Number.isFinite(ratio)) return '—';
        return Math.round(ratio * 100) + '%';
    }

    // ── Musician-facing display helpers (copy only — no detection changes) ──
    function _ndMusicianRejectHint(reason) {
        const hints = {
            NO_VERDICT: 'No detection at note time',
            SILENCE_GATE: 'Input too quiet when the note struck',
            STRING_VERIFY_FAIL: 'Something was heard but did not verify',
            CHORD_RATIO_FAIL: 'Not enough strings heard for the chord',
            TIMING_FAIL: 'Played outside the timing window',
            PITCH_FAIL: 'Pitch was outside the allowed window',
            RETIRE_NO_MATCH: 'No match before the note ended',
            UNKNOWN: 'Could not verify this note',
        };
        return hints[reason] || hints.UNKNOWN;
    }

    function _ndFormatMusicianRejectLine(r) {
        if (!r || typeof r !== 'object') return '—';
        const parts = [_ndMusicianRejectHint(r.reason)];
        if (Number.isFinite(r.hitStrings) && Number.isFinite(r.totalStrings)) {
            parts.push(`${r.hitStrings} of ${r.totalStrings} strings heard`);
        } else if (Number.isInteger(r.string) && Number.isInteger(r.fret)) {
            parts.push(`string ${r.string + 1}, fret ${r.fret}`);
        }
        const strikePeak = Number.isFinite(r.strikePeakPct)
            ? r.strikePeakPct
            : (Number.isFinite(r.inputPeakPct) ? r.inputPeakPct : null);
        if (Number.isFinite(strikePeak)) {
            parts.push(`signal at strike ${strikePeak}%`);
        }
        if (Number.isFinite(r.timingErrorMs)) {
            const te = Math.round(r.timingErrorMs);
            parts.push(te >= 0 ? `${te} ms late` : `${Math.abs(te)} ms early`);
        }
        return parts.join(' · ');
    }

    function _ndHealthHearingForPanel() {
        const line = _ndHealthDetectedLine();
        if (line !== '—') return line;
        if (!enabled) {
            return 'Nothing yet — turn Detect on, then play a note or chord';
        }
        return 'Nothing yet — play a note or chord (stays blank when input is quiet)';
    }

    // _calWizardNoiseStatusDisplay/_calWizardSignalStatusDisplay: moved to
    // calibration-wizard.js (nd-carve-8). Technique Assessment does not use them.

    function _calLabDominantFailLabel(fail) {
        if (fail === 'SNR') return 'signal clarity';
        if (fail === 'FUND') return 'main note';
        if (fail === 'PITCH') return 'tuning match';
        return fail || '—';
    }

    function _calLabGateChipsHtml(tick) {
        if (!tick || typeof tick !== 'object') return '';
        const chip = (label, ok) => {
            const cls = ok ? 'text-green-300/90' : 'text-amber-200/90';
            const mark = ok ? '✓' : '✗';
            return `<span class="${cls}">${label}${mark}</span>`;
        };
        const snrOk = !!tick.passedSnr || (tick.gatePassCount >= 1 && !(tick.failedGateMask & 1));
        const fundOk = !!tick.passedFundamental || (tick.gatePassCount >= 2 && !(tick.failedGateMask & 2));
        const pitchOk = !!tick.passedPitch || tick.gatePassCount === 3;
        if (tick.passedSnr === undefined && tick.gatePassCount != null) {
            return `<span class="text-[9px] font-mono flex gap-1.5">`
                + chip('Clarity', (tick.failedGateMask & 1) === 0 && tick.gatePassCount >= 1)
                + chip('Main note', (tick.failedGateMask & 2) === 0 && tick.gatePassCount >= 2)
                + chip('Tuning', tick.gatePassCount === 3)
                + '</span>';
        }
        return `<span class="text-[9px] font-mono flex gap-1.5">`
            + chip('Clarity', snrOk) + chip('Main note', fundOk) + chip('Tuning', pitchOk)
            + '</span>';
    }

    function _ndDominantMissReason(breakdown, totalMisses) {
        if (!breakdown || !totalMisses || totalMisses <= 0) return null;
        const labels = {
            pure: 'no note heard',
            chordPartial: 'partial chord',
            early: 'played too early',
            late: 'played too late',
            sharp: 'pitch too sharp',
            flat: 'pitch too flat',
        };
        let bestKey = null;
        let bestVal = 0;
        for (const k of Object.keys(labels)) {
            const v = breakdown[k] || 0;
            if (v > bestVal) { bestVal = v; bestKey = k; }
        }
        if (!bestKey || bestVal === 0) return null;
        return { key: bestKey, label: labels[bestKey], count: bestVal };
    }

    function _ndDetectionHealthHint(d, totalJudgments) {
        if (inputLevel > 0.85) {
            return 'Signal is hot — reduce input gain.';
        }
        if (!totalJudgments || totalJudgments < 5) {
            return 'Not enough hits yet — play a few notes to collect data.';
        }
        const misses = (d && d.summary) ? (d.summary.misses || 0) : 0;
        const bk = (d && d.miss_breakdown) ? d.miss_breakdown : {};
        const teHits = (d && d.timing_error_ms_hits) ? d.timing_error_ms_hits : {};
        const median = teHits.median;
        const dom = _ndDominantMissReason(bk, misses);
        if (dom) {
            if (dom.key === 'late' || (Number.isFinite(median) && median > 25)) {
                return 'Mostly late hits — timing offset may need calibration.';
            }
            if (dom.key === 'early' || (Number.isFinite(median) && median < -25)) {
                return 'Mostly early hits — timing offset may need calibration.';
            }
            if (dom.key === 'pure') {
                return 'Many pure misses — check input channel, gain, or detector confidence.';
            }
            if (dom.key === 'chordPartial') {
                return 'Many chord partials — chord detection may be hearing only part of the chord.';
            }
            if (dom.key === 'sharp' || dom.key === 'flat') {
                return 'Many pitch misses — check tuning, capo, or pitch tolerance.';
            }
        }
        if (Number.isFinite(median) && Math.abs(median) >= 20) {
            return 'Timing median is off — try the Calibration Wizard timing step or adjust chart sync (A/V offset) in main Settings.';
        }
        return null;
    }

    function _ndHealthDetectedLine() {
        if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
            const displayMidi = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
            const name = Number.isFinite(displayMidi) ? _ndMidiToName(displayMidi) : '—';
            const confPct = Math.round(detectedConfidence * 100);
            return `${name} · string ${detectedString} fret ${detectedFret} · ${confPct}% conf`;
        }
        const currentHw = resolveHw();
        if (lastChordScore !== null && currentHw && typeof currentHw.getTime === 'function') {
            const songTime = currentHw.getTime() - latencyOffset
                + (currentHw.getAvOffset ? currentHw.getAvOffset() / 1000 : 0);
            if (songTime - lastChordTime <= 1.5) {
                const pct = Math.round(lastChordScore * 100);
                return `Chord ${lastChordHit}/${lastChordTotal} strings (${pct}%)`;
            }
        }
        return '—';
    }

    function _ndHealthInputChannelLabel() {
        if (selectedChannel === 'left') return 'Left (Ch 1)';
        if (selectedChannel === 'right') return 'Right (Ch 2)';
        return 'Mono';
    }

    function _ndHealthDetectorPathLabel() {
        if (usingDesktopBridge) return 'Desktop audio engine';
        const _dd = _diagCatalog && _diagCatalog.getDiagDetector();
        if (_dd && _dd.path) return String(_dd.path);
        return 'Browser microphone';
    }

    function renderDetectionHealth(panel) {
        if (!panel) return;
        const set = (sel, text) => {
            const el = panel.querySelector(sel);
            if (el) el.textContent = text;
        };
        let d;
        try {
            d = _diagCatalog.buildDiagnosticPayload();
        } catch (e) {
            d = null;
        }
        const summary = (d && d.summary) ? d.summary : {};
        const total = summary.total || 0;
        const hitsN = summary.hits || 0;
        const missesN = summary.misses || 0;
        const methodLabel = detectionMethod === 'crepe' && _ndShared.modelLoading
            ? `${detectionMethod} (loading…)`
            : (detectionMethod || '—');
        const sr = audioCtx && audioCtx.sampleRate
            ? Math.round(audioCtx.sampleRate)
            : (bridgeSampleRate ? Math.round(bridgeSampleRate) : null);
        const avMs = (resolveHw() && resolveHw().getAvOffset)
            ? resolveHw().getAvOffset()
            : null;
        const teHits = (d && d.timing_error_ms_hits) ? d.timing_error_ms_hits : {};
        const dom = _ndDominantMissReason((d && d.miss_breakdown) ? d.miss_breakdown : {}, missesN);
        const levelPct = Math.round((inputLevel || 0) * 100);
        let levelNote = `${levelPct}%`;
        if (inputLevel > 0.85) levelNote += ' (hot)';
        else if (inputLevel < 0.02) levelNote += ' (quiet)';

        set('.nd-health-status',
            enabled
                ? `● Running · ${methodLabel} · ${_ndHealthDetectorPathLabel()}`
                : '○ Detect is off');
        set('.nd-health-input',
            `Input: ${_ndHealthInputChannelLabel()}`
            + (sr ? ` · ${sr} Hz` : '')
            + (selectedDeviceId ? '' : ' · default device'));
        set('.nd-health-hearing', `Now hearing: ${_ndHealthHearingForPanel()}`);
        set('.nd-health-session',
            total > 0
                ? `This song: ${hitsN} hits · ${missesN} misses · ${_ndFormatPercent(summary.accuracy)}`
                : 'This song: Not enough data yet');
        set('.nd-health-top-miss',
            dom
                ? `Most common miss: ${dom.label} (${dom.count})`
                : (missesN > 0 ? 'Most common miss: —' : 'Most common miss: none yet'));
        const timingMed = teHits.median;
        set('.nd-health-align',
            `Sync: chart/video offset ${_ndFormatMs(avMs)} · detection delay ${Math.round(latencyOffset * 1000)} ms`
            + (Number.isFinite(timingMed)
                ? ` · your hits average ${_ndFormatMs(timingMed)} vs chart`
                : ' · your hits: not enough data yet'));
        set('.nd-health-level', `Input level: ${levelNote}`);
        let rejectLines = '—';
        try {
            const recent = _ndVerifierRejects.slice(-3).reverse();
            if (recent.length > 0) {
                rejectLines = recent.map(_ndFormatMusicianRejectLine).join('\n');
            }
        } catch (_) { /* read-only */ }
        set('.nd-health-rejects', rejectLines);
        const hint = _ndDetectionHealthHint(d, total);
        set('.nd-health-hint', hint ? `Tip: ${hint}` : 'Tip: —');
    }

    // Shared formatting helper — used by the wizard (via DI) AND Technique Assessment below.
    function calibrationFormatLevel(levelPct, peakPct) {
        const l = Number.isFinite(levelPct) ? Math.round(levelPct) : 0;
        const p = Number.isFinite(peakPct) ? Math.round(peakPct) : l;
        let s = `${l}%`;
        if (p > l) s += ` (peak ${p}%)`;
        if (l > 85) s += ' — hot';
        else if (l < 2) s += ' — quiet';
        return s;
    }

    // ── Calibration Wizard v2 (nd-carve-8: moved to calibration-wizard.js) ─────
    // Delegation wrappers — all implementation in _calWizard instance.
    // (Original wizard code: main.js lines 6408–8646, git pre-carve-8)

    function openCalibrationWizard()   { return _calWizard.openCalibrationWizard(); }
    function calibrationWizardClose()  { return _calWizard.calibrationWizardClose(); }
    function calibrationWizardNext()   { return _calWizard.calibrationWizardNext(); }
    function calibrationWizardBack()   { return _calWizard.calibrationWizardBack(); }
    function getCalibrationSnapshot()  { return _calWizard.getCalibrationSnapshot(); }
    function launchCalibration(opts)   { return _calWizard.launchCalibration(opts); }

    // ── Technique Assessment (Phase 1 — diagnostic only; was Instrument Calibration Lab) ──
    // Read-only guided probes via scoreChord harmonicVerify. Does NOT
    // change thresholds, scoring, latency, or apply settings.
    let _calLabEl = null;
    let _calLabTick = null;
    let _calLabState = null;
    let _calLabLastReport = null;

    const _CAL_LAB_FAIL = { SNR: 1, FUND: 2, PITCH: 4 };
    const _CAL_LAB_SCHEMA = 'note_detect.calibration_report.v1';
    const _CAL_LAB_MIN_CAPTURES = 3;
    const _CAL_LAB_POWER_CHORD_NOTES = [
        { s: 0, f: 0, role: 'root' },
        { s: 1, f: 2, role: 'fifth' },
    ];
    const _CAL_LAB_ADVANCED_ONLY_STEP_IDS = new Set([
        'picked', 'hammerOn', 'pullOff', 'palmMute',
        'naturalHarmonic', 'pinchHarmonic', 'halfBend', 'wholeBend', 'sustain',
    ]);
    const _CAL_LAB_BASIC_OPEN_ROWS = [
        { s: 0, f: 0, prompt: 'Play the thickest string open', btn: 'Capture thickest string' },
        { s: 1, f: 0, prompt: 'Play the next string open', btn: 'Capture next string' },
    ];
    const _CAL_LAB_BASIC_FRET_ROWS = [
        { s: 0, f: 5, prompt: 'Play the thickest string at the 5th fret', btn: 'Capture thickest string, 5th fret' },
    ];
    const _CAL_LAB_AUTO_NOISE_MS = 1800;
    const _CAL_LAB_AUTO_SIGNAL_MS = 2000;
    const _CAL_LAB_AUTO_PROBE_LISTEN_MS = 7000;
    const _CAL_LAB_AUTO_PROBE_INTERVAL_MS = 600;
    const _CAL_LAB_AUTO_PWR_LISTEN_MS = 8000;
    const _CAL_LAB_AUTO_PWR_INTERVAL_MS = 700;

    function _calLabDefaultAutoRun() {
        return {
            active: false,
            phase: 'idle',
            stepId: null,
            subIndex: 0,
            status: null,
            timerId: null,
            intervalId: null,
            inFlight: false,
            capturesThisRun: 0,
            startedAt: 0,
            listenEndsAt: 0,
            sessionId: 0,
        };
    }

    function _calLabEnsureAutoRun(st) {
        if (!st.autoRun) st.autoRun = _calLabDefaultAutoRun();
        return st.autoRun;
    }

    function _calLabStopAutoCapture(reason) {
        const st = _calLabState;
        if (!st) return;
        const ar = st.autoRun;
        if (!ar) return;
        if (ar.timerId != null) {
            clearTimeout(ar.timerId);
            ar.timerId = null;
        }
        if (ar.intervalId != null) {
            clearInterval(ar.intervalId);
            ar.intervalId = null;
        }
        ar.inFlight = false;
        if (ar.phase === 'countdown' || ar.phase === 'listening') {
            ar.phase = 'idle';
        }
        ar.active = false;
        if (reason) ar.status = reason;
    }

    function _calLabSetAutoStatus(html) {
        if (!_calLabEl) return;
        const el = _calLabEl.querySelector('.nd-cal-lab-auto-status');
        if (el) el.innerHTML = html;
    }

    function _calLabIsAutoBusy(st) {
        const ar = st && st.autoRun;
        return !!(ar && ar.active && (ar.phase === 'countdown' || ar.phase === 'listening'));
    }

    function _calLabBeginCountdownThen(seconds, label, callback) {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        if (ar.timerId != null) clearTimeout(ar.timerId);
        ar.active = true;
        ar.phase = 'countdown';
        let left = seconds;
        const tick = () => {
            if (!_calLabState || _calLabState !== st || !ar.active) return;
            const n = left > 0 ? String(left) : 'Go!';
            _calLabSetAutoStatus(
                `<p class="text-gray-200 text-sm mb-1">${label}</p>`
                + `<p class="text-2xl font-bold text-white text-center py-2">${n}</p>`);
            if (left <= 0) {
                ar.timerId = null;
                ar.phase = 'listening';
                callback();
                return;
            }
            left -= 1;
            ar.timerId = setTimeout(tick, 1000);
        };
        tick();
    }

    function _calLabAvgLevelSamples(samples) {
        if (!samples || !samples.length) return { avg: null, peak: null };
        let sum = 0;
        let maxPeak = 0;
        for (const s of samples) {
            sum += s.level;
            if (s.peak > maxPeak) maxPeak = s.peak;
        }
        return { avg: Math.round(sum / samples.length), peak: maxPeak };
    }

    function _calLabRunLevelSampler(durationMs, onDone) {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        const sessionId = ar.sessionId;
        const samples = [];
        const started = Date.now();
        ar.startedAt = started;
        ar.listenEndsAt = started + durationMs;
        if (ar.intervalId != null) clearInterval(ar.intervalId);
        if (ar.timerId != null) clearTimeout(ar.timerId);
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (ar.intervalId != null) {
                clearInterval(ar.intervalId);
                ar.intervalId = null;
            }
            if (ar.timerId != null) {
                clearTimeout(ar.timerId);
                ar.timerId = null;
            }
            ar.inFlight = false;
            onDone(samples, sessionId);
        };
        const tick = () => {
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId || !ar.active) return;
            const snap = getCalibrationSnapshot();
            samples.push({ level: snap.inputLevelPct, peak: snap.inputPeakPct, t: Date.now() });
            const elapsed = Date.now() - started;
            _calLabSetAutoStatus(
                `<span class="text-cyan-300/90">Listening…</span> ${Math.round(elapsed / 1000)}s · `
                + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct));
            if (elapsed >= durationMs) finish();
        };
        tick();
        ar.intervalId = setInterval(tick, 120);
        ar.timerId = setTimeout(finish, durationMs + 250);
    }

    function _calLabProbeCountForStep(st, opts) {
        const { store, noteDef, technique, multiNotes } = opts;
        if (multiNotes) {
            return ((st.techniqueCaptures && st.techniqueCaptures[technique]) || []).length;
        }
        const caps = (st[store] && st[store][noteDef.s]) || [];
        return caps.length;
    }

    function _calLabStoreProbeCapture(st, opts, cap) {
        if (!cap || !cap.ok) return false;
        const { store, noteDef, technique, multiNotes } = opts;
        if (multiNotes) {
            if (!st.techniqueCaptures) st.techniqueCaptures = {};
            if (!st.techniqueCaptures[technique]) st.techniqueCaptures[technique] = [];
            st.techniqueCaptures[technique].push(cap);
            return true;
        }
        if (!st[store]) st[store] = {};
        if (!st[store][noteDef.s]) st[store][noteDef.s] = [];
        st[store][noteDef.s].push(cap);
        return true;
    }

    function _calLabRunProbeListenWindow(opts) {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        const sessionId = ar.sessionId;
        const listenMs = opts.listenMs || _CAL_LAB_AUTO_PROBE_LISTEN_MS;
        const intervalMs = opts.intervalMs || _CAL_LAB_AUTO_PROBE_INTERVAL_MS;
        const minCaptures = opts.minCaptures || _CAL_LAB_MIN_CAPTURES;
        ar.phase = 'listening';
        ar.active = true;
        ar.startedAt = Date.now();
        ar.listenEndsAt = ar.startedAt + listenMs;
        ar.capturesThisRun = 0;

        let ended = false;
        const endWindow = (reason) => {
            if (ended) return;
            ended = true;
            if (ar.intervalId != null) {
                clearInterval(ar.intervalId);
                ar.intervalId = null;
            }
            if (ar.timerId != null) {
                clearTimeout(ar.timerId);
                ar.timerId = null;
            }
            ar.inFlight = false;
            ar.active = false;
            ar.phase = reason === 'stop' ? 'idle' : 'done';
            if (opts.onComplete) opts.onComplete(reason);
        };

        const tryCapture = async () => {
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId || !ar.active) return;
            if (ar.inFlight || Date.now() >= ar.listenEndsAt) return;
            ar.inFlight = true;
            let cap;
            try {
                if (opts.multiNotes) {
                    cap = await _calLabCaptureMulti(opts.multiNotes, opts.technique);
                } else {
                    cap = await _calLabCaptureProbe(opts.noteDef, opts.technique || opts.store);
                }
            } catch (_) {
                cap = null;
            }
            ar.inFlight = false;
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId) return;
            if (_calLabStoreProbeCapture(st, opts, cap)) {
                ar.capturesThisRun = _calLabProbeCountForStep(st, opts);
            }
            const count = _calLabProbeCountForStep(st, opts);
            const shortLabel = opts.shortLabel || opts.label || 'check';
            _calLabSetAutoStatus(
                `<span class="text-cyan-300/90">${shortLabel}</span> — ${count} of ${minCaptures} captures`);
            if (opts.onProgress) opts.onProgress(count);
            if (count >= minCaptures) endWindow('enough');
        };

        const tick = () => {
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId || !ar.active) return;
            if (Date.now() >= ar.listenEndsAt) {
                endWindow('timeout');
                return;
            }
            tryCapture();
        };

        const count = _calLabProbeCountForStep(st, opts);
        _calLabSetAutoStatus(
            `<span class="text-cyan-300/90">${opts.shortLabel || opts.label}</span> — ${count} of ${minCaptures} captures`);
        tick();
        ar.intervalId = setInterval(tick, intervalMs);
        ar.timerId = setTimeout(() => endWindow('timeout'), listenMs + 300);
    }

    function _calLabBasicAutoControlsHtml(stepKey, startLabel, busy, showRetry) {
        const hideStart = busy ? 'hidden' : '';
        const hideStop = busy ? '' : 'hidden';
        const hideRetry = showRetry && !busy ? '' : 'hidden';
        return `<div class="nd-cal-lab-auto-controls flex flex-col gap-2 mb-2">
            <button type="button" class="nd-cal-lab-auto-start ${hideStart} w-full py-2.5 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white" data-auto-step="${stepKey}">${startLabel}</button>
            <button type="button" class="nd-cal-lab-auto-retry ${hideRetry} w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200" data-auto-step="${stepKey}">Retry</button>
            <button type="button" class="nd-cal-lab-auto-stop ${hideStop} w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-amber-200/90" data-auto-step="${stepKey}">Stop</button>
        </div>`;
    }

    function _calLabUpdateBasicAutoButtons() {
        if (!_calLabEl || !_calLabState) return;
        const busy = _calLabIsAutoBusy(_calLabState);
        const start = _calLabEl.querySelector('.nd-cal-lab-auto-start');
        const retry = _calLabEl.querySelector('.nd-cal-lab-auto-retry');
        const stop = _calLabEl.querySelector('.nd-cal-lab-auto-stop');
        if (start) start.classList.toggle('hidden', busy);
        if (stop) stop.classList.toggle('hidden', !busy);
        if (retry) {
            const done = _calLabState.autoRun && _calLabState.autoRun.phase === 'done';
            retry.classList.toggle('hidden', busy || !done);
        }
        const nextBtn = _calLabEl.querySelector('.nd-cal-lab-next');
        if (nextBtn) nextBtn.disabled = busy;
    }

    function _calLabClearBasicOpenCaptures(st) {
        st.openCaptures = {};
    }

    function _calLabClearBasicFretCaptures(st) {
        st.fretCaptures = {};
    }

    function _calLabClearBasicPowerCaptures(st) {
        if (!st.techniqueCaptures) st.techniqueCaptures = {};
        st.techniqueCaptures.powerChord = [];
    }

    function _calLabStartNoiseAuto() {
        const st = _calLabState;
        if (!st) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'noise';
        ar.sessionId = Date.now();
        ar.active = true;
        _calLabBeginCountdownThen(3, 'Get ready: mute all strings', () => {
            _calLabSetAutoStatus('<span class="text-cyan-300/90">Listening for room noise…</span>');
            _calLabRunLevelSampler(_CAL_LAB_AUTO_NOISE_MS, (samples, sessionId) => {
                if (!_calLabState || _calLabState.autoRun.sessionId !== sessionId) return;
                const { avg, peak } = _calLabAvgLevelSamples(samples);
                if (!Number.isFinite(avg)) {
                    st.autoRun.phase = 'error';
                    st.autoRun.active = false;
                    _calLabSetAutoStatus('<span class="text-amber-200/90">No samples — turn Detect on and retry.</span>');
                    _calLabUpdateBasicAutoButtons();
                    return;
                }
                st.noiseLevelPct = avg;
                st.noisePeakPct = peak;
                st.autoRun.phase = 'done';
                st.autoRun.active = false;
                const resultEl = _calLabEl && _calLabEl.querySelector('.nd-cal-lab-auto-result');
                if (resultEl) {
                    resultEl.textContent = calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct);
                }
                _calLabSetAutoStatus(
                    `<span class="text-green-300/90">Noise check complete:</span> `
                    + calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct));
                _calLabUpdateBasicAutoButtons();
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabStartSignalAuto() {
        const st = _calLabState;
        if (!st) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'signal';
        ar.sessionId = Date.now();
        ar.active = true;
        _calLabBeginCountdownThen(3, 'Get ready: play the thickest string loudly', () => {
            _calLabSetAutoStatus('<span class="text-cyan-300/90">Listening for playing level…</span>');
            _calLabRunLevelSampler(_CAL_LAB_AUTO_SIGNAL_MS, (samples, sessionId) => {
                if (!_calLabState || _calLabState.autoRun.sessionId !== sessionId) return;
                const { avg, peak } = _calLabAvgLevelSamples(samples);
                if (!Number.isFinite(avg)) {
                    st.autoRun.phase = 'error';
                    st.autoRun.active = false;
                    _calLabSetAutoStatus('<span class="text-amber-200/90">No samples — turn Detect on and retry.</span>');
                    _calLabUpdateBasicAutoButtons();
                    return;
                }
                st.signalLevelPct = avg;
                st.signalPeakPct = peak;
                st.autoRun.phase = 'done';
                st.autoRun.active = false;
                const resultEl = _calLabEl && _calLabEl.querySelector('.nd-cal-lab-auto-result');
                if (resultEl) {
                    resultEl.textContent = calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct);
                }
                _calLabSetAutoStatus(
                    `<span class="text-green-300/90">Signal check complete:</span> `
                    + calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct));
                _calLabUpdateBasicAutoButtons();
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabRunOpenSubPrompt() {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        const rows = _CAL_LAB_BASIC_OPEN_ROWS;
        if (ar.subIndex >= rows.length) {
            ar.phase = 'done';
            ar.active = false;
            _calLabSetAutoStatus('<span class="text-green-300/90">Open-string check complete.</span>');
            _calLabUpdateBasicAutoButtons();
            renderCalibrationLab();
            return;
        }
        const row = rows[ar.subIndex];
        const shortLabel = ar.subIndex === 0 ? 'Checking thickest string open' : 'Checking next string open';
        _calLabBeginCountdownThen(3, `Get ready: ${row.prompt}`, () => {
            _calLabRunProbeListenWindow({
                store: 'openCaptures',
                noteDef: { s: row.s, f: row.f },
                technique: 'openCaptures',
                label: row.prompt,
                shortLabel,
                listenMs: _CAL_LAB_AUTO_PROBE_LISTEN_MS,
                intervalMs: _CAL_LAB_AUTO_PROBE_INTERVAL_MS,
                minCaptures: _CAL_LAB_MIN_CAPTURES,
                onComplete: () => {
                    if (!_calLabState) return;
                    ar.subIndex += 1;
                    if (ar.subIndex < rows.length) {
                        _calLabRunOpenSubPrompt();
                    } else {
                        ar.phase = 'done';
                        ar.active = false;
                        _calLabSetAutoStatus('<span class="text-green-300/90">Open-string check complete.</span>');
                        _calLabUpdateBasicAutoButtons();
                        renderCalibrationLab();
                    }
                },
            });
        });
    }

    function _calLabStartOpenAuto(clearFirst) {
        const st = _calLabState;
        if (!st) return;
        if (!_calLabCanProbe()) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on (desktop) first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        if (clearFirst) _calLabClearBasicOpenCaptures(st);
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'open';
        ar.sessionId = Date.now();
        ar.subIndex = 0;
        ar.active = true;
        _calLabRunOpenSubPrompt();
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabStartFretAuto(clearFirst) {
        const st = _calLabState;
        if (!st) return;
        if (!_calLabCanProbe()) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on (desktop) first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        if (clearFirst) _calLabClearBasicFretCaptures(st);
        const row = _CAL_LAB_BASIC_FRET_ROWS[0];
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'fret5';
        ar.sessionId = Date.now();
        ar.subIndex = 0;
        ar.active = true;
        _calLabBeginCountdownThen(3, `Get ready: ${row.prompt}`, () => {
            _calLabRunProbeListenWindow({
                store: 'fretCaptures',
                noteDef: { s: row.s, f: row.f },
                technique: 'fretCaptures',
                label: row.prompt,
                shortLabel: 'Checking thickest string, 5th fret',
                listenMs: _CAL_LAB_AUTO_PROBE_LISTEN_MS,
                intervalMs: _CAL_LAB_AUTO_PROBE_INTERVAL_MS,
                minCaptures: _CAL_LAB_MIN_CAPTURES,
                onComplete: () => {
                    if (!_calLabState) return;
                    ar.phase = 'done';
                    ar.active = false;
                    _calLabSetAutoStatus('<span class="text-green-300/90">Fretted-note check complete.</span>');
                    _calLabUpdateBasicAutoButtons();
                    renderCalibrationLab();
                },
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    // Resolve the concrete power chord the technique check asks for, so the
    // instruction can name the notes (tester feedback: couldn't tell it wanted
    // an E5). Power chord = thickest string open (root) + next string 2nd fret
    // (fifth). Reuses the wizard's tuning-aware resolver; falls back to the
    // standard-tuning E5 if no tuning/preset context is available.
    function _calLabPowerChordTargetLabel() {
        // Pure — resolve the two probe notes ({s0,f0} root + {s1,f2} fifth) under
        // the SAME live tuning the Lab scores against (currentArrangement /
        // currentStringCount / tuningOffsets / capo), so the named chord always
        // matches what's actually tested (standard guitar → E5; honors a loaded
        // song's tuning/capo). The "<root>5" chord name is only asserted when the
        // two notes really are a perfect fifth (7 semitones); exotic tunings
        // where the fixed s0f0+s1f2 shape isn't a fifth just name the two notes.
        // Falls back to standard-tuning E5 on any error.
        let root = 'E2', fifth = 'B2', chord = 'E5';
        try {
            if (currentStringCount >= 2) {
                const rootMidi = _ndMidiFromStringFret(0, 0, currentArrangement, currentStringCount, tuningOffsets, capo);
                const fifthMidi = _ndMidiFromStringFret(1, 2, currentArrangement, currentStringCount, tuningOffsets, capo);
                if (Number.isFinite(rootMidi) && Number.isFinite(fifthMidi)) {
                    root = _ndMidiToName(rootMidi);
                    fifth = _ndMidiToName(fifthMidi);
                    const interval = (((fifthMidi - rootMidi) % 12) + 12) % 12;
                    chord = interval === 7 ? String(root).replace(/-?\d+$/, '') + '5' : null;
                }
            }
        } catch (_) { /* keep standard-tuning fallback */ }
        const lead = chord ? `the ${chord} power chord` : 'the power chord';
        const leadHtml = chord
            ? `the <strong class="text-gray-100">${chord}</strong> power chord`
            : 'the power chord';
        return { chord, root, fifth, lead, leadHtml };
    }

    function _calLabStartPowerChordAuto(clearFirst) {
        const st = _calLabState;
        if (!st) return;
        if (!_calLabCanProbe()) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on (desktop) first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        if (clearFirst) _calLabClearBasicPowerCaptures(st);
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'powerChord';
        ar.sessionId = Date.now();
        ar.active = true;
        const pwr = _calLabPowerChordTargetLabel();
        _calLabBeginCountdownThen(3, `Get ready: play ${pwr.lead} (${pwr.root} open + next string 2nd fret = ${pwr.fifth})`, () => {
            _calLabRunProbeListenWindow({
                multiNotes: [{ s: 0, f: 0 }, { s: 1, f: 2 }],
                technique: 'powerChord',
                label: `Play ${pwr.lead}: ${pwr.root} open + ${pwr.fifth} (next string, 2nd fret)`,
                shortLabel: 'Power chord check',
                listenMs: _CAL_LAB_AUTO_PWR_LISTEN_MS,
                intervalMs: _CAL_LAB_AUTO_PWR_INTERVAL_MS,
                minCaptures: _CAL_LAB_MIN_CAPTURES,
                onProgress: () => {
                    const diagEl = _calLabEl && _calLabEl.querySelector('.nd-cal-lab-pwr-diag-live');
                    if (diagEl) diagEl.textContent = _calLabPowerChordSimpleDiagnosis(st);
                },
                onComplete: () => {
                    if (!_calLabState) return;
                    ar.phase = 'done';
                    ar.active = false;
                    _calLabSetAutoStatus(
                        `<span class="text-green-300/90">Power chord check complete.</span> `
                        + _calLabPowerChordSimpleDiagnosis(st));
                    _calLabUpdateBasicAutoButtons();
                    renderCalibrationLab();
                },
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabRetryBasicAuto(stepKey) {
        if (stepKey === 'noise') _calLabStartNoiseAuto();
        else if (stepKey === 'signal') _calLabStartSignalAuto();
        else if (stepKey === 'open') _calLabStartOpenAuto(true);
        else if (stepKey === 'fret5') _calLabStartFretAuto(true);
        else if (stepKey === 'powerChord') _calLabStartPowerChordAuto(true);
    }

    function _calLabEffectivePitchTol(chartPitch, flags) {
        let cents = chartPitch;
        if (flags && (flags.b || flags.sl)) cents = Math.max(cents, 100);
        if (flags && flags.hm) cents = 0;
        return cents;
    }

    function _calLabTickFromResult(r, flags) {
        const harmonicSnr = _ND_VERIFY_HARMONIC_SNR;
        const snr = Number.isFinite(r && r.bandEnergy) ? r.bandEnergy : 0;
        const pitchTol = _calLabEffectivePitchTol(pitchTolerance, flags || {});
        const passedSnr = snr >= harmonicSnr;
        const passedFund = !!(r && r.fundamentalPresent);
        const absCents = (r && Number.isFinite(r.centsError)) ? Math.abs(r.centsError) : null;
        const passedPitch = pitchTol <= 0
            || (absCents != null && absCents <= pitchTol);
        const gatePassCount = (passedSnr ? 1 : 0) + (passedFund ? 1 : 0) + (passedPitch ? 1 : 0);
        let failedMask = 0;
        if (!passedSnr) failedMask |= _CAL_LAB_FAIL.SNR;
        if (!passedFund) failedMask |= _CAL_LAB_FAIL.FUND;
        if (!passedPitch) failedMask |= _CAL_LAB_FAIL.PITCH;
        const snrRatio = harmonicSnr > 0 ? snr / harmonicSnr : snr;
        return {
            snr,
            snrRatio,
            harmonicSnrUsed: harmonicSnr,
            fundamentalRatio: Number.isFinite(r && r.fundamentalRatio) ? r.fundamentalRatio : null,
            centsError: Number.isFinite(r && r.centsError) ? r.centsError : null,
            absCentsError: absCents,
            passedSnr,
            passedFundamental: passedFund,
            passedPitch,
            gatePassCount,
            failedGateMask: failedMask,
            hit: !!(r && r.hit),
        };
    }

    function _calLabMedian(arr) {
        if (!arr.length) return null;
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    function _calLabAvg(arr) {
        return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    }

    function _calLabPowerChordDisplayString(stringIndex) {
        return currentStringCount - stringIndex;
    }

    function _calLabPowerChordNoteMeta(stringIndex, fret) {
        const def = _CAL_LAB_POWER_CHORD_NOTES.find((n) => n.s === stringIndex && n.f === fret);
        const disp = _calLabPowerChordDisplayString(stringIndex);
        let label;
        if (def && def.role === 'root') label = 'thickest string (root)';
        else if (def && def.role === 'fifth') label = 'next string (fifth)';
        else label = `String ${disp}`;
        let expectedNote = '—';
        try {
            const midi = _ndMidiFromStringFret(
                stringIndex, fret, currentArrangement, currentStringCount, tuningOffsets, capo);
            if (Number.isFinite(midi)) expectedNote = _ndMidiToName(midi);
        } catch (_) { /* read-only */ }
        return {
            label,
            role: def ? def.role : null,
            expectedNote,
            string: stringIndex,
            fret,
        };
    }

    function _calLabPowerChordNotePass(noteTick) {
        return !!(noteTick && (noteTick.hit || noteTick.gatePassCount === 3));
    }

    function _calLabPowerChordHeardNote(noteTick) {
        if (!noteTick || !Number.isFinite(noteTick.centsError)) return '—';
        try {
            const expectedMidi = _ndMidiFromStringFret(
                noteTick.string, noteTick.fret, currentArrangement, currentStringCount, tuningOffsets, capo);
            if (!Number.isFinite(expectedMidi)) return '—';
            return _ndMidiToName(expectedMidi + noteTick.centsError / 100);
        } catch (_) {
            return '—';
        }
    }

    function _calLabPowerChordNoteRowHtml(noteTick) {
        if (!noteTick) return '';
        const meta = _calLabPowerChordNoteMeta(noteTick.string, noteTick.fret);
        const clarity = Number.isFinite(noteTick.snrRatio) ? noteTick.snrRatio.toFixed(2) : '—';
        const heard = _calLabPowerChordHeardNote(noteTick);
        const chips = _calLabGateChipsHtml(noteTick);
        const passCls = _calLabPowerChordNotePass(noteTick)
            ? 'text-green-300/90' : 'text-amber-200/90';
        return `<div class="py-1 border-b border-gray-700/40">
            <div class="flex justify-between gap-2 text-[10px]">
                <span class="text-gray-300">${meta.label}</span>
                <span class="${passCls} shrink-0">${_calLabPowerChordNotePass(noteTick) ? 'pass' : 'fail'}</span>
            </div>
            <div class="text-[9px] text-gray-500">Expected ${meta.expectedNote} · heard ${heard} · clarity ${clarity}</div>
            ${chips ? `<div class="mt-0.5">${chips}</div>` : ''}
        </div>`;
    }

    function _calLabPowerChordCaptureBlockHtml(cap, index) {
        if (!cap || !cap.ok || !Array.isArray(cap.notes)) {
            return `<div class="text-[10px] text-amber-200/90 py-1">Capture ${index + 1}: probe failed</div>`;
        }
        const rows = cap.notes.map((n) => _calLabPowerChordNoteRowHtml(n)).join('');
        const batch = cap.batchHit
            ? '<span class="text-green-300/90">batch hit</span>'
            : '<span class="text-amber-200/90">batch miss</span>';
        return `<div class="mb-2 p-2 bg-dark-800/50 rounded border border-gray-700/40">
            <div class="text-[10px] text-gray-400 mb-1">Capture ${index + 1} · ${batch}</div>
            ${rows}
        </div>`;
    }

    function _calLabSummarizePowerChordRole(caps, role) {
        const def = _CAL_LAB_POWER_CHORD_NOTES.find((n) => n.role === role);
        if (!def) {
            return { role, n: 0, passRate: null, dominantFailure: null, failCounts: { SNR: 0, FUND: 0, PITCH: 0 } };
        }
        let passes = 0;
        let total = 0;
        const failCounts = { SNR: 0, FUND: 0, PITCH: 0 };
        for (const cap of caps) {
            if (!cap || !cap.ok || !Array.isArray(cap.notes)) continue;
            const note = cap.notes.find((n) => n.string === def.s && n.fret === def.f);
            if (!note) continue;
            total++;
            if (_calLabPowerChordNotePass(note)) passes++;
            if (note.failedGateMask & _CAL_LAB_FAIL.SNR) failCounts.SNR++;
            if (note.failedGateMask & _CAL_LAB_FAIL.FUND) failCounts.FUND++;
            if (note.failedGateMask & _CAL_LAB_FAIL.PITCH) failCounts.PITCH++;
        }
        let dominantFailure = null;
        let maxF = 0;
        for (const [k, v] of Object.entries(failCounts)) {
            if (v > maxF) { maxF = v; dominantFailure = k; }
        }
        return {
            role,
            string: def.s,
            fret: def.f,
            label: _calLabPowerChordNoteMeta(def.s, def.f).label,
            expectedNote: _calLabPowerChordNoteMeta(def.s, def.f).expectedNote,
            n: total,
            passRate: total > 0 ? passes / total : null,
            dominantFailure,
            failCounts,
        };
    }

    function _calLabSummarizePowerChordCaptures(caps) {
        const list = caps || [];
        const root = _calLabSummarizePowerChordRole(list, 'root');
        const fifth = _calLabSummarizePowerChordRole(list, 'fifth');
        const aggregate = _calLabSummarizeCaptures(list);
        return {
            ...aggregate,
            root,
            fifth,
            likelyCause: _calLabPowerChordLikelyCause({ root, fifth }),
        };
    }

    function _calLabPowerChordLikelyCause(ps) {
        if (!ps || !ps.root || !ps.fifth) return null;
        const rootRate = ps.root.passRate;
        const fifthRate = ps.fifth.passRate;
        if (rootRate == null && fifthRate == null) return null;
        const rootOk = rootRate != null && rootRate >= 0.5;
        const fifthOk = fifthRate != null && fifthRate >= 0.5;
        if (rootOk && !fifthOk) {
            if (ps.fifth.dominantFailure === 'FUND') {
                return 'Root verifies, fifth fails fundamental: distorted tone may be hiding the fifth\'s fundamental.';
            }
            if (ps.fifth.dominantFailure === 'PITCH') {
                return 'Root verifies, fifth fails pitch: tuning or pitch-shift path may not match the song.';
            }
            return 'Root verifies, fifth fails: likely masking, wet distortion, or chord voicing issue.';
        }
        if (!rootOk && fifthOk) {
            return 'Fifth verifies, root fails: low-string clarity or fundamental may be weak — check gain, palm muting, or low-string coupling.';
        }
        if (!rootOk && !fifthOk) {
            if (ps.root.dominantFailure === 'SNR' && ps.fifth.dominantFailure === 'SNR') {
                return 'Both strings fail clarity: signal may be too noisy/wet or wrong channel.';
            }
            if (ps.root.dominantFailure === 'FUND' || ps.fifth.dominantFailure === 'FUND') {
                return 'Fundamental fails: distorted tone may be hiding the fundamental.';
            }
            if (ps.root.dominantFailure === 'PITCH' || ps.fifth.dominantFailure === 'PITCH') {
                return 'Pitch fails: tuning or pitch-shift path may not match the song.';
            }
            return 'Both strings struggle to verify: check input channel, gain, and tone path.';
        }
        if (rootOk && fifthOk) {
            return 'Root and fifth both verify in probes — gameplay chord misses may be timing, chart voicing, or a different detector path.';
        }
        return null;
    }

    function _calLabPowerChordSimpleDiagnosis(st) {
        const caps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
        const sum = _calLabSummarizePowerChordCaptures(caps);
        if (!sum.n) return 'No captures yet — press Capture while playing both strings.';
        const rootOk = sum.root.passRate != null && sum.root.passRate >= 0.5;
        const fifthOk = sum.fifth.passRate != null && sum.fifth.passRate >= 0.5;
        if (rootOk && fifthOk) {
            return 'Power chord: root and fifth both heard in probes.';
        }
        if (rootOk && !fifthOk) {
            return 'Power chord: root heard, fifth not heard. Try the dry/clean channel to compare.';
        }
        if (!rootOk && fifthOk) {
            return 'Power chord: fifth heard, root not heard. Check gain and low-string clarity.';
        }
        if (sum.root.dominantFailure === 'SNR' && sum.fifth.dominantFailure === 'SNR') {
            return 'Both strings failed signal clarity. Your signal may be too quiet, noisy, or on the wrong channel.';
        }
        if (sum.root.dominantFailure === 'FUND' || sum.fifth.dominantFailure === 'FUND') {
            return 'The main note is missing. Distortion may be hiding it.';
        }
        if (sum.likelyCause) return sum.likelyCause;
        return 'Power chord root/fifth check did not pass. Try the dry/clean channel to compare.';
    }

    function _calLabFormatPowerChordSum(st) {
        const caps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
        const sum = _calLabSummarizePowerChordCaptures(caps);
        if (!sum.n) return 'No captures yet — press Capture while playing.';
        const rootPct = sum.root.passRate != null ? Math.round(sum.root.passRate * 100) : '—';
        const fifthPct = sum.fifth.passRate != null ? Math.round(sum.fifth.passRate * 100) : '—';
        const rootWeak = _calLabDominantFailLabel(sum.root.dominantFailure);
        const fifthWeak = _calLabDominantFailLabel(sum.fifth.dominantFailure);
        let line = `${sum.n} captures · root pass ${rootPct}% · fifth pass ${fifthPct}%`
            + ` · root weakest: ${rootWeak} · fifth weakest: ${fifthWeak}`;
        if (sum.likelyCause) line += ` · ${sum.likelyCause}`;
        return line;
    }

    function _calLabMusicianStringRowLabel(s, fret, stringName) {
        if (s === 0 && fret === 0) return 'thickest string, open';
        if (s === 1 && fret === 0) return 'next string, open';
        if (s === 0 && fret === 5) return 'thickest string, 5th fret';
        const fretTxt = fret === 0 ? 'open' : `fret ${fret}`;
        return `${stringName || 'string'} · ${fretTxt}`;
    }

    function _calLabBuildSimpleReportBullets(rep) {
        const bullets = [];
        bullets.push('This report did not change gameplay settings.');
        const hw = rep.hardware || {};
        if (Number.isFinite(hw.noise_level_pct) && hw.noise_level_pct >= 5) {
            bullets.push('Your signal is quiet or noisy — check room noise and input gain.');
        }
        if (Number.isFinite(hw.signal_level_pct) && hw.signal_level_pct < 5) {
            bullets.push('Your playing level looks low — try playing louder or raising input gain.');
        }
        let fundFails = 0;
        for (const t of (rep.per_technique || [])) {
            if (!t.summary || !t.summary.failCounts) continue;
            fundFails += t.summary.failCounts.FUND || 0;
        }
        for (const ps of (rep.per_string || [])) {
            if (ps.open && ps.open.summary && ps.open.summary.failCounts) {
                fundFails += ps.open.summary.failCounts.FUND || 0;
            }
            if (ps.fret5 && ps.fret5.summary && ps.fret5.summary.failCounts) {
                fundFails += ps.fret5.summary.failCounts.FUND || 0;
            }
        }
        if (fundFails >= 2) {
            bullets.push('The main note is missing on several tests. Distortion may be hiding it.');
        }
        const pwr = rep.power_chord_diagnostics;
        if (pwr && pwr.root && pwr.fifth) {
            const rootOk = pwr.root.passRate != null && pwr.root.passRate >= 0.5;
            const fifthOk = pwr.fifth.passRate != null && pwr.fifth.passRate >= 0.5;
            if (!rootOk || !fifthOk) {
                bullets.push('Power chord root/fifth check did not fully pass.');
            }
            if (pwr.likely_cause) {
                bullets.push(pwr.likely_cause);
            }
            if (!rootOk || !fifthOk) {
                bullets.push('Try the dry/clean channel to compare against a wet tone.');
            }
        }
        if (bullets.length === 1) {
            bullets.push('No major issues detected from your captures — review details if something still feels off.');
        }
        return bullets;
    }

    function _calLabBuildPowerChordReportSummary(caps) {
        const sum = _calLabSummarizePowerChordCaptures(caps || []);
        const snap = getCalibrationSnapshot();
        let detectorPath = null;
        try {
            const _dd = _diagCatalog && _diagCatalog.getDiagDetector();
            if (_dd && _dd.path) detectorPath = _dd.path;
            else if (_ndUsingEngineVerifier) detectorPath = 'desktop-engine-verifier';
        } catch (_) { /* read-only */ }
        return {
            root: sum.root,
            fifth: sum.fifth,
            likely_cause: sum.likelyCause,
            input_channel: snap.channel || selectedChannel,
            detector_path: detectorPath,
            aggregate: {
                n: sum.n,
                hitRate: sum.hitRate,
                medianSnrRatio: sum.medianSnrRatio,
                dominantFailure: sum.dominantFailure,
            },
        };
    }

    function _calLabCanProbe() {
        return !!(enabled && usingDesktopBridge && _ndBridgeScoreAvailable());
    }

    async function _calLabRunScoreProbe(notes) {
        if (!_calLabCanProbe()) return null;
        const ctx = {
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            offsets: tuningOffsets.slice(0, currentStringCount),
            capo,
            pitchCheckCents: pitchTolerance,
            minHitRatio: chordHitRatio,
            bypassMl: true,
            harmonicVerify: true,
            harmonicSnr: _ND_VERIFY_HARMONIC_SNR,
            notes: notes.map((n) => ({
                s: n.s,
                f: n.f,
                ho: !!n.ho,
                po: !!n.po,
                b: !!n.b,
                sl: !!n.sl,
                hm: !!n.hm,
            })),
        };
        try {
            return await _ndBridgeScoreChord(ctx);
        } catch (e) {
            console.warn('[note_detect] cal lab scoreChord:', e);
            return null;
        }
    }

    async function _calLabCaptureProbe(noteDef, technique) {
        const batch = await _calLabRunScoreProbe([noteDef]);
        if (!batch || !Array.isArray(batch.results) || !batch.results.length) {
            return { ok: false, error: 'probe_failed' };
        }
        const r = batch.results[0];
        const flags = {
            ho: !!noteDef.ho, po: !!noteDef.po,
            b: !!noteDef.b, sl: !!noteDef.sl, hm: !!noteDef.hm,
        };
        const tick = _calLabTickFromResult(r, flags);
        return {
            ok: true,
            at: Date.now(),
            technique: technique || null,
            string: noteDef.s,
            fret: noteDef.f,
            flags,
            ...tick,
        };
    }

    async function _calLabCaptureMulti(notes, technique) {
        const batch = await _calLabRunScoreProbe(notes);
        if (!batch || !Array.isArray(batch.results)) return { ok: false, error: 'probe_failed' };
        const perNote = batch.results.map((r, i) => {
            const nd = notes[i] || { s: r.s, f: r.f };
            const flags = {
                ho: !!nd.ho, po: !!nd.po,
                b: !!nd.b, sl: !!nd.sl, hm: !!nd.hm,
            };
            return { string: nd.s, fret: nd.f, ..._calLabTickFromResult(r, flags) };
        });
        return {
            ok: true,
            at: Date.now(),
            technique: technique || null,
            notes: perNote,
            batchHit: !!batch.isHit,
        };
    }

    // Per-note ticks from a capture — supports single-note probes and multi-note
    // power-chord captures (metrics live under notes[]).
    function _calLabCaptureTicks(capture) {
        if (capture && Array.isArray(capture.notes) && capture.notes.length) {
            return capture.notes.map((n) => ({
                snrRatio: n.snrRatio,
                gatePassCount: n.gatePassCount,
                failedGateMask: n.failedGateMask,
                hit: n.hit,
            }));
        }
        return [{
            snrRatio: capture && capture.snrRatio,
            gatePassCount: capture && capture.gatePassCount,
            failedGateMask: capture && capture.failedGateMask,
            hit: capture && capture.hit,
        }];
    }

    function _calLabCaptureHit(capture) {
        if (capture && Array.isArray(capture.notes) && capture.notes.length) {
            if (capture.batchHit) return true;
            return capture.notes.every((n) => n.hit || n.gatePassCount === 3);
        }
        return !!(capture && (capture.hit || capture.gatePassCount === 3));
    }

    function _calLabSummarizeTicks(ticks, captureCount, hitRate) {
        const ratios = ticks.map((t) => t.snrRatio).filter(Number.isFinite);
        const gates = ticks.map((t) => t.gatePassCount).filter(Number.isFinite);
        const masks = ticks.map((t) => t.failedGateMask | 0);
        const failCounts = { SNR: 0, FUND: 0, PITCH: 0 };
        for (const m of masks) {
            if (m & _CAL_LAB_FAIL.SNR) failCounts.SNR++;
            if (m & _CAL_LAB_FAIL.FUND) failCounts.FUND++;
            if (m & _CAL_LAB_FAIL.PITCH) failCounts.PITCH++;
        }
        let dominantFailure = null;
        let maxF = 0;
        for (const [k, v] of Object.entries(failCounts)) {
            if (v > maxF) { maxF = v; dominantFailure = k; }
        }
        return {
            n: captureCount,
            avgSnrRatio: _calLabAvg(ratios),
            medianSnrRatio: _calLabMedian(ratios),
            bestSnrRatio: ratios.length ? Math.max(...ratios) : null,
            minSnrRatio: ratios.length ? Math.min(...ratios) : null,
            avgGatePassCount: _calLabAvg(gates),
            hitRate,
            dominantFailure,
            failCounts,
        };
    }

    function _calLabSummarizeCaptures(captures) {
        const caps = captures || [];
        const ticks = caps.flatMap((c) => _calLabCaptureTicks(c));
        const hitRate = caps.length
            ? caps.filter((c) => _calLabCaptureHit(c)).length / caps.length
            : null;
        return _calLabSummarizeTicks(ticks, caps.length, hitRate);
    }

    function _calLabSummarizeSustainSeries(series) {
        const samples = series || [];
        const ticks = samples.map((s) => ({
            snrRatio: s.snrRatio,
            gatePassCount: s.gatePassCount,
            failedGateMask: s.failedGateMask,
        }));
        const hitRate = samples.length
            ? samples.filter((s) => s.gatePassCount === 3).length / samples.length
            : null;
        return _calLabSummarizeTicks(ticks, samples.length, hitRate);
    }

    function _calLabBuildRecommendations(report) {
        const rec = [];
        const thr = report.settings && report.settings.harmonic_snr_used;
        for (const t of (report.per_technique || [])) {
            if (!t.summary || !t.summary.n) continue;
            const med = t.summary.medianSnrRatio;
            const dom = t.summary.dominantFailure;
            if (Number.isFinite(med) && thr && med < 0.9 && dom === 'SNR') {
                rec.push(`${t.label}: SNR frequently weak (median ratio ${med.toFixed(2)} vs threshold ${thr}).`);
            } else if (Number.isFinite(med) && thr && med < 1.0 && dom === 'SNR') {
                rec.push(`${t.label}: SNR often below threshold (median ratio ${med.toFixed(2)}).`);
            }
            if (dom === 'FUND' && (t.summary.failCounts.FUND || 0) >= 2) {
                rec.push(`${t.label}: fundamental gate failures common on best-frame probes.`);
            }
            if (dom === 'PITCH' && (t.summary.failCounts.PITCH || 0) >= 2) {
                rec.push(`${t.label}: pitch gate failures observed (may include bend travel).`);
            }
        }
        for (const s of (report.per_string || [])) {
            if (!s.open || !s.open.summary || !s.open.summary.n) continue;
            const med = s.open.summary.medianSnrRatio;
            if (Number.isFinite(med) && med < 0.85) {
                rec.push(`String ${s.string} open: weak SNR (median ratio ${med.toFixed(2)}).`);
            }
        }
        if (report.hardware && Number.isFinite(report.hardware.noise_level_pct)
            && report.hardware.noise_level_pct >= 5) {
            rec.push('Noise floor looks elevated — check room noise or input gain.');
        }
        if (report.hardware && Number.isFinite(report.hardware.signal_level_pct)
            && report.hardware.signal_level_pct < 5) {
            rec.push('Signal level looks low — increase interface gain or play louder.');
        }
        const halfCaps = ((report.per_technique || []).find((t) => t.id === 'halfBend') || {}).captures || [];
        const wholeCaps = ((report.per_technique || []).find((t) => t.id === 'wholeBend') || {}).captures || [];
        if (halfCaps.length || wholeCaps.length) {
            rec.push('Half bends and whole bends currently use the same native bend probe; compare results as labeled technique captures, not distinct detector modes.');
        }
        const pwrDiag = report.power_chord_diagnostics;
        if (pwrDiag && pwrDiag.root && pwrDiag.root.n >= 2 && pwrDiag.likely_cause) {
            rec.push(`Power chords: ${pwrDiag.likely_cause}`);
        }
        if (!rec.length) rec.push('No strong patterns detected — collect more captures or review per-step summaries.');
        return rec;
    }

    function _calLabBuildReport() {
        const snap = getCalibrationSnapshot();
        const st = _calLabState || {};
        const perString = [];
        for (let si = 0; si < currentStringCount; si++) {
            const openCaps = (st.openCaptures && st.openCaptures[si]) || [];
            const fretCaps = (st.fretCaptures && st.fretCaptures[si]) || [];
            perString.push({
                string: si,
                open: { captures: openCaps, summary: _calLabSummarizeCaptures(openCaps) },
                fret5: { captures: fretCaps, summary: _calLabSummarizeCaptures(fretCaps) },
            });
        }
        const techniqueKeys = [
            ['picked', 'Picked notes'],
            ['hammerOn', 'Hammer-ons'],
            ['pullOff', 'Pull-offs'],
            ['powerChord', 'Power chords'],
            ['palmMute', 'Palm mutes'],
            ['naturalHarmonic', 'Natural harmonics'],
            ['pinchHarmonic', 'Pinch harmonics'],
            ['halfBend', 'Half bends'],
            ['wholeBend', 'Whole bends'],
            ['sustain', 'Sustain / decay'],
        ];
        const perTechnique = techniqueKeys.map(([key, label]) => {
            const caps = (st.techniqueCaptures && st.techniqueCaptures[key]) || [];
            let summary;
            if (key === 'sustain' && (st.sustainSeries || []).length) {
                summary = _calLabSummarizeSustainSeries(st.sustainSeries);
            } else if (key === 'powerChord') {
                summary = _calLabSummarizePowerChordCaptures(caps);
            } else {
                summary = _calLabSummarizeCaptures(caps);
            }
            const entry = { id: key, label, captures: caps, summary };
            if (key === 'powerChord') {
                entry.per_string_summary = _calLabBuildPowerChordReportSummary(caps);
            }
            return entry;
        });
        const powerChordCaps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
        const report = {
            schema: _CAL_LAB_SCHEMA,
            timestamp: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            assessment_mode: st.mode || null,
            calibration_notes: [
                'Half bends and whole bends use the same native bend probe (G string fret 7, bend flag); labels distinguish technique captures only.',
            ],
            settings: {
                harmonic_snr_used: _ND_VERIFY_HARMONIC_SNR,
                pitch_tolerance_cents: pitchTolerance,
                pitch_check_cents_verify: _ND_VERIFY_PITCH_CENTS,
                timing_tolerance_s: timingTolerance,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                method: detectionMethod,
            },
            hardware: {
                noise_level_pct: st.noiseLevelPct,
                noise_peak_pct: st.noisePeakPct,
                signal_level_pct: st.signalLevelPct,
                signal_peak_pct: st.signalPeakPct,
                sample_rate_hz: snap.sampleRateHz,
                channel: snap.channel,
                source: snap.source,
                av_offset_ms: snap.avOffsetMs,
            },
            per_string: perString,
            per_technique: perTechnique,
            sustain_series: (st.sustainSeries || []),
            power_chord_diagnostics: _calLabBuildPowerChordReportSummary(powerChordCaps),
        };
        report.recommendations = _calLabBuildRecommendations(report);
        report.simple_summary = _calLabBuildSimpleReportBullets(report);
        _calLabLastReport = report;
        return report;
    }

    function _calLabDownloadReport() {
        try {
            const payload = _calLabBuildReport();
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const ts = payload.timestamp.replace(/[:.]/g, '-').slice(0, 19);
            const a = document.createElement('a');
            a.href = url;
            a.download = `note_detect_calibration_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 500);
            return true;
        } catch (e) {
            console.warn('[note_detect] calibration report download:', e);
            return false;
        }
    }

    function calibrationLabClose() {
        _calLabStopAutoCapture('close');
        if (_calLabTick) {
            clearInterval(_calLabTick);
            _calLabTick = null;
        }
        if (_calLabEl) {
            _calLabEl.remove();
            _calLabEl = null;
        }
        _calLabState = null;
    }

    function _calLabAllStepMeta() {
        return [
            { id: 'intro', title: 'Get Started' },
            { id: 'noise', title: 'Noise Floor' },
            { id: 'signal', title: 'Signal Level' },
            { id: 'open', title: 'Open Strings' },
            { id: 'fret5', title: 'Fretted Note' },
            { id: 'picked', title: 'Picked Notes' },
            { id: 'hammerOn', title: 'Hammer-ons' },
            { id: 'pullOff', title: 'Pull-offs' },
            { id: 'powerChord', title: 'Power Chords' },
            { id: 'palmMute', title: 'Palm Mutes' },
            { id: 'naturalHarmonic', title: 'Natural Harmonics' },
            { id: 'pinchHarmonic', title: 'Pinch Harmonics' },
            { id: 'halfBend', title: 'Half Bends' },
            { id: 'wholeBend', title: 'Whole Bends' },
            { id: 'sustain', title: 'Sustain / Decay' },
            { id: 'report', title: 'Report' },
        ];
    }

    function _calLabActiveSteps(mode) {
        if (!mode) return [{ id: 'intro', title: 'Get Started' }];
        return _calLabAllStepMeta().filter((s) => {
            if (s.id === 'intro') return false;
            if (mode === 'basic') return !_CAL_LAB_ADVANCED_ONLY_STEP_IDS.has(s.id);
            return true;
        });
    }

    function _calLabStringCaptureRowHtml(st, store, s, f, label, opts) {
        const caps = (st[store] && st[store][s]) || [];
        const sum = _calLabSummarizeCaptures(caps);
        const lastCap = caps.length ? caps[caps.length - 1] : null;
        const chips = _calLabGateChipsHtml(lastCap);
        const techDetail = opts && opts.showTech
            ? `<span class="text-[9px] text-gray-600"> (s${s} f${f})</span>` : '';
        const countNote = (opts && opts.showCount)
            ? ` · ${caps.length}/${_CAL_LAB_MIN_CAPTURES} checks` : '';
        const status = caps.length
            ? (lastCap && (lastCap.hit || lastCap.gatePassCount === 3)
                ? '<span class="text-green-300/90 text-[10px]">heard</span>'
                : '<span class="text-amber-200/90 text-[10px]">not verified</span>')
            : '';
        return `<div class="flex flex-col gap-0.5 py-2 border-b border-gray-700/50">
            <p class="text-gray-300 text-xs mb-1">${label}${techDetail}</p>
            <div class="flex items-center justify-between gap-2">
                <span class="text-gray-400 text-[10px]">${countNote.trim() || 'Ready'} ${status}</span>
                <button type="button" class="nd-cal-lab-cap-str px-2 py-1 rounded text-[10px] bg-dark-600 hover:bg-dark-500 text-gray-200" data-store="${store}" data-s="${s}" data-f="${f}">${opts && opts.btnLabel ? opts.btnLabel : 'Capture'}</button>
            </div>${chips ? `<div class="mt-0.5">${chips}</div>` : ''}</div>`;
    }

    function _calLabStringLabels() {
        const labels = ['E', 'A', 'D', 'G', 'B', 'e', 'B7', 'F#'];
        const out = [];
        for (let i = 0; i < currentStringCount; i++) {
            out.push({ s: i, label: labels[i] || ('S' + i) });
        }
        return out;
    }

    function _calLabRefreshLive() {
        if (!_calLabEl || !_calLabState) return;
        const snap = getCalibrationSnapshot();
        const live = _calLabEl.querySelector('.nd-cal-lab-live');
        if (live) {
            live.textContent = 'Live: ' + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct)
                + (_calLabCanProbe() ? ' · ready to capture' : ' · turn Detect on (desktop) to capture');
        }
    }

    function renderCalibrationLab() {
        if (!_calLabEl || !_calLabState) return;
        const body = _calLabEl.querySelector('.nd-cal-lab-body');
        const title = _calLabEl.querySelector('.nd-cal-lab-title');
        const backBtn = _calLabEl.querySelector('.nd-cal-lab-back');
        const nextBtn = _calLabEl.querySelector('.nd-cal-lab-next');
        if (!body || !title) return;
        const st = _calLabState;
        const steps = _calLabActiveSteps(st.mode);
        const step = st.step;
        const stepDef = steps[step];
        const stepId = stepDef ? stepDef.id : 'intro';
        if (st._lastRenderStepId !== stepId || st._lastRenderMode !== st.mode) {
            _calLabStopAutoCapture('step-change');
            st._lastRenderStepId = stepId;
            st._lastRenderMode = st.mode;
        }
        const modeLabel = st.mode === 'basic' ? 'Basic' : (st.mode === 'advanced' ? 'Advanced' : '');
        title.textContent = modeLabel
            ? `Technique Assessment — ${modeLabel} · ${stepDef ? stepDef.title : 'Step'}`
            : `Technique Assessment — ${stepDef ? stepDef.title : 'Get Started'}`;
        if (backBtn) backBtn.style.visibility = (st.mode && step > 0) ? 'visible' : 'hidden';
        if (nextBtn) {
            if (!st.mode) {
                nextBtn.style.visibility = 'hidden';
                nextBtn.disabled = false;
            } else {
                nextBtn.style.visibility = 'visible';
                nextBtn.textContent = step >= steps.length - 1 ? 'Done' : 'Next';
                nextBtn.disabled = _calLabIsAutoBusy(st);
            }
        }

        let html = `<div class="nd-cal-lab-live text-cyan-300/90 text-[10px] font-mono mb-2">Live: —</div>`;
        if (!_calLabCanProbe() && st.mode && stepId !== 'report') {
            html += '<p class="text-amber-200/90 text-[10px] mb-2">Turn Detect on (desktop) to run listening checks.</p>';
        }

        if (stepId === 'intro') {
            html += `<p class="text-gray-300 text-xs mb-3"><strong class="text-gray-200">Calibration Wizard</strong> sets up your input. <strong class="text-gray-200">Technique Assessment</strong> checks how well Slopsmith hears your playing.</p>
                <p class="text-gray-300 text-xs mb-3">Each check looks at <strong class="text-gray-200">signal clarity</strong>, whether the <strong class="text-gray-200">main note</strong> is present, and <strong class="text-gray-200">tuning match</strong>. Read-only — nothing here changes gameplay settings.</p>
                <button type="button" class="nd-cal-lab-start-basic w-full py-2.5 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2">Start Basic Assessment</button>
                <p class="text-[10px] text-gray-500 mb-3">Checks input level, open strings, one fretted note, and one power chord. Best first step.</p>
                <button type="button" class="nd-cal-lab-start-advanced w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Advanced Assessment</button>
                <p class="text-[10px] text-gray-500">Detailed probes: hammer-ons, pull-offs, palm mutes, harmonics, bends, and sustain.</p>`;
        } else if (stepId === 'noise') {
            if (st.mode === 'basic') {
                const busy = _calLabIsAutoBusy(st);
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === 'noise';
                const noiseResult = Number.isFinite(st.noiseLevelPct)
                    ? calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct) : '—';
                html += `<p class="text-gray-300 text-sm mb-2">Mute all strings. We will listen to room noise.</p>
                    ${_calLabBasicAutoControlsHtml('noise', 'Start noise check', busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <div class="nd-cal-lab-auto-result text-[11px] text-gray-400 mb-2">${noiseResult}</div>
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <button type="button" class="nd-cal-lab-cap-noise w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2 mt-1">Capture room noise (manual)</button>
                    </details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Mute all strings and rest your hands on the strings.</p>
                    <button type="button" class="nd-cal-lab-cap-noise w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Capture room noise</button>
                    <div class="nd-cal-lab-cap-noise-txt text-[11px] text-gray-400">—</div>`;
            }
        } else if (stepId === 'signal') {
            if (st.mode === 'basic') {
                const busy = _calLabIsAutoBusy(st);
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === 'signal';
                const sigResult = Number.isFinite(st.signalLevelPct)
                    ? calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct) : '—';
                html += `<p class="text-gray-300 text-sm mb-2">Play the thickest string loudly.</p>
                    ${_calLabBasicAutoControlsHtml('signal', 'Start signal check', busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <div class="nd-cal-lab-auto-result text-[11px] text-gray-400 mb-2">${sigResult}</div>
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <button type="button" class="nd-cal-lab-cap-signal w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2 mt-1">Capture playing level (manual)</button>
                    </details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Play the thickest string open at normal volume.</p>
                    <button type="button" class="nd-cal-lab-cap-signal w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Capture playing level</button>
                    <div class="nd-cal-lab-cap-signal-txt text-[11px] text-gray-400">—</div>`;
            }
        } else if (stepId === 'open' || stepId === 'fret5') {
            const fret = stepId === 'open' ? 0 : 5;
            const store = stepId === 'open' ? 'openCaptures' : 'fretCaptures';
            if (st.mode === 'basic') {
                const rows = stepId === 'open' ? _CAL_LAB_BASIC_OPEN_ROWS : _CAL_LAB_BASIC_FRET_ROWS;
                const busy = _calLabIsAutoBusy(st);
                const autoKey = stepId === 'open' ? 'open' : 'fret5';
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === autoKey;
                const startLabel = stepId === 'open' ? 'Start open-string check' : 'Start fretted-note check';
                const instruct = stepId === 'open'
                    ? 'We will check the thickest string open, then the next string open.'
                    : 'Play the thickest string at the 5th fret when prompted.';
                let summaryHtml = '';
                for (const row of rows) {
                    const caps = (st[store] && st[store][row.s]) || [];
                    const lastCap = caps.length ? caps[caps.length - 1] : null;
                    const chips = _calLabGateChipsHtml(lastCap);
                    const heard = caps.length
                        ? (lastCap && (lastCap.hit || lastCap.gatePassCount === 3)
                            ? '<span class="text-green-300/90">heard</span>'
                            : '<span class="text-amber-200/90">not verified</span>')
                        : '<span class="text-gray-500">not checked</span>';
                    summaryHtml += `<div class="py-1 border-b border-gray-700/40 text-[10px]">
                        <span class="text-gray-300">${row.prompt}</span> · ${caps.length} captures · ${heard}
                        ${chips ? `<div class="mt-0.5">${chips}</div>` : ''}</div>`;
                }
                html += `<p class="text-gray-300 text-sm mb-2">${instruct}</p>
                    ${_calLabBasicAutoControlsHtml(autoKey, startLabel, busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <div class="nd-cal-lab-auto-summary text-[10px] text-gray-400 mb-2">${summaryHtml}</div>
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <div class="mt-1">`;
                for (const row of rows) {
                    html += _calLabStringCaptureRowHtml(st, store, row.s, row.f, row.prompt, {
                        btnLabel: row.btn,
                    });
                }
                html += `</div></details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Play each string ${fret === 0 ? 'open' : `at fret ${fret}`}. Capture while the note rings.</p>`;
                for (const { s, label } of _calLabStringLabels()) {
                    const musician = _calLabMusicianStringRowLabel(s, fret, label);
                    html += _calLabStringCaptureRowHtml(st, store, s, fret, musician, {
                        showTech: true,
                        showCount: true,
                        btnLabel: `Capture ${musician}`,
                    });
                }
            }
        } else if (stepId === 'picked') {
            html += `<p class="text-gray-300 text-xs mb-2">Pick single notes (e.g. 12th fret). Capture while playing.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="picked" data-s="0" data-f="12">Capture picked sample (low E @ 12)</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'picked')}</div>`;
        } else if (stepId === 'hammerOn') {
            html += `<p class="text-gray-300 text-xs mb-2">Hammer onto fret 5 on A string (from fret 3). Capture during hammer.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="hammerOn" data-s="1" data-f="5" data-ho="1">Capture hammer-on</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'hammerOn')}</div>`;
        } else if (stepId === 'pullOff') {
            html += `<p class="text-gray-300 text-xs mb-2">Pull-off from fret 5 to 3 on A string. Capture during pull-off.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="pullOff" data-s="1" data-f="3" data-po="1">Capture pull-off</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'pullOff')}</div>`;
        } else if (stepId === 'powerChord') {
            const pwrCaps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
            const pwrCaptureBlocks = pwrCaps.length
                ? pwrCaps.map((cap, i) => _calLabPowerChordCaptureBlockHtml(cap, i)).join('')
                : '';
            const simpleDiag = _calLabPowerChordSimpleDiagnosis(st);
            const pwrTarget = _calLabPowerChordTargetLabel();
            if (st.mode === 'basic') {
                const busy = _calLabIsAutoBusy(st);
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === 'powerChord';
                html += `<p class="text-gray-300 text-sm mb-2">Play ${pwrTarget.leadHtml} — thickest string open (<strong class="text-gray-100">${pwrTarget.root}</strong>) + next string, 2nd fret (<strong class="text-gray-100">${pwrTarget.fifth}</strong>).</p>
                    <p class="text-[10px] text-gray-500 mb-2">Try the dry/clean channel if available to compare against a wet tone.</p>
                    ${_calLabBasicAutoControlsHtml('powerChord', 'Start power-chord check', busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <p class="nd-cal-lab-pwr-diag-live text-[11px] text-gray-200 mb-2">${simpleDiag}</p>
                    ${pwrCaptureBlocks ? `<details class="mb-2"><summary class="text-[10px] text-gray-400 cursor-pointer hover:text-gray-200 py-1">Technical capture details</summary>
                        <div class="nd-cal-lab-tech-sum text-[10px] text-gray-500 mt-1 mb-2">${_calLabFormatPowerChordSum(st)}</div>
                        <div class="nd-cal-lab-pwr-captures">${pwrCaptureBlocks}</div></details>` : ''}
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <button type="button" class="nd-cal-lab-cap-pwr w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-2 mt-1">Capture power chord (manual)</button>
                    </details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Play ${pwrTarget.leadHtml} — thickest string open (<strong class="text-gray-100">${pwrTarget.root}</strong>) + next string at the 2nd fret (<strong class="text-gray-100">${pwrTarget.fifth}</strong>). Capture while both ring.</p>
                    <p class="text-[10px] text-gray-500 mb-2">Power chords are tested per string. If the root passes but the fifth fails, the issue is usually masking, distortion, or channel choice — not your timing.</p>
                    <p class="text-[10px] text-gray-500 mb-2">Try the dry/clean channel if available to compare against a wet Spark tone.</p>
                    <button type="button" class="nd-cal-lab-cap-pwr w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-2">Capture power chord</button>
                    <p class="text-[11px] text-gray-200 mb-2">${simpleDiag}</p>
                    ${pwrCaptureBlocks ? `<details class="mb-2"><summary class="text-[10px] text-gray-400 cursor-pointer hover:text-gray-200 py-1">Technical capture details</summary>
                        <div class="nd-cal-lab-tech-sum text-[10px] text-gray-500 mt-1 mb-2">${_calLabFormatPowerChordSum(st)}</div>
                        <div class="nd-cal-lab-pwr-captures">${pwrCaptureBlocks}</div></details>` : ''}`;
            }
        } else if (stepId === 'palmMute') {
            html += `<p class="text-gray-300 text-xs mb-2">Palm-muted chugs on low E.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Note: charts do not flag palm mutes yet — this probe uses a picked-note context. Results show how muted playing verifies, not chart palm-mute scoring.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="palmMute" data-s="0" data-f="0">Capture palm mute</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'palmMute')}</div>`;
        } else if (stepId === 'naturalHarmonic') {
            html += `<p class="text-gray-300 text-xs mb-2">Natural harmonic at 12th fret low E. Capture lightly.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="naturalHarmonic" data-s="0" data-f="12" data-hm="1">Capture natural harmonic</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'naturalHarmonic')}</div>`;
        } else if (stepId === 'pinchHarmonic') {
            html += `<p class="text-gray-300 text-xs mb-2">Pinch harmonic on any string.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Note: charts do not flag pinch harmonics yet — this probe uses picked-note context.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="pinchHarmonic" data-s="2" data-f="7">Capture pinch harmonic</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'pinchHarmonic')}</div>`;
        } else if (stepId === 'halfBend') {
            html += `<p class="text-gray-300 text-xs mb-2">Half bend at 7th fret G string. Capture mid-bend and release.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Half and whole bends use the same detector probe — labels distinguish your technique, not separate detector modes.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="halfBend" data-s="3" data-f="7" data-b="1">Capture half bend</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'halfBend')}</div>`;
        } else if (stepId === 'wholeBend') {
            html += `<p class="text-gray-300 text-xs mb-2">Whole-step bend at 7th fret G string.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Same probe as half bends — compare results as labeled captures, not distinct modes.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="wholeBend" data-s="3" data-f="7" data-b="1">Capture whole bend</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'wholeBend')}</div>`;
        } else if (stepId === 'sustain') {
            html += `<p class="text-gray-300 text-xs mb-2">Hold a note (open low E). Record polls SNR over ~1.5 s.</p>
                <button type="button" class="nd-cal-lab-cap-sustain w-full py-2 bg-accent hover:bg-accent-light rounded text-xs font-semibold text-white mb-2">Record sustain</button>
                <div class="nd-cal-lab-sustain-txt text-[11px] text-gray-400">${(st.sustainSeries || []).length} samples</div>`;
        } else if (stepId === 'report') {
            const rep = _calLabBuildReport();
            const simpleBullets = _calLabBuildSimpleReportBullets(rep);
            const simpleHtml = simpleBullets.map((t) => `<li class="text-gray-200">${t}</li>`).join('');
            const recHtml = (rep.recommendations || []).map((t) => `<li class="text-amber-200/90">${t}</li>`).join('');
            html += `<p class="text-gray-300 text-xs mb-2">Your Technique Assessment results. This did not change gameplay settings.</p>
                <ul class="text-[11px] list-disc pl-4 mb-3 space-y-1">${simpleHtml}</ul>
                <button type="button" class="nd-cal-lab-dl w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-2">Download full report (JSON)</button>
                <details class="mb-2"><summary class="text-[10px] text-gray-400 cursor-pointer hover:text-gray-200 py-1">Technical details</summary>
                    <ul class="text-[10px] list-disc pl-4 mb-2 space-y-0.5 mt-2">${recHtml || '<li class="text-gray-500">No extra technical notes.</li>'}</ul>
                    <pre class="text-[9px] text-gray-500 max-h-32 overflow-auto whitespace-pre-wrap">${_calLabReportPreview(rep)}</pre>
                </details>`;
        }

        body.innerHTML = html;
        _calLabWireHandlers();
        _calLabRefreshLive();
    }

    function _calLabFormatTechSum(st, key) {
        if (key === 'powerChord') return _calLabFormatPowerChordSum(st);
        let sum;
        let lastCap = null;
        if (key === 'sustain' && (st.sustainSeries || []).length) {
            sum = _calLabSummarizeSustainSeries(st.sustainSeries);
            const s = st.sustainSeries[st.sustainSeries.length - 1];
            if (s) lastCap = { gatePassCount: s.gatePassCount, failedGateMask: s.failedGateMask };
        } else {
            const caps = (st.techniqueCaptures && st.techniqueCaptures[key]) || [];
            sum = _calLabSummarizeCaptures(caps);
            lastCap = caps.length ? caps[caps.length - 1] : null;
        }
        if (!sum.n) return 'No captures yet — press Capture while playing.';
        const unit = key === 'sustain' ? 'samples' : 'captures';
        const weak = _calLabDominantFailLabel(sum.dominantFailure);
        const chips = _calLabGateChipsHtml(lastCap);
        return `${sum.n} ${unit} · weakest area: ${weak}${chips ? ' · ' : ''}${chips}`;
    }

    function _calLabReportPreview(rep) {
        try {
            const lines = [];
            for (const t of (rep.per_technique || [])) {
                if (!t.summary || !t.summary.n) continue;
                if (t.id === 'powerChord' && t.summary.root && t.summary.fifth) {
                    const rootPct = t.summary.root.passRate != null
                        ? Math.round(t.summary.root.passRate * 100) : '—';
                    const fifthPct = t.summary.fifth.passRate != null
                        ? Math.round(t.summary.fifth.passRate * 100) : '—';
                    let line = `${t.label}: ${t.summary.n} captures · root ${rootPct}% · fifth ${fifthPct}%`;
                    if (t.summary.likelyCause) line += ` · ${t.summary.likelyCause}`;
                    lines.push(line);
                    continue;
                }
                const med = Number.isFinite(t.summary.medianSnrRatio)
                    ? t.summary.medianSnrRatio.toFixed(2) : '—';
                lines.push(`${t.label}: ${t.summary.n} captures · clarity ${med} · weakest: ${_calLabDominantFailLabel(t.summary.dominantFailure)}`);
            }
            return lines.slice(0, 12).join('\n') || '(empty)';
        } catch (_) { return ''; }
    }

    function _calLabWireHandlers() {
        if (!_calLabEl || !_calLabState) return;
        const st = _calLabState;
        const body = _calLabEl.querySelector('.nd-cal-lab-body');
        if (!body) return;

        const startBasic = body.querySelector('.nd-cal-lab-start-basic');
        if (startBasic) {
            startBasic.onclick = () => {
                _calLabStopAutoCapture('mode');
                st.mode = 'basic';
                st.step = 0;
                renderCalibrationLab();
            };
        }
        const startAdvanced = body.querySelector('.nd-cal-lab-start-advanced');
        if (startAdvanced) {
            startAdvanced.onclick = () => {
                _calLabStopAutoCapture('mode');
                st.mode = 'advanced';
                st.step = 0;
                renderCalibrationLab();
            };
        }

        body.querySelectorAll('.nd-cal-lab-auto-start').forEach((btn) => {
            btn.onclick = () => {
                const key = btn.getAttribute('data-auto-step');
                if (key === 'noise') _calLabStartNoiseAuto();
                else if (key === 'signal') _calLabStartSignalAuto();
                else if (key === 'open') _calLabStartOpenAuto(false);
                else if (key === 'fret5') _calLabStartFretAuto(false);
                else if (key === 'powerChord') _calLabStartPowerChordAuto(false);
            };
        });
        body.querySelectorAll('.nd-cal-lab-auto-retry').forEach((btn) => {
            btn.onclick = () => {
                const key = btn.getAttribute('data-auto-step');
                _calLabRetryBasicAuto(key);
            };
        });
        body.querySelectorAll('.nd-cal-lab-auto-stop').forEach((btn) => {
            btn.onclick = () => {
                _calLabStopAutoCapture('user');
                _calLabSetAutoStatus('<span class="text-gray-400">Stopped.</span>');
                _calLabUpdateBasicAutoButtons();
            };
        });

        const capNoise = body.querySelector('.nd-cal-lab-cap-noise');
        if (capNoise) {
            capNoise.onclick = () => {
                _calLabStopAutoCapture('manual');
                const s = getCalibrationSnapshot();
                st.noiseLevelPct = s.inputLevelPct;
                st.noisePeakPct = s.inputPeakPct;
                const el = body.querySelector('.nd-cal-lab-cap-noise-txt');
                if (el) el.textContent = calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct);
                const autoEl = body.querySelector('.nd-cal-lab-auto-result');
                if (autoEl) {
                    autoEl.textContent = calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct);
                }
                if (st.autoRun) {
                    st.autoRun.phase = 'done';
                    st.autoRun.stepId = 'noise';
                }
                renderCalibrationLab();
            };
        }
        const capSignal = body.querySelector('.nd-cal-lab-cap-signal');
        if (capSignal) {
            capSignal.onclick = () => {
                _calLabStopAutoCapture('manual');
                const s = getCalibrationSnapshot();
                st.signalLevelPct = s.inputLevelPct;
                st.signalPeakPct = s.inputPeakPct;
                const el = body.querySelector('.nd-cal-lab-cap-signal-txt');
                if (el) el.textContent = calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct);
                const autoEl = body.querySelector('.nd-cal-lab-auto-result');
                if (autoEl) {
                    autoEl.textContent = calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct);
                }
                if (st.autoRun) {
                    st.autoRun.phase = 'done';
                    st.autoRun.stepId = 'signal';
                }
                renderCalibrationLab();
            };
        }

        body.querySelectorAll('.nd-cal-lab-cap-str').forEach((btn) => {
            btn.onclick = async () => {
                _calLabStopAutoCapture('manual');
                const store = btn.getAttribute('data-store');
                const s = parseInt(btn.getAttribute('data-s'), 10);
                const f = parseInt(btn.getAttribute('data-f'), 10);
                if (!store || !Number.isInteger(s)) return;
                btn.disabled = true;
                const cap = await _calLabCaptureProbe({ s, f }, store);
                btn.disabled = false;
                if (!_calLabState || _calLabState !== st) return;
                if (cap.ok) {
                    if (!st[store]) st[store] = {};
                    if (!st[store][s]) st[store][s] = [];
                    st[store][s].push(cap);
                }
                renderCalibrationLab();
            };
        });

        body.querySelectorAll('.nd-cal-lab-cap-tech').forEach((btn) => {
            btn.onclick = async () => {
                _calLabStopAutoCapture('manual');
                const tech = btn.getAttribute('data-tech');
                const s = parseInt(btn.getAttribute('data-s'), 10);
                const f = parseInt(btn.getAttribute('data-f'), 10);
                const note = { s, f };
                if (btn.getAttribute('data-ho')) note.ho = true;
                if (btn.getAttribute('data-po')) note.po = true;
                if (btn.getAttribute('data-b')) note.b = true;
                if (btn.getAttribute('data-hm')) note.hm = true;
                btn.disabled = true;
                const cap = await _calLabCaptureProbe(note, tech);
                btn.disabled = false;
                if (cap.ok) {
                    if (!st.techniqueCaptures) st.techniqueCaptures = {};
                    if (!st.techniqueCaptures[tech]) st.techniqueCaptures[tech] = [];
                    st.techniqueCaptures[tech].push(cap);
                }
                renderCalibrationLab();
            };
        });

        const capPwr = body.querySelector('.nd-cal-lab-cap-pwr');
        if (capPwr) {
            capPwr.onclick = async () => {
                _calLabStopAutoCapture('manual');
                capPwr.disabled = true;
                const cap = await _calLabCaptureMulti([{ s: 0, f: 0 }, { s: 1, f: 2 }], 'powerChord');
                capPwr.disabled = false;
                if (!_calLabState || _calLabState !== st) return;
                if (cap.ok) {
                    if (!st.techniqueCaptures) st.techniqueCaptures = {};
                    if (!st.techniqueCaptures.powerChord) st.techniqueCaptures.powerChord = [];
                    st.techniqueCaptures.powerChord.push(cap);
                }
                renderCalibrationLab();
            };
        }

        const capSus = body.querySelector('.nd-cal-lab-cap-sustain');
        if (capSus) {
            capSus.onclick = async () => {
                capSus.disabled = true;
                if (!st.sustainSeries) st.sustainSeries = [];
                const note = { s: 0, f: 0 };
                for (let i = 0; i < 10; i++) {
                    const cap = await _calLabCaptureProbe(note, 'sustain');
                    if (cap.ok) {
                        st.sustainSeries.push({
                            tMs: i * 150,
                            snrRatio: cap.snrRatio,
                            gatePassCount: cap.gatePassCount,
                            failedGateMask: cap.failedGateMask,
                        });
                    }
                    await new Promise((r) => setTimeout(r, 150));
                }
                capSus.disabled = false;
                renderCalibrationLab();
            };
        }

        const dl = body.querySelector('.nd-cal-lab-dl');
        if (dl) dl.onclick = () => _calLabDownloadReport();
    }

    function calibrationLabNext() {
        if (!_calLabState || !_calLabState.mode) return;
        if (_calLabIsAutoBusy(_calLabState)) return;
        _calLabStopAutoCapture('next');
        const steps = _calLabActiveSteps(_calLabState.mode);
        if (_calLabState.step >= steps.length - 1) {
            calibrationLabClose();
            return;
        }
        _calLabState.step++;
        renderCalibrationLab();
    }

    function calibrationLabBack() {
        if (!_calLabState || !_calLabState.mode || _calLabState.step <= 0) return;
        if (_calLabIsAutoBusy(_calLabState)) return;
        _calLabStopAutoCapture('back');
        _calLabState.step--;
        renderCalibrationLab();
    }

    function openInstrumentCalibrationLab() {
        calibrationLabClose();
        _calLabState = {
            mode: null,
            step: 0,
            noiseLevelPct: null,
            noisePeakPct: null,
            signalLevelPct: null,
            signalPeakPct: null,
            openCaptures: {},
            fretCaptures: {},
            techniqueCaptures: {},
            sustainSeries: [],
            autoRun: _calLabDefaultAutoRun(),
        };
        const overlay = document.createElement('div');
        overlay.className = 'nd-cal-lab';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:301;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);pointer-events:auto;';
        overlay.innerHTML = `
            <div class="bg-dark-700 border border-gray-600 rounded-2xl shadow-2xl text-sm" style="width:24rem;max-width:calc(100vw - 2rem);max-height:calc(100vh - 3rem);display:flex;flex-direction:column;">
                <div class="flex justify-between items-center px-4 py-3 border-b border-gray-700">
                    <span class="nd-cal-lab-title text-gray-200 font-semibold text-xs">Technique Assessment</span>
                    <button type="button" class="nd-cal-lab-close text-gray-500 hover:text-white text-lg leading-none">&times;</button>
                </div>
                <div class="nd-cal-lab-body px-4 py-3 overflow-y-auto flex-1 text-xs"></div>
                <div class="flex gap-2 px-4 py-3 border-t border-gray-700">
                    <button type="button" class="nd-cal-lab-back flex-1 py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300">Back</button>
                    <button type="button" class="nd-cal-lab-next flex-1 py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white">Next</button>
                </div>
            </div>`;
        overlay.onclick = (e) => { if (e.target === overlay) calibrationLabClose(); };
        overlay.querySelector('.nd-cal-lab-close').onclick = () => calibrationLabClose();
        overlay.querySelector('.nd-cal-lab-back').onclick = () => calibrationLabBack();
        overlay.querySelector('.nd-cal-lab-next').onclick = () => calibrationLabNext();
        document.body.appendChild(overlay);
        _calLabEl = overlay;
        renderCalibrationLab();
        _calLabTick = setInterval(() => {
            if (!_calLabEl || !_calLabEl.isConnected) {
                calibrationLabClose();
                return;
            }
            _calLabRefreshLive();
        }, 200);
    }

    function getCalibrationReport() {
        try {
            return _calLabLastReport || (_calLabState ? _calLabBuildReport() : null);
        } catch (_) {
            return null;
        }
    }

    // slopsmith#502 — scrollable gear popover steals horizontal drags from
    // range sliders. Lock panel scroll while a slider is active; UI-only.
    function _ndWireSettingsRangeScrollLock(panel) {
        if (!panel || panel._ndRangeScrollLock) return;
        panel._ndRangeScrollLock = true;

        const release = () => {
            panel.style.overflowY = 'auto';
            panel.classList.remove('nd-settings-panel--slider-drag');
        };

        for (const el of panel.querySelectorAll('input[type=range]')) {
            el.style.touchAction = 'none';
            el.style.userSelect = 'none';

            el.addEventListener('pointerdown', (e) => {
                panel.style.overflowY = 'hidden';
                panel.classList.add('nd-settings-panel--slider-drag');
                try { el.setPointerCapture(e.pointerId); } catch (_) { /* host */ }
            });

            el.addEventListener('pointerup', release);
            el.addEventListener('pointercancel', release);
            el.addEventListener('lostpointercapture', release);
        }
    }

    // nd-carve-5 cut 4: showSettings, onDeviceChange, onChannelChange,
    // populateDevices, setMethod moved to settings-panel.js.
    // Call showSettings via gearBtn.onclick = _settingsPanel.showSettings.

    // The detection method actually used per frame (web path). A bass
    // arrangement auto-uses HPS when the user has not explicitly chosen a
    // method and is still on the YIN default: YIN's time-domain autocorrelation
    // latches onto the 2nd harmonic of a weak-fundamental bass note and reports
    // an octave high, while HPS reinforces the true fundamental.
    function _ndEffectiveDetectionMethod() {
        if (currentArrangement === 'bass' && !detectionMethodUserSet && detectionMethod === 'yin')
            return 'hps';
        return detectionMethod;
    }

    // Accepts only the documented channel indices (-1 mono, 0 left,
    // 1 right). Returns `false` and leaves the channel unchanged for
    // anything else so upstream bugs (stringified input, out-of-range
    // index) surface instead of silently coercing to mono.
    function setChannel(idx) {
        if (!Number.isInteger(idx) || idx < -1) {
            console.warn(`[note_detect] setChannel: invalid channel ${idx}; expected an integer >= -1 (-1 = mono mix, else 0-based input channel).`);
            return false;
        }
        // Multichannel channel selection (index >= 2) is DEFERRED. It is only valid on
        // the desktop engine-SOURCE path, but at any given moment this detector may
        // instead run the browser getUserMedia splitter (borrowing mode, or a desktop
        // build where the native bridge is unavailable), which captures only channels
        // 0/1 — accepting >=2 there silently captures the wrong input and exports stale
        // metadata. The validated multi-device flow binds ONE device per panel and uses
        // mono/left/right; selecting channel 3+ of a single multi-channel interface
        // needs runtime, capture-mode-aware gating (a follow-up). Reject for now so the
        // two channel representations (_ndChannelIndex + selectedChannel) never diverge.
        if (idx >= 2) {
            console.warn(`[note_detect] setChannel: channel ${idx} (multi-channel selection) is not yet supported; use a separate input device per panel.`);
            return false;
        }
        _ndChannelIndex = idx;
        // selectedChannel (serialized into session/diagnostic metadata) stays in sync —
        // only -1/0/1 are reachable now, so it never goes stale.
        if (idx === -1) selectedChannel = 'mono';
        else if (idx === 0) selectedChannel = 'left';
        else selectedChannel = 'right';  // idx === 1
        saveSettings();
        // Retarget the bound engine source's input channel directly — restartAudio()
        // below only rebuilds the browser getUserMedia graph, not the live engine
        // binding. Applies to THIS detector's source whether we allocated it
        // (_ndOwnsSource) or it was caller-assigned (opts.sourceId): the channel is
        // what this detector listens to, so it must follow. (Only the per-panel verifier
        // OFFSET stays owned-only, since that tweak shouldn't leak onto a shared source.)
        // Never source 0 (the shared default). No-op on the browser path.
        if (sourceId != null && sourceId !== 0) {
            const a = bridgeDesktop && bridgeDesktop.audio;
            if (a && typeof a.setSourceInputChannel === 'function') {
                try { a.setSourceInputChannel(sourceId, _ndChannelIndex); } catch (_) { /* best-effort */ }
            }
        }
        restartAudio();
        return true;
    }

    // Set the per-source capture-latency correction (milliseconds) and apply it
    // live to the bound engine source. The host (splitscreen) calls this from a
    // per-panel control so the user can dial in an extra device's timing.
    function setVerifierOffset(ms) {
        if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
        _ndVerifierOffsetMs = ms;
        _ndApplyVerifierOffset();
    }
    function getVerifierOffset() { return _ndVerifierOffsetMs; }


    // ── Button injection ──────────────────────────────────────────────
    // Attach instanceRoot into the DOM. Called from `injectButton()`
    // and from `enable()` so programmatic `createNoteDetector({container}).enable()`
    // usage (no button injection) still gets HUD/settings/summary
    // rendered. Idempotent — re-attaching an already-appended element
    // is a no-op via the `contains()` guard.
    function attachInstanceRoot() {
        const target = container || document.getElementById('player');
        if (target && !target.contains(instanceRoot)) {
            target.appendChild(instanceRoot);
        }
    }

    function injectButton(bar) {
        const controls = bar || document.getElementById('player-controls');
        if (!controls) return;
        // Idempotency: skip if our button is still live in the DOM. We check
        // isConnected, NOT controls.contains(detectBtn): in v3 the host's
        // rehome shim MOVES our button out of #player-controls into the
        // Plugins rail slot (preserving identity + listeners), so a
        // membership check against `controls` misses the rehomed button and
        // injects a fresh duplicate on every song switch (the playSong
        // wrapper re-calls injectButton each song). isConnected is true in
        // both the in-bar (v2) and rehomed-to-slot (v3) cases, and false only
        // when a recreated controls row genuinely orphaned the old button —
        // which is exactly when we DO want to re-inject.
        if (detectBtn && detectBtn.isConnected) return;

        const closeBtn = controls.querySelector(':scope > button:last-of-type');

        detectBtn = document.createElement('button');
        detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
        detectBtn.textContent = 'Detect';
        detectBtn.title = 'Toggle real-time note detection & scoring';
        detectBtn.onclick = toggle;
        if (closeBtn && closeBtn.parentNode === controls) controls.insertBefore(detectBtn, closeBtn);
        else controls.appendChild(detectBtn);

        gearBtn = document.createElement('button');
        gearBtn.className = 'nd-gear-btn px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
        gearBtn.textContent = '\u2699';
        gearBtn.title = 'Note detection settings';
        gearBtn.onclick = _settingsPanel.showSettings;
        if (closeBtn && closeBtn.parentNode === controls) controls.insertBefore(gearBtn, closeBtn);
        else controls.appendChild(gearBtn);

        // NOTE: no standalone "Drill here" button here on purpose. The drill
        // conductor is a headless engine driven through feedBack's existing UI
        // (the coaching plugin's post-play "Drill this run" / "Practice this"
        // buttons call window.noteDetect.startDrill). A note_detect-owned button
        // would duplicate that entry point and upstream's Section Practice. The
        // startDrillHere() API stays exported for any host UI that wants a
        // "drill the bar under the playhead" affordance.

        attachInstanceRoot();
        // Sync button class/text with current state. If the instance
        // was already enabled (or CREPE is mid-load) when the button is
        // injected, the default 'Detect' text would be out of date.
        updateButton();
    }

    function updateButton() {
        if (!detectBtn) return;
        const loading = detectionMethod === 'crepe' && _ndShared.modelLoading;
        if (loading) {
            detectBtn.textContent = 'Detect (loading model...)';
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 rounded-lg text-xs text-gray-400 transition';
        } else if (enabled) {
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
            detectBtn.textContent = 'Detect \u2713';
        } else {
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
            detectBtn.textContent = 'Detect';
        }
        if (gearBtn) gearBtn.classList.toggle('hidden', !enabled);
    }

    // ── Reset / enable / disable / destroy ────────────────────────────
    function resetScoring() {
        hits = 0;
        misses = 0;
        streak = 0;
        bestStreak = 0;
        score = 0;
        multiplier = 1;
        maxMultiplier = 1;
        // _xpSubmittedTake and _ndAutoExitRelease live in createSummaryUi closure
        // (nd-carve-5 cut 2); resetState() re-arms them for the new take.
        _summaryUi.resetState();
        noteResults.clear();
        _scoreLedger.clear();
        _susActiveUntil.clear();
        _chordLastResult.clear();
        _ndLastMissScanT = null;
        // Auto-drill reset delegated to drill conductor (nd-carve-5 cut 3).
        _drillConductor.resetForSong();
        _rescueBuf = new Float32Array(0);
        _rescueBufEndT = 0;
        // Zero the rescue counters too — the diagnostic summary reports them
        // alongside per-song hits/misses, so leaving them would leak
        // session-cumulative rescue counts into each song's report.
        _rescueCalls = 0;
        _rescueWindows = 0;
        _rescueHits = 0;
        _rescueSkippedSilent = 0;
        _ndVerifierRejects.length = 0;
        _ndRejectDedup.clear();
        _ndVerifyFailSnap.clear();
        _diagCatalog.diagResetCounters(_ndDrainStats);
        sectionStats = [];
        currentSection = null;
        detectedMidi = -1;
        detectedConfidence = 0;
        detectedString = -1;
        detectedFret = -1;
        detectedDisplayMidi = -1;
        lastChordScore = null;
        lastChordHit = 0;
        lastChordTotal = 0;
        lastChordTime = -Infinity;
    }

    // Narrower reset used by the A/V auto-calibrate Apply button.
    // Calling resetScoring() there blew away the user's hit/miss
    // counters + streak + section history + event log — surprising
    // for what's framed as a calibration tweak. This clears ONLY the
    // timing-error samples that feed the next calibration suggestion,
    // so the next median reflects the new offset but everything else
    // the user can see on Settings (accuracy, breakdown, per-section)
    // stays intact.
    function _resetCalibrationSamples() {
        _diagCatalog.resetTimingErrors();
    }

    // ── Position-aware score recompute (got-feedback tester report) ────────
    // When the player repositions BACKWARD in the song — the Restart button
    // (restartCurrentSong → _audioSeek 'song-restart') or a manual scrub-back —
    // the live HUD score must reflect only the part of the song up to the new
    // playhead, not keep the stale cumulative total. (Restart to 0 → 0 notes /
    // 0%.) Rebuild it from the ledger:
    //   1. Drop every judgment at/after chart time `t` from the ledger AND the
    //      display/dedup maps, so replaying forward re-judges those notes (the
    //      noteResults.has() guards would otherwise skip them) and they re-count
    //      cleanly instead of double-counting on top of the rolled-back total.
    //   2. Replay the survivors (notes strictly before `t`) in chart-time order
    //      through the SAME streak/multiplier/points rules recordJudgment uses,
    //      so streak, bestStreak, multiplier, maxMultiplier and score are all
    //      consistent with "as if you'd only played up to here".
    // updateHUD()'s 33 ms tick picks up the rebuilt counters; no explicit
    // repaint needed. sectionStats are intentionally left untouched — they feed
    // the end-of-song summary, not the live HUD, and the ledger doesn't carry
    // section membership (a known limitation, same as drill-mode cumulation).
    function _recomputeScoreToPosition(t) {
        if (!Number.isFinite(t)) return;
        for (const [key, e] of _scoreLedger) {
            if (e.t >= t) {
                _scoreLedger.delete(key);
                noteResults.delete(key);
                _susActiveUntil.delete(key);
                _chordLastResult.delete(key);
            }
        }
        const survivors = Array.from(_scoreLedger.values()).sort((a, b) => a.t - b.t);
        hits = 0;
        misses = 0;
        streak = 0;
        bestStreak = 0;
        score = 0;
        multiplier = 1;
        maxMultiplier = 1;
        for (const e of survivors) {
            if (e.hit) {
                hits++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
                multiplier = _ndMultiplierForStreak(streak);
                if (multiplier > maxMultiplier) maxMultiplier = multiplier;
                score += (e.chord ? ND_BASE_CHORD : ND_BASE_SINGLE) * multiplier;
            } else {
                misses++;
                streak = 0;
                multiplier = 1;
            }
        }
    }

    // song:seek handler. Core emits song:seek from its single repositioning
    // funnel (_audioSeek) with { from, to, reason }. A BACKWARD jump on an
    // actively-scoring instance rebuilds the score to the new position.
    function _onSongSeekReposition(e) {
        // Only an enabled instance has a live HUD worth rebuilding. (Bound
        // across the per-song silent-disable, so guard here.)
        if (!enabled) return;
        const d = (e && e.detail) || {};
        const to = Number(d.to);
        if (!Number.isFinite(to)) return;
        // Drill mode keeps its own per-iteration accounting and the global
        // score is intentionally cumulative across loop wraps — never recompute
        // there. The loop-wrap reason is the drill reposition; skip it too as a
        // belt-and-suspenders guard alongside drillEnabled.
        if (_drillConductor.getDrillStats().active || d.reason === 'loop-wrap') return;
        // Only a backward reposition updates the score; a forward seek leaves
        // earlier judgments intact (the player simply skipped ahead). When the
        // origin is unknown, treat it as a reposition worth recomputing.
        const from = Number(d.from);
        const movedBack = Number.isFinite(from) ? (to < from - 0.05) : true;
        if (!movedBack) return;
        _recomputeScoreToPosition(to);
    }

    function _seekResetBindEvents() {
        if (seekResetSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _onSongSeekReposition;
        try {
            window.slopsmith.on('song:seek', fn);
        } catch (e) {
            return;
        }
        seekResetOnSeekFn = fn;
        seekResetSubscribed = true;
    }

    function _seekResetUnbindEvents() {
        if (!seekResetSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && seekResetOnSeekFn) {
            try { window.slopsmith.off('song:seek', seekResetOnSeekFn); } catch (e) {}
        }
        seekResetSubscribed = false;
        seekResetOnSeekFn = null;
    }

    // _drillCurrentLoop → src/drill-conductor.js (nd-carve-5 cut 3)

    // _hostGetSpeed → src/drill-conductor.js (nd-carve-5 cut 3)

    // _hostSetSpeed → src/drill-conductor.js (nd-carve-5 cut 3)

    // _maybeAutoDrill → src/drill-conductor.js (nd-carve-5 cut 3)

    // startDrill → src/drill-conductor.js (nd-carve-5 cut 3)

    // startDrillHere → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillSyncRangeFromLoop → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillExpandLoop → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillChartedCount → src/drill-conductor.js (nd-carve-5 cut 3)

    // Drop every judgment whose chart time falls in [a, b] so a drill iteration
    // scores only what the player does THIS pass. Called at drill start and
    // after scoring each wrap — the conductor can't rely on the browser-only
    // reopen-on-seek (skipped on the engine-verifier path), which is what let
    // stale first-play hits keep re-scoring and "graduate" an untouched loop.
    function _drillClearWindow(a, b) {
        for (const [key, v] of noteResults) {
            const t = Number.isFinite(v && v.noteTime) ? v.noteTime
                : parseFloat(String(key).split('_')[0]);
            if (Number.isFinite(t) && t >= a && t <= b) {
                noteResults.delete(key);
                _susActiveUntil.delete(key);
                // Mirror _recomputeScoreToPosition: also drop the chord
                // voicing-rescue cache so a chord straddling the loop boundary
                // can't keep a stale voicingHit:true and rescue an unplayed
                // chord on a silent pass (inflating that pass's score).
                _chordLastResult.delete(key);
            }
        }
    }

    // _drillConductorOnWrap → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillConductorTick → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillInitBeats → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillScheduleDueClicks → src/drill-conductor.js (nd-carve-5 cut 3)

    // endDrill → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillConductorShowHud → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillConductorUpdateHud → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillAdjustLoop → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillConductorHideHud → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillResetIteration → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillSnapshotIteration → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillOnLoopRestart → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillOnSongChanged → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillBindEvents → src/drill-conductor.js (nd-carve-5 cut 3)

    // ── Chart state sync ─────────────────────────────────────────────
    //
    // `currentArrangement` / `currentStringCount` / `tuningOffsets` /
    // `capo` are read on every match/miss frame to map (string, fret)
    // → MIDI. They live in the factory closure and used to be set ONLY
    // inside enable(), inline, with conditional assignments — each
    // field only updated if the corresponding `info.*` was present.
    //
    // That left a stale-state hole: if a previous song (e.g. a bass
    // arrangement) had set currentArrangement='bass', and a new song
    // loaded with `info.arrangement` briefly falsy / null at enable
    // time, the `if (info && info.arrangement)` line wouldn't fire
    // and the bass arrangement carried over into a guitar chart. The
    // smoking-gun symptom in real-session diagnostics: strings 4-5 of
    // a 6-string guitar chart show 0/N hits with `expectedMidi: null`
    // (because the 4-string bass MIDI base array has no entries at
    // [4] / [5]), and strings 0-3 score wildly off-pitch because
    // they're being compared against bass-octave MIDI values.
    //
    // Fixes here:
    //   1) Reset to a known-good 6-string-guitar default BEFORE
    //      reading info, so a partial / missing payload can't leave
    //      stale fields in place.
    //   2) Wire `song:loaded` + `arrangement:changed` listeners so
    //      mid-session song or arrangement switches re-sync state
    //      instead of waiting for the next enable() (which may never
    //      come if Detect was left on).
    function _syncChartStateFromHw() {
        currentArrangement = 'guitar';
        currentStringCount = 6;
        tuningOffsets = [0, 0, 0, 0, 0, 0];
        capo = 0;
        const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : null;
        if (!info) return;
        if (info.arrangement) currentArrangement = _ndArrangementKindFromName(info.arrangement);
        if (Array.isArray(info.tuning)) tuningOffsets = info.tuning;
        if (Number.isFinite(info.capo)) capo = info.capo;

        // String-count resolution, in precedence order:
        //   1. hw.getStringCount() — host's authoritative count. Asked
        //      independently of info.tuning because the host may know
        //      the count even when no tuning array shipped, and because
        //      arrangement XML pads bass tunings to six entries so tuning.length
        //      alone can't distinguish bass-4 from a real 6-string.
        //   2. tuning.length when it's consistent with the arrangement
        //      — bass-4/5 or guitar-6/7/8. This preserves the older-host
        //      path for 7/8-string guitars and 5-string basses, while
        //      rejecting the arrangement XML bass-padded-to-6 shape (which
        //      falls through to (3) below for the correct bass-4).
        //   3. Per-arrangement default — 4 for bass, 6 for guitar.
        //      Closes the regression a bass chart hit when it had no
        //      tuning array AND no host count: currentStringCount used
        //      to stay at 6, then _ndStandardMidiFor('bass', 6) returned
        //      the 4-entry _ND_TUNING_BASS_4 and strings 4/5 retired
        //      with expectedMidi: null.
        //   4. tuning.length — last-resort fallback when no arrangement
        //      is known.
        const hostStringCount = (hw && hw.getStringCount) ? hw.getStringCount() : undefined;
        if (Number.isFinite(hostStringCount)) {
            currentStringCount = hostStringCount;
        } else if (info.arrangement) {
            const tuneLen = Array.isArray(info.tuning) ? info.tuning.length : null;
            const consistent = currentArrangement === 'bass'
                ? (tuneLen === 4 || tuneLen === 5)
                : (tuneLen === 6 || tuneLen === 7 || tuneLen === 8);
            if (consistent) {
                currentStringCount = tuneLen;
            } else {
                currentStringCount = currentArrangement === 'bass' ? 4 : 6;
            }
        } else if (Array.isArray(info.tuning)) {
            currentStringCount = info.tuning.length;
        }
    }

    // ── Engine-side chart verification (desktop bridge) ───────────────────
    // Build the song's note chart from the host and push it to the desktop
    // engine, which scores it continuously on a background thread. Replaces
    // the renderer's per-tick scoreChord IPC loop. Called once per
    // arrangement load (and on song:loaded / arrangement:changed). When the
    // addon predates the NoteVerifier API the function leaves
    // `_ndUsingEngineVerifier` false and the caller keeps the old matchNotes
    // path. Safe to call when the bridge isn't active — it just no-ops.
    // Cheap signature of the currently-loaded chart — raw note/chord counts
    // plus the active arrangement. Changes exactly when the chart the engine
    // should be scoring changes (late load, song change, arrangement switch).
    function _ndChartSignature() {
        if (!hw || typeof hw.getNotes !== 'function') return '';
        // Filtered, so MOVING THE MASTERY SLIDER changes the signature and the
        // detect loop re-pushes the reduced chart to the engine (feedback#226).
        const notes = _ndChartNotes();
        const n = notes.length;
        let c = 0;
        // Content hash over the note/chord IDENTITIES, not just how many there
        // are. Counts + first/last onset were enough when the chart only changed
        // on song/arrangement load, but the mastery slider can swap WHICH notes
        // are displayed without changing HOW MANY — two slider positions with the
        // same total would hash identically and leave the engine scoring a chart
        // that is no longer on screen. FNV-1a over (t, s, f); O(chart) on the
        // 50 ms tick is nothing beside the FFT work already on this path.
        let fnv = 0x811c9dc5;
        const mix = (v) => { fnv ^= (v | 0); fnv = Math.imul(fnv, 0x01000193); };
        // Hash EVERY field _ndPushChartToBridge actually sends, not just position:
        // a difficulty level can swap in the same note at the same string/fret with
        // a different sustain or technique (a note that becomes a sustain, or gains
        // a bend, higher up the ladder). Hashing only t/s/f would leave the engine
        // verifying stale sus/technique data against the new chart.
        const mixNote = (nn) => {
            mix(Math.round((Number.isFinite(nn.t) ? nn.t : 0) * 1000));
            mix(((nn.s | 0) * 100) + (nn.f | 0));
            mix(Math.round((Number.isFinite(nn.sus) ? nn.sus : 0) * 1000));
            mix((nn.ho ? 1 : 0) | (nn.po ? 2 : 0) | (nn.b ? 4 : 0)
                | (nn.sl ? 8 : 0) | (nn.hm ? 16 : 0) | (nn.mt ? 32 : 0));
        };
        for (const nn of notes) if (nn) mixNote(nn);
        for (const ch of _ndChartChords()) {
            const members = (ch && ch.notes) || [];
            c += members.length;
            mix(Math.round((ch && Number.isFinite(ch.t) ? ch.t : 0) * 1000));
            // Each constituent in full, not just how many there are: a difficulty
            // change can swap a chord's VOICING at the same onset with the same
            // member count, and the engine would keep scoring the old frets.
            // Mirrors the flattened payload _ndPushChartToBridge() sends.
            for (const m of members) if (m) mixNote({ ...m, t: (ch && ch.t) });
        }
        // timingTolerance / pitchTolerance are part of the signature so moving
        // a tolerance slider re-pushes the chart and the engine picks the new
        // value up live — without this the popup sliders are inert on the
        // engine-verifier path until the next song/arrangement change.
        return n + ':' + c + ':' + currentArrangement + ':' + currentStringCount
            + ':' + capo + ':' + timingTolerance + ':' + pitchTolerance
            + ':' + (fnv >>> 0);
    }

    async function _ndPushChartToBridge() {
        // A contained-playback verifier owns the engine chart slot. A host
        // event (song:loaded, enable, the per-tick re-push) must NOT push the
        // host chart over the contained one, nor wipe the host verifier state
        // we restore on release — so bail before touching anything. The
        // restore path (_ndRestoreHostChart) clears the flag first, so its own
        // re-push proceeds normally. Also bail when a SIBLING instance owns the
        // contained slot on our source (it isn't suspended on our flag).
        if (_ndHostChartSuspended || _ndOtherOwnsOurSlot()) return;
        _ndUsingEngineVerifier = false;
        _ndVerifierChartById = new Map();
        _ndVerifierChords = new Map();
        _ndVerifierChordKeyOf = new Map();
        _ndPendingChords = new Map();
        _ndVerifierChartSig = '';
        _ndLastPushedPlayhead = 0;
        // Native-frame mode runs the local matchNotes pipeline (with engine
        // scoreChord for chords), so the continuous engine chart-verifier is
        // intentionally OFF — leave _ndUsingEngineVerifier false and don't
        // push a chart for it.
        if (!usingDesktopBridge || usingNativeFrames || !bridgeDesktop || !bridgeDesktop.audio) return;
        if (!_ndBridgeVerifierAvailable()) {
            // Downlevel addon (or, for a bound source, no source-indexed verifier
            // API) — fall back to the legacy matchNotes path.
            return;
        }
        if (!hw || typeof hw.getNotes !== 'function' || typeof hw.getChords !== 'function') return;

        const notes = [];
        const byId = new Map();
        // Chord grouping, built alongside `notes` — see _ndVerifierChords.
        const chordGroups = new Map();
        const chordKeyById = new Map();
        // Single notes. `mt` (muted) notes are skipped — the legacy
        // matchNotes path skips them too (`if (n.mt) continue`).
        const single = _ndChartNotes();
        for (const n of single) {
            if (!n || n.mt) continue;
            const id = noteKey(n, n.t);
            if (byId.has(id)) continue;
            const entry = {
                id,
                t: n.t,
                s: n.s,
                f: n.f,
                sus: Number.isFinite(n.sus) ? n.sus : 0,
                ho: !!n.ho, po: !!n.po, b: !!n.b, sl: !!n.sl, hm: !!n.hm,
            };
            notes.push(entry);
            byId.set(id, { ...n });
        }
        // Chord constituents from the (filtered) chart — pushed as plain
        // notes; chord grouping happens by timestamp below.
        const chords = _ndChartChords();
        for (const c of chords) {
            for (const cn of (c.notes || [])) {
                if (!cn || cn.mt) continue;
                const id = noteKey(cn, c.t);
                if (byId.has(id)) continue;
                const entry = {
                    id,
                    t: c.t,
                    s: cn.s,
                    f: cn.f,
                    sus: Number.isFinite(cn.sus) ? cn.sus : 0,
                    ho: !!cn.ho, po: !!cn.po, b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                };
                notes.push(entry);
                byId.set(id, { ...cn, t: c.t });
            }
        }
        // Chord grouping by shared onset time. A power chord / double-stop is
        // 2+ notes at the same chart time — and in many arrangements (the
        // "I'm Alive" Lead included) those arrive through hw.getNotes(), not
        // hw.getChords(). Grouping the flattened note list by timestamp catches
        // chords regardless of which host array delivered them.
        const byTime = new Map();
        for (const e of notes) {
            const tk = e.t.toFixed(3);
            if (!byTime.has(tk)) byTime.set(tk, []);
            byTime.get(tk).push(e);
        }
        for (const [tk, grp] of byTime) {
            if (grp.length < 2) continue;
            const chordKey = tk + '_chord';
            let maxSus = 0;
            for (const e of grp) if ((e.sus || 0) > maxSus) maxSus = e.sus || 0;
            chordGroups.set(chordKey, {
                t: grp[0].t,
                memberIds: grp.map(e => e.id),
                memberNotes: grp.map(e => ({ s: e.s, f: e.f })),
                maxSus,
            });
            for (const e of grp) chordKeyById.set(e.id, chordKey);
        }

        try {
            const verifyParams = _ndVerifyParamsFor(currentArrangement);
            const ok = await _ndBridgeSetChart({
                arrangement: currentArrangement,
                stringCount: currentStringCount,
                tuningOffsets: tuningOffsets.slice(0, currentStringCount),
                capo,
                // The engine's harmonic-comb uses pitchCheckCents as its
                // presence gate — feed the user's Pitch tolerance slider so
                // it is honoured, rather than a fixed constant.
                pitchCheckCents: pitchTolerance,
                harmonicSnr: verifyParams.harmonicSnr,
                // Relax the fundamental-presence gate for bass — its DI
                // fundamental is legitimately weak (see _ndVerifyParamsFor).
                fundamentalRatio: verifyParams.fundamentalRatio,
                // Temporal-persistence floor — bass rejects wrong-position notes
                // that only flicker present on a few frames (see
                // _ndVerifyParamsFor). 0 on guitar keeps the legacy any-frame rule.
                presenceRatio: verifyParams.presenceRatio,
                timingTolerance,
                notes,
            });
            // setChart resolves null on a downlevel addon — keep the legacy
            // path in that case.
            if (ok === null || ok === false) return;
            _ndVerifierChartById = byId;
            _ndVerifierChords = chordGroups;
            _ndVerifierChordKeyOf = chordKeyById;
            _ndPendingChords = new Map();
            _ndVerifierChartSig = _ndChartSignature();
            _ndUsingEngineVerifier = true;
            console.log(`[note_detect] engine chart verifier active — ${notes.length} notes pushed`
                + ` (${chordGroups.size} chords)`);
        } catch (e) {
            console.warn('[note_detect] setChart failed, falling back to matchNotes:',
                e && e.message ? e.message : e);
        }
    }

    // Drain the verdicts the engine's NoteVerifier has finalized and feed
    // each through the SAME judgment pipeline the legacy path uses, so HUD /
    // notedetect:* events / live-judgment JSONL all fire unchanged.
    async function _ndDrainEngineVerdicts() {
        if (!_ndUsingEngineVerifier || !bridgeDesktop || !bridgeDesktop.audio) return;

        // The engine scores against a playhead the renderer pushes: its own
        // JUCE backing transport is frozen for HTML5-routed (sloppak) songs.
        // Push the same corrected clock the legacy matchNotes() path judges
        // against — hw.getTime() + avOffset - latencyOffset.
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const playheadAudio = (hw.getTime ? hw.getTime() : 0) + avOffsetSec - latencyOffset;
        const playing = !!(window.slopsmith && window.slopsmith.isPlaying);

        // A backward jump (drill A-B loop wrap or a manual seek-back): the
        // engine re-opens notes at/after the new position, so drop our dedup
        // entries for those same notes. Otherwise the re-scored verdicts are
        // skipped by the _ndAlreadyCounted() guard below and a drilled passage
        // scores only on its first iteration. 0.25 s matches the engine's own
        // backward-jump threshold.
        //
        // _scoreLedger is dropped in lockstep with noteResults: it now backs
        // that guard, so leaving a re-opened note in the ledger would keep it
        // suppressed forever. recordJudgment re-ledgers each note as it
        // re-scores, and the entry it writes is the same one it would have
        // overwritten in place, so the rebuilt ledger is unchanged.
        if (playheadAudio < _ndLastPushedPlayhead - 0.25) {
            for (const [id, cn] of _ndVerifierChartById) {
                if (cn && Number.isFinite(cn.t) && cn.t >= playheadAudio) {
                    noteResults.delete(id);
                    _scoreLedger.delete(id);
                    _susActiveUntil.delete(id);
                }
            }
            // Re-opened chords: drop the chord judgment + any half-collected
            // verdicts so the next pass can re-grade the whole chord.
            for (const [ckey, grp] of _ndVerifierChords) {
                if (grp && Number.isFinite(grp.t) && grp.t >= playheadAudio) {
                    noteResults.delete(ckey);
                    _scoreLedger.delete(ckey);
                    _ndPendingChords.delete(ckey);
                }
            }
        }
        _ndLastPushedPlayhead = playheadAudio;

        let verdicts = null;
        try {
            verdicts = await _ndBridgeGetVerdicts(playheadAudio, playing);
        } catch (e) {
            console.warn('[note_detect] getNoteVerdicts failed:', e && e.message ? e.message : e);
            return;
        }
        if (!Array.isArray(verdicts) || verdicts.length === 0) return;
        if (verdicts.length > _ndDrainStats.maxBatch) _ndDrainStats.maxBatch = verdicts.length;

        for (const v of verdicts) {
            if (!v || typeof v.id !== 'string') continue;
            const cn = _ndVerifierChartById.get(v.id);
            if (!cn) { _ndDrainStats.dropUnknownId++; continue; }

            // Silence gate — see _ndLevelSamples. If the input was below
            // the silence threshold across the entire ±200 ms window
            // around this note's chart time, the engine's "detected:true"
            // is almost certainly a CREPE-on-silence phantom-pitch false
            // positive. Force a miss so the HUD reflects "nothing was
            // played" instead of the engine's optimistic verdict.
            //
            // Skip the gate entirely if the window contained no level
            // samples — e.g. startup, level-meter hiccup, or right after a
            // backward-seek reset cleared the buffer. Treating "no
            // telemetry" as "silent" would force false misses on legitimate
            // detections in those transient states.
            const engineDetectedRaw = !!v.detected;
            const strikeCtx = _ndStrikeLevelContext(cn.t);
            if (v.detected && _ndLevelSamples.length > 0) {
                // _ndLevelSamples are timestamped in the visual clock
                // (hw.getTime() + avOffset), but `cn.t` (and everywhere
                // else in this file that compares times against chart
                // notes) is audio-aligned — see the
                // `hw.getTime() + avOffset - latencyOffset` formula the
                // detection pipeline uses to align audio to chart. So
                // visual time = audio/chart time + latencyOffset. To
                // find level samples that match this note's chart time,
                // center the search at `cn.t + latencyOffset` in visual
                // time; otherwise the configured user latency (up to
                // 250 ms) would push the real peak outside the
                // ±_ND_LEVEL_WIN_HALF window and trip false misses.
                if (strikeCtx.silenceWouldTrigger) {
                    const expectedMidiSg = _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    );
                    _ndLogVerifierRejectOnce('silence:' + v.id, {
                        reason: 'SILENCE_GATE',
                        path: 'desktop-engine-verifier',
                        skipOpenDomainPitchFallback: true,
                        verifierId: v.id,
                        playheadAudio,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi: expectedMidiSg,
                        engineDetectedRaw,
                        engineDetected: false,
                        silenceGateApplied: true,
                        strikePeakPct: strikeCtx.strikePeakPct,
                        strikeSamplesInWindow: strikeCtx.strikeSamplesInWindow,
                        inputLevelAtLogPct: strikeCtx.levelAtLogPct,
                        inputPeakPct: strikeCtx.strikePeakPct,
                        rendererPitchPolled: false,
                        detectedSongTime: Number.isFinite(v.detectedSongTime)
                            ? v.detectedSongTime
                            : null,
                        pitchErrorCents: Number.isFinite(v.centsError) ? v.centsError : null,
                        engineVerdict: _ndSnapshotEngineVerdict(v),
                    });
                    v.detected = false;
                }
            }

            // Chord constituent — buffer the verdict until every member of
            // the chord has reported, then judge the whole chord at once
            // with N-of-M leniency (see _ndFinalizeChordVerdict).
            const chordKey = _ndVerifierChordKeyOf.get(v.id);
            if (chordKey) {
                // Chord already judged — a re-delivery, not a new strum.
                if (_ndAlreadyCounted(chordKey)) { _ndDrainStats.suppressedRedelivery++; continue; }
                let pc = _ndPendingChords.get(chordKey);
                if (!pc) { pc = new Map(); _ndPendingChords.set(chordKey, pc); }
                pc.set(v.id, v);
                const grp = _ndVerifierChords.get(chordKey);
                if (grp && pc.size >= grp.memberIds.length) {
                    _ndFinalizeChordVerdict(chordKey, grp, pc);
                    _ndPendingChords.delete(chordKey);
                }
                continue;
            }

            // Lone single note.
            const key = v.id;
            if (_ndAlreadyCounted(key)) { _ndDrainStats.suppressedRedelivery++; continue; }

            const expectedMidi = _ndMidiFromStringFret(
                cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            if (v.detected) {
                // detectedSongTime is the playhead the renderer pushed, which
                // is already avOffset/latency-corrected — use it directly. (It
                // was previously the engine's own backing clock and needed the
                // correction here; re-applying it now would double-correct.)
                const judgedAt = v.detectedSongTime;
                const pitchError = Number.isFinite(v.centsError) ? v.centsError : null;
                const detectedMidiForJudgment = Number.isFinite(pitchError)
                    ? expectedMidi + pitchError / 100
                    : null;
                // A bend / slide / harmonic note's pitch deliberately leaves
                // the chart pitch; widen the pitch gate so the hit rides on
                // presence + timing, not a moving target.
                const lenientPitch = !!(cn.b || cn.sl || cn.hm);
                const judgment = makeMatchedJudgment(
                    cn, cn.t, judgedAt, expectedMidi, detectedMidiForJudgment, 1,
                    { pitchError, pitchThresholdCents: lenientPitch ? 600 : undefined }
                );
                if (!judgment.hit) {
                    const teReason = judgment.timingState === 'EARLY' || judgment.timingState === 'LATE'
                        ? 'TIMING_FAIL'
                        : (judgment.pitchState === 'SHARP' || judgment.pitchState === 'FLAT'
                            ? 'PITCH_FAIL'
                            : 'UNKNOWN');
                    _ndLogVerifierRejectOnce(key, {
                        reason: teReason,
                        path: 'desktop-engine-verifier',
                        verifierId: v.id,
                        playheadAudio,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi,
                        detectedMidi: detectedMidiForJudgment,
                        confidence: 1,
                        engineDetectedRaw,
                        engineDetected: true,
                        silenceGateApplied: false,
                        detectedSongTime: judgedAt,
                        strikePeakPct: strikeCtx.strikePeakPct,
                        strikeSamplesInWindow: strikeCtx.strikeSamplesInWindow,
                        inputLevelAtLogPct: strikeCtx.levelAtLogPct,
                        rendererPitchPolled: false,
                        timingErrorMs: judgment.timingError,
                        pitchErrorCents: judgment.pitchError,
                        engineVerdict: _ndSnapshotEngineVerdict(v),
                    });
                }
                recordJudgment(key, judgment);
            } else {
                // Engine finalized the note as a miss — its timing window
                // has fully passed. Mirror the legacy checkMisses() retire.
                const t = (hw.getTime ? hw.getTime() : 0) + avOffsetSec - latencyOffset;
                if (!_ndRejectDedup.has('silence:' + key)) {
                    let timingErrorMs = null;
                    if (Number.isFinite(v.timingErrorMs)) timingErrorMs = v.timingErrorMs;
                    else if (Number.isFinite(v.timingError)) timingErrorMs = v.timingError;
                    else if (Number.isFinite(v.detectedSongTime) && Number.isFinite(cn.t)) {
                        timingErrorMs = Math.round((v.detectedSongTime - cn.t) * 1000);
                    }
                    _ndLogVerifierRejectOnce(key, {
                        reason: 'NO_VERDICT',
                        path: 'desktop-engine-verifier',
                        skipOpenDomainPitchFallback: true,
                        verifierId: v.id,
                        playheadAudio,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi,
                        engineDetectedRaw,
                        engineDetected: false,
                        silenceGateApplied: false,
                        detectedSongTime: Number.isFinite(v.detectedSongTime)
                            ? v.detectedSongTime
                            : null,
                        strikePeakPct: strikeCtx.strikePeakPct,
                        strikeSamplesInWindow: strikeCtx.strikeSamplesInWindow,
                        inputLevelAtLogPct: strikeCtx.levelAtLogPct,
                        rendererPitchPolled: false,
                        timingErrorMs,
                        pitchErrorCents: Number.isFinite(v.centsError) ? v.centsError : null,
                        engineVerdict: _ndSnapshotEngineVerdict(v),
                    });
                }
                recordJudgment(key, makeMissJudgment(cn, cn.t, t, expectedMidi));
            }
        }

        // Flush stuck chords. A chord is normally judged once every
        // constituent reports a verdict; if the engine ever drops one, the
        // chord would sit in _ndPendingChords forever (checkMisses is
        // short-circuited on this path). Once a pending chord's window has
        // long passed, finalize it with whatever verdicts did arrive —
        // _ndFinalizeChordVerdict handles a partial set (missing members
        // simply don't count toward hitStrings).
        for (const [ckey, pc] of _ndPendingChords) {
            const grp = _ndVerifierChords.get(ckey);
            if (!grp) { _ndPendingChords.delete(ckey); continue; }
            if (playheadAudio > grp.t + (grp.maxSus || 0) + timingTolerance + 1.0) {
                _ndFinalizeChordVerdict(ckey, grp, pc);
                _ndPendingChords.delete(ckey);
            }
        }
    }

    // Judge a whole chord from its constituents' engine verdicts. A chord is
    // a hit when at least chordHitRatio of its strings verified (N-of-M
    // leniency) — power-chord constituents share harmonics, so demanding
    // every string would reject chords that clearly rang. Emits one chord
    // judgment (chord:true), mirroring the legacy chord path.
    function _ndFinalizeChordVerdict(chordKey, grp, verdictMap) {
        if (_ndAlreadyCounted(chordKey)) return;
        let hitStrings = 0;
        let detectedTime = null;   // onset-derived time from a struck string
        let bestCents = null;
        for (const id of grp.memberIds) {
            const v = verdictMap.get(id);
            if (v && v.detected) {
                hitStrings++;
                if (detectedTime === null) detectedTime = v.detectedSongTime;
                if (bestCents === null && Number.isFinite(v.centsError)) bestCents = v.centsError;
            }
        }
        const totalStrings = grp.memberIds.length;
        const score = totalStrings > 0 ? hitStrings / totalStrings : 0;
        const lead = _ndVerifierChartById.get(grp.memberIds[0]) || { s: 0, f: 0 };
        const expectedMidi = _ndMidiFromStringFret(
            lead.s, lead.f, currentArrangement, currentStringCount, tuningOffsets, capo
        );
        const lateGraceMs = Math.min((grp.maxSus || 0) * 1000, 1000);

        const chordIsHit = score >= chordHitRatio && detectedTime !== null;
        if (chordIsHit) {
            const detMidi = Number.isFinite(bestCents) ? expectedMidi + bestCents / 100 : null;
            recordJudgment(chordKey, makeMatchedJudgment(
                lead, grp.t, detectedTime, expectedMidi, detMidi, 1,
                { chord: true, notes: grp.memberNotes, hitStrings, totalStrings,
                  score, pitchError: bestCents, lateGraceMs }
            ));
        } else {
            // Match the legacy chord-miss path: judgedAt is the current
            // corrected playhead (matchChords' `t`, not the chord's chart
            // time), and lateGraceMs is included so a chord with a long
            // sustain stays open to a late grab — both fields needed for
            // _ndMakeJudgment's timing classification to give the same
            // result as the legacy browser/desktop chord-miss path.
            const avOffsetSecMiss = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
            const missJudgedAt = (hw.getTime ? hw.getTime() : 0) + avOffsetSecMiss - latencyOffset;
            _ndLogVerifierRejectOnce(chordKey, {
                reason: 'CHORD_RATIO_FAIL',
                noteTime: grp.t,
                chord: true,
                expectedMidi,
                hitStrings,
                totalStrings,
                chordScore: score,
            });
            recordJudgment(chordKey, makeMissJudgment(
                lead, grp.t, missJudgedAt, expectedMidi,
                { chord: true, notes: grp.memberNotes, hitStrings, totalStrings, score, lateGraceMs }
            ));
        }

        // Stash a per-constituent judgment for every chord string, keyed by
        // its own noteKey (== its engine id). The chord-level judgment above
        // owns the HUD totals / event log; these per-string entries exist
        // purely so the highway's note-state provider (slopsmith#254) can
        // tint each chord gem and the chord frame. Without them the engine
        // path stored only `chordKey`, which the highway never queries —
        // hence the missing chord hit/miss feedback.
        //
        // Every constituent carries the *chord-level* verdict, not its own
        // string's detection: a chord is judged as a unit under N-of-M
        // leniency — power-chord strings share harmonics, so not every
        // string verifies individually even on a clean strum. Tinting each
        // gem and the chord frame with the unit verdict keeps them
        // consistent: the frame goes green when the chord scored a hit,
        // instead of red because one harmonically-masked string failed to
        // verify on its own. (Stashed straight into noteResults +
        // _recordPerStringForChord, bypassing recordJudgment so the chord
        // isn't double-counted in HUD totals.)
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const nowSongT = (hw.getTime ? hw.getTime() : 0) + avOffsetSec;
        const missAt = nowSongT - latencyOffset;
        for (const id of grp.memberIds) {
            if (noteResults.has(id)) continue;
            const mcn = _ndVerifierChartById.get(id);
            if (!mcn) continue;
            const mExpectedMidi = _ndMidiFromStringFret(
                mcn.s, mcn.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            // The noteResults entry is stamped with the chord-level verdict
            // (so the highway tints every chord gem and the chord frame
            // consistently — power-chord strings share harmonics and aren't
            // each independently verifiable under N-of-M leniency). But the
            // per-string diagnostic counter (_diagPerString via
            // _recordPerStringForChord) needs the *individual* constituent
            // outcome to stay accurate — otherwise a 4-string chord scored
            // hit via N-of-M would credit all four strings as hits even
            // when only two were actually detected, inflating per-string
            // accuracy.
            const constituentDetected = !!(verdictMap.get(id) || {}).detected;
            let mJudgment;
            if (chordIsHit) {
                // Pass `chord: true` so _ndMakeJudgment routes through the
                // chord-judgment branch and the per-constituent `hit`
                // tracks the chord-level verdict (timing-only). Without
                // it, `hit` gets gated by per-string pitchState/
                // pitchHitThreshold and can become false even when
                // chordIsHit is true — e.g. a chord scored a hit via
                // N-of-M leniency but bestCents (lifted from one
                // constituent) sits outside the 28¢ pitch threshold.
                // That false-`hit` would then make noteStateFor return
                // 'miss' for the constituent, undoing the whole point of
                // stamping it with the chord verdict.
                const lenientPitch = !!(mcn.b || mcn.sl || mcn.hm);
                const mDetMidi = Number.isFinite(bestCents)
                    ? mExpectedMidi + bestCents / 100 : null;
                mJudgment = makeMatchedJudgment(
                    mcn, mcn.t, detectedTime, mExpectedMidi, mDetMidi, 1,
                    { chord: true, pitchError: bestCents,
                      pitchThresholdCents: lenientPitch ? 600 : undefined,
                      lateGraceMs }
                );
            } else {
                mJudgment = makeMissJudgment(mcn, mcn.t, missAt, mExpectedMidi,
                    { chord: true, lateGraceMs });
            }
            // Verdict landed now — anchor the highway gem's display window
            // here (see recordJudgment / noteStateFor).
            mJudgment._ndDisplayFrom = nowSongT;
            noteResults.set(id, mJudgment);
            // Per-string diagnostic uses the individual outcome rather than
            // the unit chord verdict. Built as a minimal shape — only `hit`
            // and `chartNote` are read by _recordPerStringForChord.
            _diagCatalog.recordPerStringForChord({ hit: constituentDetected, chartNote: mcn });
        }
    }

    // ── Contained-playback verifier implementation ───────────────────────────
    // True when this build can run a contained verifier: the desktop bridge
    // exposes the continuous chart-verifier API. Browser / downlevel addon →
    // false, and setContainedChart returns null so the consumer falls back.
    function _ndContainedVerifierAvailable() {
        return usingDesktopBridge && _ndBridgeVerifierAvailable();
    }

    // True when ANOTHER detector instance owns the contained slot on the SAME
    // engine source this instance pushes to — so we must NOT touch that shared
    // slot (re-push our host chart, drain host verdicts) or we'd overwrite its
    // contained chart. _ndHostChartSuspended only covers the OWNING instance;
    // this covers the others on that source. A different source = a different
    // slot = no contention.
    function _ndOtherOwnsOurSlot() {
        const owner = _ndShared.containedSlotOwners.get(sourceId);
        return !!owner && owner !== api;
    }

    // Park host-song scoring while a contained chart owns the engine slot.
    // Flips the suspend gate BEFORE any await in the caller, so an interleaving
    // detect tick already sees it.
    function _ndSuspendHostChart() {
        if (_ndHostChartSuspended) return;
        _ndHostChartSuspended = true;
        // Park the flag so a straggler tick that slipped past the suspend gate
        // can't drain host verdicts against the contained chart.
        _ndUsingEngineVerifier = false;
    }

    // Restore host-song scoring after a contained chart is released. Forces a
    // fresh host chart push (the engine slot still holds the contained chart),
    // re-arming _ndUsingEngineVerifier on a live host song.
    async function _ndRestoreHostChart() {
        if (!_ndHostChartSuspended) return;
        _ndHostChartSuspended = false;
        // If a sibling instance grabbed the contained slot on our source in the
        // meantime, don't re-push our host chart over its contained chart.
        if (_ndOtherOwnsOurSlot()) return;
        // Force a re-push: the signature guard in the detect loop compares
        // against _ndVerifierChartSig, which _ndPushChartToBridge resets, so a
        // direct call here re-pushes the host chart over the contained one.
        try {
            await _ndPushChartToBridge();
        } catch (e) {
            console.warn('[note_detect] host chart restore failed:', e && e.message ? e.message : e);
        }
    }

    // Arm a contained-playback chart: take the engine slot, suspend host
    // scoring, and push the caller's notes (scored against an optional tuning
    // ctx — see _ndSanitizeVerifyCtx). Returns true on success, false when
    // another instance already owns the slot, null on browser/downlevel.
    async function _ndSetContainedChart(notes, ctx) {
        if (!_ndContainedVerifierAvailable()) return null;
        if (!Array.isArray(notes) || notes.length === 0) {
            // Empty/null → treat as a clear, and report NOT ARMED (false). The
            // return value is uniformly "is a contained chart now armed?", so a
            // caller that armed with an empty set falls back rather than believing
            // contained mode is live with nothing on the slot. Release whenever
            // THIS instance holds contained state in ANY form — active, or merely
            // claimed/suspended with a setChart IPC still in flight — so the clear
            // also CANCELS an in-flight arm (release bumps _ndContainedGen, which
            // makes that arm's resume bail). Checking _ndContainedActive alone
            // would miss the in-flight window (active is false until success).
            if (_ndContainedActive || _ndHostChartSuspended || _ndShared.containedSlotOwners.get(sourceId) === api) {
                await _ndReleaseContainedChart();
            }
            return false;
        }
        // One chart slot PER engine source. Refuse if a DIFFERENT instance holds
        // the slot on OUR source (our own re-arm is fine; a different source is a
        // different slot, so it doesn't contend).
        if (_ndOtherOwnsOurSlot()) {
            return false;
        }

        const vctx = _ndSanitizeVerifyCtx(ctx);   // null → host live tuning
        const arrangement = vctx ? vctx.arrangement : currentArrangement;
        const stringCount = vctx ? vctx.stringCount : currentStringCount;
        const offsets = vctx ? vctx.offsets.slice(0, stringCount)
            : tuningOffsets.slice(0, currentStringCount);
        const containedCapo = vctx ? vctx.capo : capo;

        // Sanitize the caller's notes into engine entries. The caller supplies
        // a stable `id` per note so a drained verdict maps back to its exercise
        // note; without one we can't return a usable verdict, so skip it.
        const entries = [];
        const byId = new Map();
        for (const n of (notes || [])) {
            if (!n || typeof n.id !== 'string' || !n.id) continue;
            if (!Number.isInteger(n.s) || n.s < 0 || n.s >= stringCount) continue;
            if (!Number.isInteger(n.f) || n.f < 0) continue;
            if (byId.has(n.id)) continue;
            const entry = {
                id: n.id,
                t: Number.isFinite(n.t) ? n.t : 0,
                s: n.s,
                f: n.f,
                sus: Number.isFinite(n.sus) ? n.sus : 0,
                ho: !!n.ho, po: !!n.po, b: !!n.b, sl: !!n.sl, hm: !!n.hm,
            };
            entries.push(entry);
            byId.set(n.id, { ...n });
        }
        // Nothing well-formed to push — DON'T claim the slot or suspend host
        // scoring (else the caller believes it's armed while the host keeps
        // running). Return false so the consumer falls back.
        if (entries.length === 0) return false;

        // Claim the single engine slot SYNCHRONOUSLY — before any await — so a
        // concurrent arm on another instance is refused (it sees the owner set),
        // and stamp a generation so a release/disable/newer-arm during the
        // setChart IPC invalidates this continuation.
        const myGen = ++_ndContainedGen;
        _ndShared.containedSlotOwners.set(sourceId, api);   // claim the slot on our source
        // Re-arm safety: mark NOT-active until the new chart is confirmed. On a
        // re-arm by the same instance the previous chart was still active, and a
        // pushContainedPlayhead during the new setChart IPC would otherwise drain
        // the OLD chart (the engine slot/byId map don't update until the await
        // resolves). Cleared here, set true only on success below.
        _ndContainedActive = false;
        _ndContainedVerdictBuf = [];
        // Suspend host scoring BEFORE the setChart await so an interleaving
        // host detect tick already sees the gate.
        _ndSuspendHostChart();

        const verifyParams = _ndVerifyParamsFor(arrangement);
        let ok = null;
        try {
            ok = await _ndBridgeSetChart({
                arrangement,
                stringCount,
                tuningOffsets: offsets,
                capo: containedCapo,
                // A contained consumer has no host Pitch-tolerance slider —
                // use the arrangement's verify cents (guitar 50 / bass 60).
                pitchCheckCents: arrangement === 'bass'
                    ? _ND_VERIFY_PITCH_CENTS_BASS : _ND_VERIFY_PITCH_CENTS,
                harmonicSnr: verifyParams.harmonicSnr,
                fundamentalRatio: verifyParams.fundamentalRatio,
                presenceRatio: verifyParams.presenceRatio,
                timingTolerance,
                notes: entries,
            });
        } catch (e) {
            console.warn('[note_detect] setContainedChart failed:', e && e.message ? e.message : e);
            ok = null;
        }
        // Superseded while the setChart IPC was in flight (a release/disable, or
        // a newer arm)? Don't resurrect contained mode. If a release ran, OUR
        // chart may have landed on the engine slot AFTER its host re-push — so
        // force the host chart back, but ONLY when our slot is now unowned: if a
        // newer arm (ours) or another instance owns it, leave it to them (don't
        // clobber). A different-source owner doesn't own OUR slot, so we still
        // restore.
        //
        // Note on two arms racing the SAME source within one IPC round-trip: the
        // newer owner is whoever called setChart last, and `audio:setChart` rides
        // a single ordered ipcRenderer.invoke channel, so the newer arm's chart
        // lands last on the slot. We rely on that ordering rather than a per-source
        // IPC lock — and in practice the only contained consumer is the default
        // singleton (one source), so two same-source arms don't occur.
        if (myGen !== _ndContainedGen) {
            const slotOwnedHere = !!_ndShared.containedSlotOwners.get(sourceId);
            if (!slotOwnedHere && !_ndHostChartSuspended) {
                try { _ndVerifierChartSig = ''; await _ndPushChartToBridge(); } catch (_) {}
            }
            return false;
        }
        if (ok === null || ok === false) {
            // Push failed (downlevel / error) — release the slot claim and undo
            // the suspend so host scoring resumes cleanly.
            if (_ndShared.containedSlotOwners.get(sourceId) === api) _ndShared.containedSlotOwners.delete(sourceId);
            await _ndRestoreHostChart();
            return ok;
        }
        _ndContainedActive = true;
        _ndContainedById = byId;
        _ndContainedCtx = vctx;
        _ndContainedVerdictBuf = [];
        _ndContainedLastPlayhead = 0;
        // (slot ownership was claimed synchronously above)
        console.log(`[note_detect] contained verifier active — ${entries.length} notes`
            + ` (${arrangement}, ${stringCount} strings)`);
        return true;
    }

    // Drive the engine clock with the consumer's OWN playhead and stash the
    // finalized verdicts for drainContainedVerdicts(). `t` is the consumer's
    // already-corrected exercise time — pushed verbatim (no host avOffset /
    // latency math; the consumer owns its clock).
    async function _ndPushContainedPlayhead(t, playing) {
        // Only the slot owner drives the engine, and only while armed — a stale
        // instance (lost the owner race, or released) must not advance/drain the
        // shared verifier against another consumer's chart.
        if (!_ndContainedActive || _ndShared.containedSlotOwners.get(sourceId) !== api) return;
        const myGen = _ndContainedGen;
        const songTime = Number.isFinite(t) ? t : 0;
        // Backward jump (drill loop / restart): drop buffered verdicts for
        // notes at/after the new position so they can be re-collected.
        if (songTime < _ndContainedLastPlayhead - 0.25 && _ndContainedVerdictBuf.length) {
            _ndContainedVerdictBuf = _ndContainedVerdictBuf.filter(v => {
                const cn = v && _ndContainedById.get(v.id);
                return !(cn && Number.isFinite(cn.t) && cn.t >= songTime);
            });
        }
        _ndContainedLastPlayhead = songTime;
        let verdicts = null;
        try {
            verdicts = await _ndBridgeGetVerdicts(songTime, !!playing);
        } catch (e) {
            console.warn('[note_detect] contained getNoteVerdicts failed:',
                e && e.message ? e.message : e);
            return;
        }
        // Released / disabled / re-armed while the getNoteVerdicts IPC was in
        // flight — drop this result rather than buffer it against stale state.
        if (myGen !== _ndContainedGen || !_ndContainedActive) return;
        if (Array.isArray(verdicts) && verdicts.length) {
            for (const v of verdicts) {
                if (v && typeof v.id === 'string' && _ndContainedById.has(v.id)) {
                    _ndContainedVerdictBuf.push(v);
                }
            }
            // Bound the buffer (a stalled/forgetful consumer): keep the most
            // recent, drop the oldest.
            if (_ndContainedVerdictBuf.length > _ND_CONTAINED_BUF_MAX) {
                _ndContainedVerdictBuf.splice(0, _ndContainedVerdictBuf.length - _ND_CONTAINED_BUF_MAX);
            }
        }
    }

    // Return + clear the buffered raw engine verdicts. The consumer owns
    // judgment; we do NOT run these through recordJudgment / the HUD.
    function _ndDrainContainedVerdicts() {
        if (!_ndContainedVerdictBuf.length) return [];
        const out = _ndContainedVerdictBuf;
        _ndContainedVerdictBuf = [];
        return out;
    }

    // Disarm the contained chart and restore host-song scoring.
    async function _ndReleaseContainedChart() {
        if (!_ndContainedActive && !_ndHostChartSuspended) return;
        _ndContainedGen++;   // invalidate any in-flight arm/push so it can't resurrect contained mode
        _ndContainedActive = false;
        _ndContainedById = new Map();
        _ndContainedCtx = null;
        _ndContainedVerdictBuf = [];
        _ndContainedLastPlayhead = 0;
        if (_ndShared.containedSlotOwners.get(sourceId) === api) _ndShared.containedSlotOwners.delete(sourceId);
        await _ndRestoreHostChart();
    }

    let _chartStateSubscribed = false;
    let _chartStateOnChange = null;
    function _chartStateBindEvents() {
        if (_chartStateSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        // On a song / arrangement change, refresh the chart context and —
        // on the desktop bridge — re-push the new note chart to the engine
        // verifier. _ndPushChartToBridge() no-ops on the browser path.
        const onChange = () => {
            _syncChartStateFromHw();
            // Swallow rejections — a chart-build failure (e.g. hw.getNotes()
            // throwing) inside a slopsmith host event callback must not
            // surface as an unhandled rejection in the host's dispatch.
            Promise.resolve(_ndPushChartToBridge()).catch(() => {});
        };
        try {
            // song:loaded fires early (with metadata) — chart contents
            // (notes / chords / beats) stream in afterwards over the WS.
            // song:ready fires once the chart has fully arrived, which is
            // the actually-correct moment to push to the engine. We
            // subscribe to both: song:loaded keeps the legacy path that
            // also resets chart-derived state, and song:ready guarantees
            // a re-push once hw.getNotes()/getChords() returns the full
            // chart instead of an empty / partial early snapshot.
            window.slopsmith.on('song:loaded',          onChange);
            window.slopsmith.on('song:ready',           onChange);
            window.slopsmith.on('arrangement:changed',  onChange);
        } catch (e) {
            if (typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('song:loaded',         onChange); } catch (_) {}
                try { window.slopsmith.off('song:ready',          onChange); } catch (_) {}
                try { window.slopsmith.off('arrangement:changed', onChange); } catch (_) {}
            }
            return;
        }
        _chartStateOnChange = onChange;
        _chartStateSubscribed = true;
    }
    function _chartStateUnbindEvents() {
        if (!_chartStateSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && _chartStateOnChange) {
            try { window.slopsmith.off('song:loaded',         _chartStateOnChange); } catch (_) {}
            try { window.slopsmith.off('song:ready',          _chartStateOnChange); } catch (_) {}
            try { window.slopsmith.off('arrangement:changed', _chartStateOnChange); } catch (_) {}
        }
        _chartStateOnChange = null;
        _chartStateSubscribed = false;
    }

    // _drillUnbindEvents → src/drill-conductor.js (nd-carve-5 cut 3)

    // End-of-song summary, XP submission, deferred reveal, and event bind/unbind
    // moved to createSummaryUi (nd-carve-5 cut 2). Use _summaryUi.* to access.

    // Re-arm Detect across song changes. The playSong wrapper silent-disables
    // every instance on a song switch and tries to re-enable the singleton, but
    // it does so right after origPlaySong() resolves — BEFORE the new song's
    // chart/highway is ready — so enable() can bail at the resolveHw() guard and
    // leave Detect off (users then had to re-press it every song). song:loaded
    // fires once the chart IS ready (highway.js emits it after the WS load), on
    // every load path (modern or legacy window.playSong), so it's the reliable
    // moment to honour the standing preference. Default singleton only; no-op if
    // the user turned Detect off (wantsDetect false) or it's already on.
    function _reArmOnSongLoaded() {
        if (!isDefault) return;
        // While split mode owns detection (its panels score per-input), the main-
        // player singleton must stay off — otherwise it re-arms here on every song
        // load and renders a second HUD on top of P1. Splitscreen sets this flag.
        if (typeof window !== 'undefined' && window.__ndSuppressDefault) return;
        if (enabled) return;
        if (!detectPreference) return;
        enable().catch((e) => {
            console.warn('[note_detect] auto re-arm on song:loaded failed:',
                e && e.message ? e.message : e);
        });
    }

    function _reArmBindEvents() {
        if (reArmSubscribed) return;
        if (!isDefault) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _reArmOnSongLoaded;
        try {
            window.slopsmith.on('song:loaded', fn);
        } catch (e) {
            return;
        }
        reArmOnLoadedFn = fn;
        reArmSubscribed = true;
    }

    function _reArmUnbindEvents() {
        if (!reArmSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && reArmOnLoadedFn) {
            try { window.slopsmith.off('song:loaded', reArmOnLoadedFn); } catch (e) {}
        }
        reArmSubscribed = false;
        reArmOnLoadedFn = null;
    }

    // _drillRender → src/drill-conductor.js (nd-carve-5 cut 3)

    // _drillSyncFromLoopState → src/drill-conductor.js (nd-carve-5 cut 3)

    // Tracks an in-flight enable() promise. A second enable() call
    // while the first is still awaiting startAudio returns the
    // SAME promise rather than short-circuiting on the already-set
    // `enabled` flag — otherwise the second caller would see
    // `return true` while audio isn't actually started yet, and if
    // startAudio ultimately failed, the first call's cleanup would
    // flip `enabled` back to false after the second had already
    // reported success.
    /* ── External detection source — note-detection domain consumer (spec 009) ─
     * When a non-audio provider (e.g. the MIDI keys highway) has an open
     * detection binding, notedetect scores from its reported verdicts instead
     * of the mic, driving the SAME HUD + graded/currency summary. Scoring math
     * is untouched: external hit/miss verdicts feed recordJudgment() exactly
     * like the audio path (emit:true so the core stats-recorder/progression
     * award fires too). The source's own /api/stats POST is suppressed so this
     * doesn't double-count. */
    let _extActive = false;
    let _extOnHit = null, _extOnMiss = null, _extWatchOpen = null, _extWatchClose = null;
    let _extPending = [];   // verdicts seen before external mode fully armed (flushed on activate)
    let _vocalOnHit = null, _vocalOnMiss = null;  // feedBack note:hit/miss — vocal highway path

    function _extScan() {
        const nd = window.slopsmith && window.slopsmith.noteDetection;
        if (!nd || nd.version !== 1 || typeof nd.snapshot !== 'function') return null;
        let snap; try { snap = nd.snapshot(); } catch (_) { return null; }
        if (!snap || !Array.isArray(snap.providers) || !Array.isArray(snap.bindings)) return null;
        // Find a non-audio provider that has an open binding. Check bound first
        // so that an earlier unbound provider doesn't shadow a later bound one
        // — if multiple non-audio providers exist, only the bound one matters.
        const boundIds = new Set(snap.bindings.filter(b => b && b.providerId).map(b => b.providerId));
        const ext = snap.providers.find(p => p && p.kind && p.kind !== 'audio' && p.kind !== 'engine' && boundIds.has(p.id));
        return ext || null;
    }

    // Keys/piano (notation) arrangements are scored by an external MIDI provider,
    // never the mic — notedetect's audio detection is fretted-instrument-only.
    function _ndIsExternalScoredArrangement() {
        try {
            const info = (resolveHw() && hw.getSongInfo) ? hw.getSongInfo() : null;
            const name = info && info.arrangement;
            return !!(name && /\b(keys|piano|keyboard|synth)\b/i.test(String(name)));
        } catch (_) { return false; }
    }

    function _extFeed(detail, hit) {
        const p = (detail && detail.payload) || {};
        const midi = Number(p.midi);
        if (!_extActive) {
            // A verdict arriving during the async enter-external window (after we
            // subscribe, before scoring/HUD are armed) would otherwise be lost —
            // these are the first notes. Buffer them; _enableExternal flushes
            // them in once it's armed (post-reset).
            // Guard on detectPreference: if the user has Detect off, stale verdicts
            // must not accumulate in _extPending and then contaminate the next
            // scoring session when Detect is re-enabled.
            if (detectPreference && _extScan() && _extPending.length < 128) _extPending.push({ hit, midi });
            return;
        }
        const t = (resolveHw() && hw.getTime) ? hw.getTime() : 0;
        const key = 'ext:' + (Number.isFinite(midi) ? midi : 'x') + ':' + Number(t).toFixed(3) + ':' + (hit ? 'h' : 'm');
        try {
            // noteTime = the playhead at which this external verdict landed, so
            // the position-aware ledger can roll it back on a seek-before-t.
            recordJudgment(key, { hit: !!hit, detectedMidi: hit && Number.isFinite(midi) ? midi : null, noteTime: t, _external: true },
                { count: true, emit: true });
        } catch (_) {}
    }

    function _extSubscribe() {
        if (_extOnHit) return;
        _extOnHit  = (detail) => _extFeed(detail, true);
        _extOnMiss = (detail) => _extFeed(detail, false);
        try {
            window.slopsmith.on('note-detection:hit', _extOnHit);
            window.slopsmith.on('note-detection:miss', _extOnMiss);
        } catch (_) {}
    }
    function _extUnsubscribe() {
        try {
            if (_extOnHit)  window.slopsmith.off('note-detection:hit', _extOnHit);
            if (_extOnMiss) window.slopsmith.off('note-detection:miss', _extOnMiss);
        } catch (_) {}
        _extOnHit = _extOnMiss = null;
    }

    // Vocal arrangements (vocal/vocals/sing/karaoke) are scored by Vocal Highway,
    // which emits note:hit / note:miss on window.feedBack. The mic is never started.
    function _ndIsVocalArrangement() {
        try {
            const info = (resolveHw() && hw.getSongInfo) ? hw.getSongInfo() : null;
            const name = info && info.arrangement;
            return !!(name && /\b(vocal|vocals|sing|karaoke)\b/i.test(String(name)));
        } catch (_) { return false; }
    }

    // Parallel to _extFeed — adapts VH's {source, noteTime} payload shape (no midi).
    function _vocalFeed(payload, hit) {
        if (!_extActive) {
            if (detectPreference && _extPending.length < 128)
                _extPending.push({ hit, _vocal: true, noteTime: (payload && payload.noteTime) || 0 });
            return;
        }
        const noteTime = (payload && Number.isFinite(payload.noteTime)) ? payload.noteTime
            : ((resolveHw() && hw.getTime) ? hw.getTime() : 0);
        const key = 'ext:voc:' + Number(noteTime).toFixed(3) + ':' + (hit ? 'h' : 'm');
        try {
            recordJudgment(key, { hit: !!hit, detectedMidi: null, noteTime, _external: true },
                { count: true, emit: true });
        } catch (_) {}
    }

    function _vocalSubscribe() {
        if (_vocalOnHit) return;
        // feedBack.on handlers receive a CustomEvent (app.js:769-772); payload is at e.detail.
        _vocalOnHit  = (p) => { const d = (p && p.detail) || p; if (d && d.source === 'vocal_highway') _vocalFeed(d, true);  };
        _vocalOnMiss = (p) => { const d = (p && p.detail) || p; if (d && d.source === 'vocal_highway') _vocalFeed(d, false); };
        try {
            const fb = window.feedBack;
            if (fb && typeof fb.on === 'function') {
                fb.on('note:hit',  _vocalOnHit);
                fb.on('note:miss', _vocalOnMiss);
            }
        } catch (_) {}
    }
    function _vocalUnsubscribe() {
        try {
            const fb = window.feedBack;
            if (fb && typeof fb.off === 'function') {
                if (_vocalOnHit)  fb.off('note:hit',  _vocalOnHit);
                if (_vocalOnMiss) fb.off('note:miss', _vocalOnMiss);
            }
        } catch (_) {}
        _vocalOnHit = _vocalOnMiss = null;
    }

    // enableImpl() has already set enabled=true and run the event bindings.
    function _enableVocal() {
        _extActive = true;
        attachInstanceRoot();
        updateButton();
        _hud.startHUD();
        _vocalSubscribe();
        // Flush any verdicts buffered before _extActive was set.
        if (_extPending.length) {
            const pend = _extPending; _extPending = [];
            for (const v of pend) _vocalFeed({ noteTime: v.noteTime || 0 }, v.hit);
        }
        return true;
    }

    // enableImpl() has already set enabled=true and run the event bindings.
    function _enableExternal() {
        _extActive = true;
        attachInstanceRoot();
        updateButton();
        _hud.startHUD();
        _extSubscribe();
        // Flush verdicts buffered during the arming window (the first notes).
        if (_extPending.length) {
            const pend = _extPending; _extPending = [];
            for (const v of pend) _extFeed({ payload: { midi: v.midi } }, v.hit);
        }
        return true;
    }

    function _extBindWatch() {
        if (_extWatchOpen || !isDefault) return;
        _extWatchOpen = () => {
            if (_extActive || !detectPreference || !_ndIsExternalScoredArrangement() || !_extScan()) return;
            if (enabled) { try { stopAudio(); } catch (_) {} }
            enabled = false;
            enable().catch(() => {});
        };
        _extWatchClose = () => {
            if (!_extActive || _extScan()) return;
            _extActive = false;
            _extPending = [];
            // Do NOT unsubscribe here — the persistent hit/miss subscription must
            // survive provider-disconnect so verdicts arriving during the next async
            // arm window (between binding-opened and _enableExternal completing) are
            // buffered by _extFeed rather than silently dropped.  _extUnsubscribe()
            // is reserved for full watcher teardown (disable / destroy).
            _hud.stopHUD();
            enabled = false;
            updateButton();
        };
        try {
            window.slopsmith.on('note-detection:binding-opened', _extWatchOpen);
            window.slopsmith.on('note-detection:provider-registered', _extWatchOpen);
            window.slopsmith.on('note-detection:binding-closed', _extWatchClose);
            window.slopsmith.on('note-detection:provider-unregistered', _extWatchClose);
        } catch (_) {}
        // Subscribe to verdicts now (persistent) so ones arriving during the
        // async enter-external window are buffered, not lost — _extFeed buffers
        // until _extActive, then _enableExternal flushes them.
        _extSubscribe();
    }

    let enableInFlight = null;
    function enable() {
        if (enableInFlight) return enableInFlight;
        if (enabled) return Promise.resolve(true);
        enableInFlight = (async () => {
            try {
                return await enableImpl();
            } finally {
                enableInFlight = null;
            }
        })();
        return enableInFlight;
    }

    async function enableImpl() {
        // Resolve the highway lazily — supports plugin load orders
        // where highway isn't defined at factory construction. If
        // it's still missing, there's nothing to hook into, so bail
        // cleanly rather than throw from `hw.getSongInfo()` below.
        if (!resolveHw()) {
            console.warn('[note_detect] enable() called but `highway` is not available yet — plugin may have loaded before slopsmith core.');
            return false;
        }
        ensureDrawHook();
        // Re-assert the calibrated engine input gain (the input-level wizard's
        // result) so it survives app restarts / a host that re-inits engine gain.
        _ndApplyEngineGain();
        // Subscribe to slopsmith loop / song events for drill mode.
        // Idempotent — _drillBindEvents bails when already subscribed,
        // so re-enabling after a disable doesn't double-bind. Listeners
        // survive disable() (so re-enable resumes the same drill state)
        // and only get torn down by destroy().
        _drillConductor.bindEvents();
        // Subscribe to song:ended so a finished song with detection on
        // surfaces the end-of-song summary modal. Idempotent and
        // self-gated (handler bails when not enabled / not default).
        _summaryUi.endOfSongBindEvents();
        // Bind the song:loaded re-arm so Detect survives song switches. Like
        // the endOfSong/drill bindings it persists across the per-song silent-
        // disable and is only torn down by destroy(); idempotent + default-only.
        _reArmBindEvents();
        // Bind song:seek so a backward reposition (Restart button / scrub-back)
        // rebuilds the live score to the new playhead instead of keeping the
        // stale total. Same persist-across-silent-disable lifecycle; handler
        // self-gates on `enabled`. NOT default-only — each split panel rebuilds
        // its own HUD.
        _seekResetBindEvents();
        // Sync drill state once at enable so a user enabling detection
        // while a loop is already active starts counting iterations
        // from the very next judgment, not after the first HUD tick.
        _drillConductor.syncFromLoopState();
        enabled = true;
        // Make sure the instanceRoot is in the DOM before HUD/summary
        // rendering kicks in — `createNoteDetector({container}).enable()`
        // without a prior `injectButton()` call would otherwise render
        // to a detached subtree.
        attachInstanceRoot();
        updateButton();

        _syncChartStateFromHw();
        _chartStateBindEvents();

        resetScoring();

        // Vocal arrangements: Vocal Highway is the scorer; nd only displays
        // the HUD. Skip the mic entirely and route feedBack note:hit/miss
        // into the shared graded HUD + summary.
        if (_ndIsVocalArrangement()) return _enableVocal();

        // External detection source (MIDI keys highway): score from the
        // note-detection domain instead of the mic — same graded HUD + summary.
        if (_ndIsExternalScoredArrangement() && _extScan()) return _enableExternal();
        // Keys/piano arrangement with no provider yet: never start the mic —
        // idle until an external provider's binding registers (the bind watcher
        // then promotes us into external mode).
        if (_ndIsExternalScoredArrangement()) {
            enabled = false;
            updateButton();
            return false;
        }

        // Queue the audio acquisition through the shared chain so
        // enable cannot overlap with a concurrent restartAudio
        // (settings slider) or another enable. Without this,
        // startAudio from enable and startAudio from a settings-
        // triggered restart could both race to write `stream` /
        // `audioCtx` / node refs.
        const result = await queueAudioOp(async () => {
            // Early bail before startAudio: disable()/destroy() may
            // have run after enable() queued this op but before it
            // got its turn on the chain. Calling startAudio in that
            // case would prompt for mic permission and create nodes
            // purely to tear them down on the next line.
            if (!enabled) return { ok: false, superseded: true };
            // New session — bump the generation counter and snapshot
            // it so we can detect a disable() that fires while
            // startAudio is still awaited.
            sessionGen++;
            const gen = sessionGen;
            const ok = await startAudio();
            if (gen !== sessionGen || !enabled) {
                // Superseded by disable() during the await. Tear down
                // the audio that just came up.
                if (ok) stopAudio();
                return { ok: false, superseded: true };
            }
            return { ok, superseded: false };
        });

        if (result.superseded) {
            // disable() ran during the await and already set
            // enabled=false / updated the button. Just report the
            // aborted enable back to the caller.
            return false;
        }
        if (!result.ok) {
            enabled = false;
            updateButton();
            return false;
        }

        missCheckInterval = setInterval(checkMisses, 100);
        _hud.startHUD();

        // Desktop bridge: push the current song's note chart to the engine
        // so its NoteVerifier thread scores it continuously. No-ops on the
        // browser path and on a downlevel addon (where the legacy matchNotes
        // loop stays in force). startAudio() has already established
        // usingDesktopBridge / bridgeDesktop by this point.
        await _ndPushChartToBridge();

        // Phase 2 warm-up grace: a source on an ADDITIONAL input device starts
        // COLD — its interface only began streaming when the user bound it
        // (seconds ago), so the stream + detection settle over the first couple
        // seconds. The PRIMARY device has been streaming since launch, so it's
        // already warm and accurate from the first note. Without this, the extra
        // device's cold-start would be scored as misses that permanently drag the
        // cumulative accuracy ("missed the start, never catches up"). Wipe that
        // one cold-start window so the displayed score reflects steady state.
        // Guarded by sessionGen so a disable/re-enable cancels a pending reset. Gate
        // on actually OWNING a non-default source — not just the requested deviceKey —
        // so that if the extra-device bind failed and we fell back to source 0 (a
        // primary input that's already warm), we DON'T wipe the first valid seconds of
        // that fallback's hits and make the degraded path look broken.
        if (_ndDeviceKey > 0 && _ndOwnsSource && sourceId != null && sourceId !== 0) {
            const warmGen = sessionGen;
            setTimeout(() => {
                if (enabled && warmGen === sessionGen) resetScoring();
            }, 2500);
        }

        // Per-instance GC of noteResults — previously a module-level
        // setInterval; moving it into the closure lets each instance
        // prune its own Map.
        gcInterval = setInterval(() => {
            if (!enabled || noteResults.size < 500) return;
            const t = hw.getTime();
            for (const [key] of noteResults) {
                const noteTime = parseFloat(key.split('_')[0]);
                if (noteTime < t - 5) { noteResults.delete(key); _susActiveUntil.delete(key); }
            }
        }, 5000);

        if (detectionMethod === 'crepe') _ndLoadCrepe();

        // Auto-record every play (default singleton only; no-op otherwise).
        // Bound only here, on the fully-enabled path after audio is up, and
        // unbound in disable() — so the song listeners never linger or arm
        // a take while Detect is off (a plain disable() doesn't flip
        // detectPreference, so a stale listener could otherwise fire). The
        // vm tests can't enable(), so they never register it, keeping the
        // listener-count contracts intact.
        _recCapture.bindAutoRecord();
        // A/V auto-calibrate (default singleton only; no-op otherwise) — same
        // enable-time lifecycle as auto-record.
        _avCal.bindEvents();
        return true;
    }

    // `disableOptions.silent: true` suppresses the end-of-song summary
    // modal. The playSong hook uses this when a new song loads so the
    // user doesn't see a summary pop every song switch; the original
    // pre-factory behaviour was to silently reset here. Parameter is
    // named distinctly from the factory's outer `opts` to avoid the
    // lexical shadow.
    function disable(disableOptions) {
        if (!enabled) return;
        enabled = false;
        // A conductor drill is pointless without detection running — end it so
        // the A-B loop, speed override, HUD, and its loop:restart listener
        // don't survive Detect being turned off.
        if (_drillConductor.isDrilling()) _drillConductor.endDrill('disabled');
        // A contained-playback chart can't outlive detection. Clear the engine
        // slot ownership and un-suspend host scoring synchronously so the next
        // enable() starts clean — the async host re-push is pointless here
        // (stopAudio() below clears the bridge, so it would no-op anyway).
        if (_ndContainedActive || _ndHostChartSuspended) {
            _ndContainedGen++;   // invalidate any in-flight arm/push so it can't resurrect after disable
            _ndContainedActive = false;
            _ndContainedById = new Map();
            _ndContainedCtx = null;
            _ndContainedVerdictBuf = [];
            _ndContainedLastPlayhead = 0;
            _ndHostChartSuspended = false;
            if (_ndShared.containedSlotOwners.get(sourceId) === api) _ndShared.containedSlotOwners.delete(sourceId);
        }
        // Invalidate any CREPE inference currently awaited in
        // processFrame — it captured the previous sessionGen and will
        // bail on mismatch rather than apply post-disable detections.
        sessionGen++;
        stopAudio();
        // Release our audio-input requester ref (the engine + device stay up for
        // any other consumer; the domain ref-counts). Best-effort, fire-and-forget.
        _ndCloseSelectedInputSource(ND_AUDIO_REQUESTER);
        _hud.stopHUD();
        // Always clear external state on disable: _extWatchClose no longer
        // unsubscribes (to avoid dropping first-note verdicts on reconnect),
        // so disable() is responsible for the full subscription teardown.
        // _extSubscribe() re-runs when the next enable() reaches _enableExternal.
        _extActive = false; _extUnsubscribe(); _vocalUnsubscribe();
        // Auto-record is the one enable-bound listener we drop on disable()
        // (not only on destroy): its handler arms/saves takes, so it must
        // not stay live while Detect is off. Re-enable rebinds it.
        _recCapture.unbindAutoRecord();
        // NOTE: deliberately do NOT unbind auto-calibrate here. The host
        // disable()s detection at song-end (sometimes BEFORE the plugin's
        // song:ended handler runs), so unbinding on disable would drop the
        // calibrate trigger. Self-gated + once-per-play; torn down in destroy().
        if (missCheckInterval) { clearInterval(missCheckInterval); missCheckInterval = null; }
        if (gcInterval) { clearInterval(gcInterval); gcInterval = null; }
        // flashTimeouts cleared inside _hud.stopHUD() which is called above.

        if (!disableOptions || !disableOptions.silent) _summaryUi.showSummary();

        const panel = document.querySelector('.nd-settings-panel');
        if (panel) {
            if (panel._ndHealthTick) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
            }
            panel.remove();
        }
        _settingsPanel.vuSetPanel(null);
        calibrationWizardClose();
        calibrationLabClose();

        updateButton();
    }

    function destroy() {
        // Silent disable on teardown: calling plain disable() would
        // fire showSummary() (publishing `notedetect:session` and
        // building the summary overlay) for any instance with ≥5
        // judgments, but then we immediately remove `instanceRoot`
        // so the overlay flashes and vanishes. Unexpected for
        // callers like splitscreen that unmount a panel without
        // meaning to end-of-song the session.
        disable({ silent: true });
        // Persistent watchdog (bound at construction) — tear it down here.
        if (scoringWatchdog) { clearInterval(scoringWatchdog); scoringWatchdog = null; }
        try { _clearScoringStall(); } catch (_) {}
        // Free the engine input source we allocated for this instance (if any).
        // disable()→stopAudio() already cleared bridgeDesktop, so this re-resolves
        // window.feedBackDesktop. No-op for the default singleton / source 0.
        _ndReleaseOwnedSource();
        calibrationWizardClose();
        calibrationLabClose();
        // Unbind slopsmith drill listeners so multiple createNoteDetector()
        // instances (splitscreen) don't accumulate handlers across mount/
        // unmount cycles. disable() leaves them alone (resumes drill state
        // on re-enable); destroy is the right teardown point.
        _drillConductor.unbindEvents();
        _summaryUi.endOfSongUnbindEvents();
        _reArmUnbindEvents();
        _seekResetUnbindEvents();
        _chartStateUnbindEvents();
        _recCapture.destroy();
        _avCal.unbindEvents();
        _diagCatalog.liveUnbindEvents();
        // Remove draw hook (may not exist on older highway versions;
        // swallow the error rather than crash on teardown).
        try { if (hw && hw.removeDrawHook) hw.removeDrawHook(drawHookFn); } catch (e) {}
        // Clear our note-state provider — but only when we can positively
        // verify it's still ours (don't stomp a provider some other plugin
        // registered later, and don't clear blindly if the core lacks the
        // getter to confirm ownership).
        try {
            if (hw && hw.setNoteStateProvider
                && typeof hw.getNoteStateProvider === 'function'
                && hw.getNoteStateProvider() === noteStateFor) {
                hw.setNoteStateProvider(null);
            }
        } catch (e) {}
        if (detectBtn) { detectBtn.remove(); detectBtn = null; }
        if (gearBtn) { gearBtn.remove(); gearBtn = null; }
        if (instanceRoot.parentNode) instanceRoot.remove();
        _ndInstances.delete(api);
    }

    async function toggle() {
        if (enabled) {
            disable();
            detectPreference = false;
            saveSettings();
        } else {
            await enable();
            detectPreference = true;
            saveSettings();
        }
    }

    // ── Reference-recording capture ───────────────────────────────────
    // armRecording, armRecordingForTraining, disarmRecording, discardRecording,
    // saveRecordingNow, getRecordingState, _recBindEvents, _recUnbindEvents,
    // _bindAutoRecord, _unbindAutoRecord, _showTrainingConsentModal,
    // _uploadTrainingBundle, _startParallelTrainingCapture,
    // _stopParallelTrainingCapture — all moved to src/recording-capture.js
    // (nd-carve-7 cut 7). Use _recCapture.* to access.

    // ── A/V auto-calibrate lifecycle ─────────────────────────────────
    // Moved to src/av-calibrate.js (createAvCalibrate); _avCal constructed
    // near the old state-var declarations. Call sites below delegate to _avCal.

    // Live-streaming, diagnostic catalog, and report functions moved to
    // src/diagnostic-catalog.js (nd-carve-6 cut 6). Use _diagCatalog.*.

    // showSummary, _animateSummary, _runConfetti, publishToJournal moved to
    // createSummaryUi (nd-carve-5 cut 2). Use _summaryUi.showSummary.

    // ── Public API ────────────────────────────────────────────────────
    const api = {
        enable,
        disable,
        destroy,
        isEnabled: () => enabled,
        // Drill conductor (speed/goal orchestrator, ported from slopsmith
        // 1.39.1). startDrill(start, end, {label, focus, goal, speedLadder,
        // expandContext, maxExpansions}) arms a slowed A-B loop and steps the
        // speed up as the player clears the accuracy goal, graduating at full
        // speed. startDrillHere() is the center-anchored entry (drill around
        // the playhead). endDrill() bails early. getConductorState drives
        // external HUDs / tests.
        startDrill: (...args) => _drillConductor.startDrill(...args),
        startDrillHere: (...args) => _drillConductor.startDrillHere(...args),
        endDrill: (reason) => _drillConductor.endDrill(reason),
        isDrilling: () => _drillConductor.isDrilling(),
        getConductorState: () => _drillConductor.getConductorState(),
        // Register (or clear, with null) a note set to verify against the live
        // audio every frame, independent of the chart playhead. Emits
        // notedetect:verify { isHit, score, ... } on a hit. Lets a frozen-
        // playhead consumer (Step Mode) ask "is the expected note ringing
        // now?" using the chart-aware verifier without the timing gate that
        // makes notedetect:hit unsuitable there (#468 / #630). `notes` is an
        // array of { s, f, ho?, po?, b?, sl?, hm? }.
        //
        // Optional `ctx` overrides the tuning the target is scored under. Give
        // the per-string tuning as either `openMidis` (absolute open-string
        // MIDI) or `tuning`/`offsets` (semitone offsets from standard), plus
        // optional `arrangement` / `capo` / `stringCount` — see
        // _ndSanitizeVerifyCtx. Pass it so a non-chart consumer (contained
        // playback — SlopScale, Chord Sprint) scores against the player's real
        // instrument instead of the host's loaded song; the target then
        // survives host song-switches and is only dropped when the ctx itself
        // changes. Omit ctx (or pass null) to keep the chart-coupled behavior
        // (Step Mode).
        setVerifyTarget: (notes, ctx) => {
            if (!Array.isArray(notes)) {
                _verifyTarget = null; _verifyTargetSig = null; _verifyTargetCtx = null;
                return;
            }
            // Filter to well-formed positions and store a private copy so a
            // caller mutating its array can't later break the gate's
            // "null or non-empty sanitized array" invariant.
            const clean = notes
                .filter(n => n
                    && Number.isInteger(n.s) && n.s >= 0
                    && Number.isInteger(n.f) && n.f >= 0)
                .map(n => ({
                    s: n.s, f: n.f,
                    ho: !!n.ho, po: !!n.po, b: !!n.b, sl: !!n.sl, hm: !!n.hm,
                }));
            let cleanNotes = clean.length ? clean : null;
            // A ctx only makes sense alongside a live target.
            const vctx = cleanNotes ? _ndSanitizeVerifyCtx(ctx) : null;
            if (cleanNotes && vctx) {
                // Drop notes referencing strings the override's tuning can't
                // represent (e.g. an out-of-table 6-string-bass string left
                // over after the ctx clamp), so the target never carries a
                // string that maps to a NaN pitch and silently never verifies.
                cleanNotes = cleanNotes.filter(n => n.s < vctx.stringCount);
                if (!cleanNotes.length) cleanNotes = null;
            }
            _verifyTarget = cleanNotes;
            _verifyTargetCtx = cleanNotes ? vctx : null;
            // Bind the target to the context it was registered under (the
            // override when supplied, else the host chart).
            _verifyTargetSig = cleanNotes ? _ndVerifyActiveSig() : null;
        },
        getVerifyTarget: () => (_verifyTarget ? _verifyTarget.map(n => ({ ...n })) : null),
        // The caller-supplied tuning context the current verify target is
        // scored under, or null when it tracks the host song's live tuning.
        getVerifyContext: () => (_verifyTargetCtx
            ? { arrangement: _verifyTargetCtx.arrangement, stringCount: _verifyTargetCtx.stringCount,
                offsets: _verifyTargetCtx.offsets.slice(), capo: _verifyTargetCtx.capo }
            : null),

        // ── Contained-playback verifier ─────────────────────────────────────
        // A non-chart consumer (SlopScale, Chord Sprint) running its own
        // exercise transport drives the SAME engine harmonic-comb NoteVerifier
        // the host song uses — its OWN chart + playhead — for timing-aware,
        // engine-gated (silence / onset / persistence) per-note verdicts,
        // instead of the timing-free setVerifyTarget. Host-song scoring is
        // suspended while a contained chart is armed (one engine chart slot).
        //
        // Usage (per the consumer's own RAF tick):
        //   if (await api.setContainedChart(notes, ctx)) { … }      // arm once (async)
        //   await api.pushContainedPlayhead(exerciseTime, playing); // each tick (async)
        //   for (const v of api.drainContainedVerdicts()) { … }     // each tick (sync)
        //   await api.releaseContainedChart();                      // on stop (async)
        // `notes`: [{ id, t, s, f, sus?, ho?, po?, b?, sl?, hm? }] — `id` is a
        // caller-chosen stable key echoed back on each verdict. `ctx`: optional
        // tuning override (see setVerifyTarget / _ndSanitizeVerifyCtx).
        // Returns true (armed), false (NOT armed — another instance owns the
        // slot, or empty/no well-formed notes), or null (browser / downlevel
        // addon — no engine). On anything but true the consumer should fall back.
        setContainedChart: (notes, ctx) => _ndSetContainedChart(notes, ctx),
        // Drive the engine clock with the consumer's exercise playhead and
        // buffer the verdicts the engine finalizes. `t` is pushed verbatim.
        pushContainedPlayhead: (t, playing) => _ndPushContainedPlayhead(t, playing),
        // Return + clear the buffered raw verdicts { id, detected,
        // detectedSongTime, centsError, snr }. The consumer owns judgment.
        drainContainedVerdicts: () => _ndDrainContainedVerdicts(),
        // Disarm the contained chart and restore host-song scoring.
        releaseContainedChart: () => _ndReleaseContainedChart(),
        // True when this build can run a contained verifier (desktop bridge
        // with the chart-verifier API). False on browser / downlevel.
        isContainedVerifierAvailable: () => _ndContainedVerifierAvailable(),

        getStats: () => {
            const accuracy = (hits + misses) > 0 ? Math.round(hits / (hits + misses) * 100) : 0;
            return {
                hits, misses, streak, bestStreak,
                accuracy,
                score, multiplier, maxMultiplier,
                grade: _ndGradeFor(accuracy),
                sectionStats: sectionStats.map(s => ({ name: s.name, hits: s.hits, misses: s.misses })),
            };
        },
        // The user's most-recently-expressed preference: did they last
        // click Detect to turn it ON? Distinct from isEnabled(), which
        // is the live runtime state and goes false on every song-switch
        // (the playSong wrapper silent-disables to clear stale stats).
        // The wrapper itself reads this to decide whether to auto-
        // re-enable for the next song.
        wantsDetect: () => !!detectPreference,
        // Drill-mode read-only state. Delegated to _drillConductor (nd-carve-5 cut 3).
        getDrillStats: () => _drillConductor.getDrillStats(),
        setChannel,
        setVerifierOffset,
        getVerifierOffset,
        injectButton,
        showSummary: (opts) => _summaryUi.showSummary(opts),
        // ── Public results-card API (consumed by other plugins, e.g. Virtuoso)
        // Render / copy / save the shareable results card from a caller-supplied
        // data object so any plugin reuses ONE canonical card implementation
        // instead of duplicating it. `data` fields (all optional): eyebrow,
        // hero (or title), artist, instrument, artUrl, accuracy, score, hits,
        // misses, bestStreak, maxMultiplier, fullCombo, sections [{name,acc}],
        // extraLabel/extraValue, stats [{label,value,color}] (overrides the
        // default stat strip), brand (footer). `opts.overlayEl` supplies the
        // skin palette (defaults to note_detect's neon when omitted).
        renderResultsCard: (data, opts) =>
            _ndRenderShareCard(data || {}, (opts && opts.overlayEl) || null),
        copyResultsCard: (data, opts) =>
            _ndShareCardAction(data || {}, 'copy', (opts && opts.overlayEl) || null),
        saveResultsCard: (data, opts) =>
            _ndSaveCard(data || {}, (opts && opts.overlayEl) || null),
        // Diagnostic export (#254 follow-up). `downloadDiagnostic()`
        // triggers a browser file save of the current session's
        // breakdown + capped event log; `getDiagnostic()` returns the
        // same payload for in-page display / programmatic use. Schema
        // is `note_detect.diagnostic.v1`. `resetDiagnostic()` zeroes
        // all the counters mid-session (without touching audio /
        // enabled / button state) so you can navigate to a specific
        // section, reset, and capture *only* that section's events.
        downloadDiagnostic: _diagCatalog.downloadDiagnostic,
        getDiagnostic: _diagCatalog.buildDiagnosticPayload,
        resetDiagnostic: resetScoring,
        getCalibrationSnapshot,
        getVerifierRejects,
        openCalibrationWizard,
        launchCalibration,
        closeCalibrationWizard: calibrationWizardClose,
        openInstrumentCalibrationLab,
        closeInstrumentCalibrationLab: calibrationLabClose,
        getCalibrationReport,
        downloadCalibrationReport: _calLabDownloadReport,
        // Public setter for the Auto-tune-from-session panel — applies
        // a partial settings object with the same clamps the storage
        // loader uses, then persists via saveSettings(). Each field is
        // optional; unknown / non-finite values are ignored so callers
        // can pass only the rows they want to apply. Returns the
        // post-clamp object so the caller can update the UI without a
        // separate get round-trip.
        applySettings: (partial) => {
            partial = partial || {};
            // Restart the audio graph at the end if a structural setting (one
            // baked into the ScriptProcessor at startAudio) changed while live.
            let restartNeeded = false;
            if (typeof partial.method === 'string' && ['yin', 'hps', 'crepe'].includes(partial.method)) {
                detectionMethod = partial.method;
                detectionMethodUserSet = true;  // explicit choice — disable bass auto-HPS
            }
            if (partial.frameSize !== undefined) {
                // The README documents tuning this via applySettings; the
                // ScriptProcessor buffer is fixed at startAudio, so a change
                // while detection is live only takes effect after a restart.
                const nextFrameSize = _ndClampFrameSize(partial.frameSize);
                if (nextFrameSize !== frameSize) {
                    frameSize = nextFrameSize;
                    restartNeeded = enabled;
                }
            }
            if (Number.isFinite(partial.timingTolerance)) {
                timingTolerance = Math.max(0.03, Math.min(0.3, partial.timingTolerance));
            }
            if (Number.isFinite(partial.pitchTolerance)) {
                pitchTolerance = Math.max(10, Math.min(100, partial.pitchTolerance));
            }
            if (Number.isFinite(partial.timingHitThreshold)) {
                timingHitThreshold = Math.max(0.03, Math.min(timingTolerance, partial.timingHitThreshold));
            }
            if (Number.isFinite(partial.chordTimingHitThreshold)) {
                chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, partial.chordTimingHitThreshold));
            }
            // Maintain the chord >= single-note invariant after either side moved.
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            if (Number.isFinite(partial.pitchHitThreshold)) {
                pitchHitThreshold = Math.max(5, Math.min(pitchTolerance, partial.pitchHitThreshold));
            }
            if (Number.isFinite(partial.chordHitRatio)) {
                chordHitRatio = Math.max(0.25, Math.min(1, partial.chordHitRatio));
            }
            if (Number.isFinite(partial.detectionConfidenceMin)) {
                detectionConfidenceMin = Math.max(0.05, Math.min(0.50, partial.detectionConfidenceMin));
            }
            if (Number.isFinite(partial.latencyOffset)) {
                // Clamp to the same range as the gear-popover slider
                // (0–0.250 s). The storage loader doesn't clamp this
                // field on read, but the writer should — letting a
                // caller (auto-tune, DevTools experiment, stale code)
                // park latency at 5 s would render the matching
                // window unreachable until the user manually drags
                // the slider back into range.
                latencyOffset = Math.max(0, Math.min(0.25, partial.latencyOffset));
            }
            // Re-enforce timing-threshold invariants at the END of the
            // setter. A partial that lowers `timingTolerance` alone (and
            // doesn't supply new hit thresholds) would otherwise leave
            // `timingHitThreshold` and/or `chordTimingHitThreshold`
            // above the new tolerance ceiling — a state the UI sliders
            // can't represent and that drifts judgment classification
            // until the user touches another knob. Same pattern as the
            // storage-load invariant at the top of createNoteDetector.
            if (timingHitThreshold > timingTolerance) timingHitThreshold = timingTolerance;
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;
            saveSettings();
            // Recreate the ScriptProcessor with the new buffer size. Done after
            // saveSettings() so the persisted value is correct even if the
            // restart races; fire-and-forget, matching the other call sites.
            if (restartNeeded) restartAudio();
            return {
                method: detectionMethod,
                frameSize,
                timingTolerance,
                pitchTolerance,
                timingHitThreshold,
                chordTimingHitThreshold,
                pitchHitThreshold,
                chordHitRatio,
                detectionConfidenceMin,
                latencyOffset,
            };
        },
        // Narrower reset for A/V calibrate — clears only the timing
        // samples that feed the next calibration suggestion, leaving
        // hits/misses/streak/sectionStats/eventLog intact. Use this
        // instead of `resetDiagnostic` when the goal is "stop using
        // stale samples from before my offset change", not "start a
        // brand-new session".
        resetCalibrationSamples: _resetCalibrationSamples,
        // Tuning-mode gate. Off by default; flipped on/off from the
        // Settings page (the developer surfaces it gates live there too,
        // so the toggle and the panels it reveals are in one place).
        // Other UI — the summary modal's breakdown / Download button —
        // polls this to decide whether to render the dev-only surfaces.
        isTuningMode: () => tuningMode,
        setTuningMode: (v) => {
            const next = !!v;
            if (next === tuningMode) return;
            tuningMode = next;
            // If the user disables tuning mid-recording, drop the
            // in-flight buffer + disarm — the UI for it is about to
            // disappear and we don't want a half-captured WAV trailing.
            if (!tuningMode && (_recCapture.isArmedOrTraining() || _recCapture.hasPendingBuffer())) {
                _recCapture.discardRecording();
            }
            // Live JSONL streaming binds/unbinds with tuning mode so
            // non-tuning users don't pollute the slopsmith event bus.
            // The drill-mode tests assert exactly one song:ended
            // listener after their own bind — adding an always-on
            // live-stream listener would break that contract.
            if (tuningMode) _diagCatalog.liveBindEvents(); else _diagCatalog.liveUnbindEvents();
            saveSettings();
        },
        // Auto-record-every-play opt-out. The song:loaded listener reads
        // `autoRecord` at fire time, so flipping the flag is enough — no
        // rebind. An in-progress auto-take is left to finish/save on its
        // own song:ended.
        isAutoRecord: () => autoRecord,
        setAutoRecord: (v) => {
            const next = !!v;
            if (next === autoRecord) return;
            autoRecord = next;
            saveSettings();
        },
        // Scoring-UI skin (neon | esports | metal). Global preference: one
        // localStorage key shared by all instances; setSkin live-restamps
        // every open notedetect root (splitscreen panels, summary overlay)
        // and announces the change on the bus so the highway renderer can
        // refresh its FX palette.
        getSkin: () => _ndLoadSkin(),
        setSkin: (skin) => {
            if (ND_SKINS.indexOf(skin) === -1) return false;
            // Mirror first — persistence below is best-effort (see
            // _ndSkinRuntime), the session state must not depend on it.
            _ndSkinRuntime = skin;
            try { localStorage.setItem(ND_SKIN_STORAGE_KEY, skin); } catch (e) {}
            try {
                document.querySelectorAll('.nd-instance-root, .nd-summary-overlay')
                    .forEach(el => el.setAttribute('data-nd-skin', skin));
            } catch (e) {}
            if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
                try { window.slopsmith.emit('notedetect:skin', { skin }); } catch (e) {}
            }
            return true;
        },
        // A/V auto-calibrate opt-out + last result for the Settings UI.
        isAutoCalibrate: () => autoCalibrate,
        setAutoCalibrate: (v) => {
            const next = !!v;
            if (next === autoCalibrate) return;
            autoCalibrate = next;
            saveSettings();
        },
        getLastCalibration: () => _avCal.getLastCalibration(),
        // Debug hooks: detection-log state + a manual calibrate trigger, so a
        // headless run can see whether the log fills and why calibrate no-ops.
        _calDebug: () => _avCal.getDebug(),
        _calDetectionsDump: () => _avCal.detectionsDump(),
        // Anchors the A/V sweep will actually use — singles, or the chord
        // constituents when a reduced difficulty leaves no singles (feedback#226).
        _calibrationNotes: () => _ndCalibrationNotes(),
        // The chart + difficulty the training bundle would pin for this take.
        _trainingChartSnapshot: () => _ndTrainingChartSnapshot(),
        _runAutoCalibrate: () => _avCal.runAutoCalibrate(),
        // Lifecycle-test hooks: inspect/seed the calibration take without the
        // audio pipeline, so the song:play/pause/loaded reset+resume rules are
        // assertable. Production never calls these.
        _calState: () => _avCal.getState(),
        _calSeedForTest: (n) => _avCal.seedForTest(n),
        _bindCalEvents: () => _avCal.bindEvents(),
        _unbindCalEvents: () => _avCal.unbindEvents(),
        // Test hook: run the offset sweep on a supplied detection log + notes
        // without the audio pipeline. Production calls _ndRunAutoCalibrate().
        _calibrateOffsetMs: (dets, notes, geom, winS, tolC, opts) =>
            _ndCalibrateOffsetMs(dets, notes, geom, winS, tolC, opts),
        // Reference-recording capture for the headless harness. Arms
        // the next song-play to capture the detector's input audio,
        // auto-saves on song:ended. POSTs the WAV to the plugin's
        // routes.py endpoint, which writes it under
        // static/note_detect_recordings/ — bind-mounted in the dev
        // container, so the harness on the host can read it back
        // without any copy step. See `getRecordingState()` for status
        // / lastSavePath / lastError fields the UI polls.
        armRecording:            () => _recCapture.armRecording(),
        armRecordingForTraining: () => _recCapture.armRecordingForTraining(),
        disarmRecording:         () => _recCapture.disarmRecording(),
        discardRecording:        () => _recCapture.discardRecording(),
        saveRecordingNow:        () => _recCapture.saveRecordingNow(),
        getRecordingState:       () => _recCapture.getRecordingState(),
        // Diagnostic accessor — surfaces the AudioContext's own
        // latency self-report. Both fields describe the *output/render*
        // side of the graph, not the microphone-capture path:
        //   - `baseLatency` is the processing latency the AudioContext
        //     incurs while rendering audio (typically a render quantum
        //     or two of buffering on the output side). It is NOT a
        //     measured input-capture delay and does NOT include the
        //     ScriptProcessor frame buffering on top of it.
        //   - `outputLatency` is the total downstream latency from the
        //     destination node to actually-audible — also output-side.
        // For input-chain latency you have to combine these with the
        // ScriptProcessor frame size and the OS capture buffer (which
        // the browser does not expose). What this accessor IS good for:
        // verifying that the `latencyHint: 'interactive'` opt-in
        // produced a smaller `baseLatency` than the platform default
        // (a useful proxy for "the browser took the hint"). Returns
        // null when audio hasn't been started yet (enable() not yet
        // called or running in the desktop-bridge path that doesn't
        // own an AudioContext).
        getAudioLatencyInfo: () => {
            if (!audioCtx) return null;
            return {
                baseLatency:   Number.isFinite(audioCtx.baseLatency)   ? audioCtx.baseLatency   : null,
                outputLatency: Number.isFinite(audioCtx.outputLatency) ? audioCtx.outputLatency : null,
                sampleRate:    audioCtx.sampleRate,
                frameSize:     frameSize,
                // Effective single-note analysis window: bass widens this from
                // the YIN floor to span ~2 periods of the lowest detectable
                // fundamental at the device rate (see _ndMinAnalysisSamples), so
                // report the real value, not the fixed floor.
                yinBufferSize: _ndMinAnalysisSamples(currentArrangement, audioCtx.sampleRate),
                state:         audioCtx.state,
            };
        },
        // Internal — clear hits / misses / streak / noteResults /
        // sectionStats / detection state back to zeros. Used by the
        // playSong hook so both ENABLED and DISABLED instances drop
        // stale stats on a song switch — matches the pre-factory
        // behaviour where the module-level `_ndResetScoring()` ran on
        // every playSong regardless of whether detection was on.
        // Safe to call at any time (doesn't touch audio/UI/timers,
        // just data). Prefixed with `_` to mark it as non-public.
        _resetScoring: resetScoring,
        // Internal — updateButton is called by _ndLoadCrepe() when the
        // shared model finishes loading to refresh every instance's
        // button text. Prefixed with `_` to mark it as non-public.
        _updateButton: updateButton,
        // Internal — drill-mode test hooks. The audio pipeline
        // (getUserMedia, AudioContext) is unavailable in the vm test
        // sandbox, so tests need a way to bind listeners + inject
        // judgments + drive the loop-state poll without going through
        // enable(). Prefixed with `_` to mark them as non-public.
        _bindDrillEvents: _drillConductor.bindEvents,
        _unbindDrillEvents: _drillConductor.unbindEvents,
        _drillSyncFromLoopState: _drillConductor.syncFromLoopState,
        _recordJudgment: recordJudgment,
        // Settings-panel test hooks (nd-carve-5 cut 4).
        // applySettings(changes) is private to the factory; expose it so
        // test/drill_apply_settings_seam.test.js can drive each key and
        // verify _factoryState reflects the assignment (typo/drop coverage).
        // _showSettings delegates to _settingsPanel.showSettings so
        // test/panel_handler_regression.test.js can open the panel, trigger
        // control handlers, and verify writes without going through the DOM
        // gearBtn wire-up (which needs a real browser).
        _applySettings: applySettings,
        _getState: _factoryState,
        _showSettings: _settingsPanel.showSettings,
        // Position-aware score-recompute test hooks. _recomputeScoreToPosition
        // drives the rebuild directly; _bind/_unbindSeekResetEvents let tests
        // pin the song:seek listener-count contract without going through
        // enable()'s audio pipeline. Production binds from enable(), unbinds
        // from destroy().
        _recomputeScoreToPosition: _recomputeScoreToPosition,
        _bindSeekResetEvents: _seekResetBindEvents,
        _unbindSeekResetEvents: _seekResetUnbindEvents,
        // End-of-song summary hooks. Exposed alongside the drill hooks
        // so tests can pin the song:ended listener-count contract
        // (drill alone = 1; drill + end-of-song = 2) without going
        // through enable(). Production code never calls these — they
        // bind from enableImpl() and unbind from destroy().
        _bindEndOfSongEvents: _summaryUi.endOfSongBindEvents,
        _unbindEndOfSongEvents: _summaryUi.endOfSongUnbindEvents,
        // XP-submission test hook — the natural path runs from
        // _endOfSongOnEnded, which tests can't reach without enable()'s
        // audio pipeline. Production code never calls this directly.
        _submitSongXp: (...args) => _summaryUi._submitSongXp(...args),
        // Chart-state sync test hooks — same rationale as the drill
        // hooks. _getChartState lets tests assert the closure-private
        // currentArrangement/currentStringCount/tuningOffsets/capo
        // fields after a synthetic song:loaded.
        _bindChartStateEvents: _chartStateBindEvents,
        _unbindChartStateEvents: _chartStateUnbindEvents,
        _syncChartStateFromHw: _syncChartStateFromHw,
        // Auto-record test hooks — same rationale. Production binds from
        // enableImpl() / unbinds from destroy(); tests drive them without
        // the audio pipeline to assert the song:loaded auto-arm.
        _bindAutoRecord:   () => _recCapture.bindAutoRecord(),
        _unbindAutoRecord: () => _recCapture.unbindAutoRecord(),
        // The capture callback that pushes into _recChunks needs a live
        // AudioContext the vm lacks, so tests can't get a non-empty buffer
        // the normal way. Inject one frame so the failed-save-preservation
        // path is testable (saveRecordingNow returns null + keeps the buffer;
        // the auto handlers must not re-arm over it). Production never calls this.
        _injectRecChunkForTest: (n = 128) => _recCapture.injectChunkForTest(n),
        _getChartState: () => ({
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            tuningOffsets: tuningOffsets.slice(),
            capo,
        }),

        // Internal — headless-harness hooks. Lets a Node CLI tool
        // (plugins/note_detect/tools/harness.js) drive the exact same
        // processFrame / matchNotes / checkMisses pipeline the browser
        // uses, without going through getUserMedia / AudioContext.
        // Required because the matching + judgment logic is closure-
        // internal and 300+ lines of nuance we don't want to
        // reimplement out-of-process. Each entry is a no-arg / small-
        // arg method; the harness composes them. Production code
        // never touches `_harness`.
        _harness: {
            feedFrame: async (buffer, sampleRate) => {
                if (Number.isFinite(sampleRate)) bridgeSampleRate = sampleRate;
                await processFrame(buffer);
            },
            tick: () => { checkMisses(); },
            setEnabled: (v) => { enabled = !!v; },
            setContext: (ctx) => {
                ctx = ctx || {};
                if (typeof ctx.arrangement === 'string') currentArrangement = ctx.arrangement;
                if (Number.isFinite(ctx.stringCount))   currentStringCount = ctx.stringCount;
                if (Array.isArray(ctx.tuningOffsets))   tuningOffsets = ctx.tuningOffsets.slice();
                if (Number.isFinite(ctx.capo))          capo = ctx.capo;
            },
            setSettings: (s) => {
                s = s || {};
                // _harness is a Node-only entrypoint and CREPE's
                // TensorFlow.js model isn't wired in this path (see the
                // file header on tools/harness.js). Accepting 'crepe'
                // here would let a programmatic caller drive a value
                // that the harness CLI explicitly rejects — and the
                // detector would silently fall back to YIN at runtime.
                // Keep the internal API aligned with the CLI's whitelist.
                if (typeof s.method === 'string' && ['yin', 'hps'].includes(s.method)) {
                    detectionMethod = s.method;
                    detectionMethodUserSet = true;  // explicit choice — disable bass auto-HPS
                }
                if (Number.isFinite(s.pitchTolerance))      pitchTolerance      = s.pitchTolerance;
                if (Number.isFinite(s.pitchHitThreshold))   pitchHitThreshold   = s.pitchHitThreshold;
                if (Number.isFinite(s.timingTolerance))     timingTolerance     = s.timingTolerance;
                if (Number.isFinite(s.timingHitThreshold))  timingHitThreshold  = s.timingHitThreshold;
                // Floor here as the runtime path does (see ~L2378): a
                // programmatic 0/negative clean threshold would otherwise be
                // accepted, degenerating the clean band. Upper clamp (≤ hit
                // threshold) is re-enforced at the end of this setter.
                if (Number.isFinite(s.cleanTimingThreshold)) cleanTimingThreshold = Math.max(0.01, s.cleanTimingThreshold);
                if (Number.isFinite(s.cleanPitchThreshold))  cleanPitchThreshold  = Math.max(1, s.cleanPitchThreshold);
                if (Number.isFinite(s.chordTimingHitThreshold)) {
                    // Clamp here too — _harness is a Node-only entrypoint
                    // (harness.js + regression.js drive scoring through it)
                    // and a regression sweep can legitimately pass a chord
                    // threshold outside [timingHitThreshold, timingTolerance]
                    // (e.g. when sweeping timing alone without re-clamping
                    // the chord value). Clamp instead of accepting blindly
                    // so headless scoring matches in-app behavior.
                    chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, s.chordTimingHitThreshold));
                }
                if (Number.isFinite(s.chordHitRatio))       chordHitRatio       = s.chordHitRatio;
                if (s.autoDrillMisses !== undefined) {
                    const _adn = parseInt(s.autoDrillMisses, 10);
                    _drillConductor.setAutoDrillMisses((Number.isFinite(_adn) && _adn > 0) ? _adn : 0);
                }
                if (Number.isFinite(s.latencyOffset))       latencyOffset       = s.latencyOffset;
                if (Number.isFinite(s.inputGain))           inputGain           = s.inputGain;
                if (Number.isFinite(s.engineInputGain))     engineInputGain     = Math.max(0.1, Math.min(5, s.engineInputGain));
                // Re-enforce timing-threshold invariants at the END of the
                // setter. A harness caller can legitimately update only
                // `timingHitThreshold` or `timingTolerance` between scoring
                // runs; without this re-clamp the chord threshold can
                // become stricter than single-note OR exceed the outer
                // tolerance, both of which diverge from in-app behavior.
                if (timingHitThreshold > timingTolerance) timingHitThreshold = timingTolerance;
                if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
                if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;
                // Clean thresholds live strictly inside the hit window.
                if (cleanTimingThreshold > timingHitThreshold) cleanTimingThreshold = timingHitThreshold;
                if (cleanPitchThreshold > pitchHitThreshold)   cleanPitchThreshold = pitchHitThreshold;
            },
            // Read back the (clamped) tolerance/threshold state so a
            // headless caller / test can assert the clamps held.
            getSettings: () => ({
                pitchTolerance, pitchHitThreshold,
                timingTolerance, timingHitThreshold,
                chordTimingHitThreshold,
                cleanTimingThreshold, cleanPitchThreshold,
            }),
        },
    };

    // Register the draw hook once per instance. The hook early-returns
    // on !enabled so disabled instances cost essentially nothing.
    // If highway isn't ready at construction time, ensureDrawHook()
    // (called from enable()) re-tries after resolving `hw` lazily.
    ensureDrawHook();

    // Recording listeners are NOT bound at construct — drill tests assert
    // a clean per-instance listener count, and we shouldn't be on the
    // slopsmith event bus when no recording is armed anyway. We bind
    // on armRecording(), unbind on disarm / save / destroy.

    // Live-stream listeners follow the same rule but key off tuning
    // mode: if the user already has tuning mode on from localStorage,
    // bind so song:play mints a session id without requiring a
    // setTuningMode toggle. setTuningMode handles the dynamic case.
    if (tuningMode) _diagCatalog.liveBindEvents();

    // Auto-enable detection on construct when the persisted preference
    // says so. Default singletons only — splitscreen panels mount /
    // unmount on demand and shouldn't claim the audio device the
    // moment they're constructed. Deferred to next tick so plugin
    // construction returns first; enableImpl() bails cleanly if the
    // highway isn't resolvable yet (it'll keep showing the off-state
    // button until the user clicks).
    //
    // Gated on `window.AudioContext` (or the webkit-prefixed alias) so
    // the vm test sandbox — which stubs the highway but has no audio
    // — doesn't trigger a phantom enable() that binds drill listeners
    // before the test gets to make its assertions.
    const _hasAudio = typeof window !== 'undefined'
        && (typeof window.AudioContext === 'function'
            || typeof window.webkitAudioContext === 'function');
    // Watch for an external detection source (MIDI keys highway) so notedetect
    // renders its HUD/summary from domain verdicts — even with no mic.
    _extBindWatch();

    if (isDefault && detectPreference && _hasAudio) {
        // Auto-enable immediately so a persisted-on session starts detecting
        // the instant the page is ready — a blanket startup delay would miss
        // the opening notes for every user just to accommodate one slow
        // device class. USB interfaces (e.g. the Real Tone Cable) can be
        // enumerated-but-not-yet-openable at first paint, which fails the
        // stream open; in that case retry once after a short settle. The
        // first (silent, automatic) attempt suppresses the failure alert so
        // a transient not-ready device doesn't pop a dialog on load; the
        // retry runs un-suppressed so a genuinely unusable device is still
        // surfaced.
        const autoEnableAttempt = (retriesLeft) => {
            // Re-check BOTH enabled and detectPreference each attempt. A fast
            // user click could have already enabled us (`enabled`), and
            // another surface (settings sync, headless toggle) could have
            // flipped detectPreference to false during the wait — honouring a
            // stale-by-now preference would enable against the user's wishes.
            if (typeof window !== 'undefined' && window.__ndSuppressDefault) return;
            if (enabled || !detectPreference) return;
            // Only the first attempt (one with a retry still in hand) is a
            // silent, non-committal trial — quiet alerts and a preserved device.
            autoEnableTrial = retriesLeft > 0;
            enable().then((ok) => {
                autoEnableTrial = false;
                // enable() resolves false on a failed/again-not-ready open
                // (and on a late highway, which a retry also helps). Retry
                // once if the preference is still live and we're still off.
                if (!ok && retriesLeft > 0 && !enabled && detectPreference) {
                    setTimeout(() => autoEnableAttempt(retriesLeft - 1), _ND_AUTO_ENABLE_RETRY_MS);
                }
            }).catch((e) => {
                autoEnableTrial = false;
                console.warn('[note_detect] auto-enable failed:', e && e.message ? e.message : e);
            });
        };
        setTimeout(() => autoEnableAttempt(1), 0);
    }

    // Bind the input-dropout watchdog here (not in startAudio) so it also
    // catches a detector that never came up. Default singleton only.
    try { _bindScoringWatchdog(); } catch (_) {}

    _ndInstances.add(api);
    return api;
}

// ── playSong wrapper (idempotent) ──────────────────────────────────────────
// On a new song, disable every live instance so scoring doesn't carry over,
// then let the original playSong load the chart, then re-inject the default
// singleton's button.
//
// The idempotency guard lives on the wrapper function itself
// (`wrapper._ndWrapped = true`) rather than on a module-level flag.
// Module scope resets on every evaluation, so HMR or a double
// <script> load would see a false module flag, wrap the already-
// wrapped `window.playSong`, and produce a nested wrapper that
// disables instances twice per song switch. Marking the function
// itself persists across re-evaluations because `window.playSong`
// keeps the reference.
const _ND_PLAY_SONG_MAX_RETRIES = 20;
function _ndInstallPlaySongHook() {
    const origPlaySong = window.playSong;
    if (typeof origPlaySong !== 'function') {
        // playSong may not exist yet. Common on HMR or unusual load
        // orders where the plugin runs before slopsmith's app.js
        // defines it. Retry a bounded number of times on the next
        // task — cap prevents an infinite loop in host environments
        // that never define playSong (e.g. the node:test vm harness).
        // Retry counter lives on `_ndShared` so a second evaluation
        // doesn't get a fresh 20-attempt budget on top of the first.
        if (_ndShared.playSongRetries++ < _ND_PLAY_SONG_MAX_RETRIES) {
            setTimeout(_ndInstallPlaySongHook, 50);
        }
        return;
    }
    // If this file was evaluated before, `window.playSong` already
    // points at our wrapper. Bail rather than wrap it again.
    if (origPlaySong._ndWrapped) return;
    const wrapper = async function (...args) {
        // Pin the custom song filename — args[0] is the playSong filename
        // arg; the WS song_info payload that hw.getSongInfo() returns
        // doesn't carry this field, so this is our only reliable
        // signal for the training-bundle manifest's custom song File Name.
        // Decode URI-encoded forms like 'sloppak%2Fbadramer.sloppak'.
        if (typeof args[0] === 'string') {
            let f = args[0];
            try { f = decodeURIComponent(f); } catch (_) { /* leave raw */ }
            _ndShared.currentFilename = f;
            const ret = _ndShared.diagnosticReturn;
            if (ret && ret.active && f) {
                const pf = ret.previousFilename;
                const isRestoreTarget = pf && f === pf;
                if (!isRestoreTarget && !_ndFilenameLooksDiagnostic(f)) {
                    _ndClearDiagnosticReturnState();
                }
            }
        }
        // For each live instance: silent-disable if currently enabled
        // (stop audio + timers without popping a summary modal), then
        // reset scoring unconditionally. Enabled-only disable misses
        // the case of a DISABLED instance that still holds stale
        // stats from the previous song — getStats() / showSummary()
        // on that instance would report yesterday's numbers until
        // the user clicked Detect again. Pre-factory code had a
        // single module-level `_ndResetScoring()` that always ran
        // here; the explicit `resetScoring()` on every instance
        // preserves that behaviour.
        for (const inst of _ndInstances) {
            if (inst.isEnabled()) inst.disable({ silent: true });
            if (typeof inst._resetScoring === 'function') inst._resetScoring();
        }
        const ret = await origPlaySong.apply(this, args);
        // Re-inject the default singleton's Detect button in case the
        // loader recreated the player-controls row. Tuning/capo/
        // arrangement are re-read later inside enable() from
        // hw.getSongInfo(); no need to refresh them eagerly here.
        if (window.noteDetect) {
            window.noteDetect.injectButton();
        }
        // Honour the user's standing preference: if they had Detect
        // turned on, keep it on across song switches. Without this,
        // every song requires another button press because the loop
        // above silent-disables the instance. The end-of-song summary
        // path also silent-disables, so this is the single re-arm
        // point that covers both "user picked next song" and "song
        // finished, user picked next" flows. Default singleton only
        // — splitscreen panels are opt-in surfaces the user mounts
        // per session, and reclaiming the mic for every panel on
        // every song change would be surprising. There's no public
        // isDefault() accessor; the singleton is the one anchored on
        // window.noteDetect.
        const def = window.noteDetect;
        if (def
            // Respect split mode's suppression of the default singleton — otherwise a
            // song switch re-arms the main detector on top of panel 1 (the same flag
            // honored by the song:loaded re-arm + construct auto-enable).
            && !(typeof window !== 'undefined' && window.__ndSuppressDefault)
            && typeof def.wantsDetect === 'function' && def.wantsDetect()
            && !def.isEnabled()) {
            // Fire-and-forget — enable() awaits getUserMedia which we
            // don't want to block playSong on. If the user denied mic
            // permission previously the failure surfaces through the
            // button text the same way it does for a manual click.
            def.enable().catch((e) => {
                console.warn('[note_detect] auto-re-enable on playSong failed:',
                    e && e.message ? e.message : e);
            });
        }
        return ret;
    };
    wrapper._ndWrapped = true;
    window.playSong = wrapper;
}

// ── Singleton + bootstrap ──────────────────────────────────────────────────
// Reuse an existing default instance if the file has been evaluated
// before (HMR, accidental double <script> load). Without this, each
// evaluation would call `createNoteDetector({isDefault:true})` afresh
// — and since `_ndShared.instances` is anchored on window, the old
// default would still be in the registry, producing duplicate Detect
// buttons and per-instance DOM on every reload. Pair this with the
// playSong-wrapper idempotency guard already in place; both together
// keep double-load end-to-end idempotent.
const _ndExistingDefault = (window.noteDetect && typeof window.noteDetect.injectButton === 'function')
    ? window.noteDetect
    : null;
const _ndDefaultInstance = _ndExistingDefault || createNoteDetector({ isDefault: true });
window.noteDetect = _ndDefaultInstance;
window.createNoteDetector = createNoteDetector;

// A host that mounts its own per-panel detectors (e.g. split-screen) calls this to
// SUPPRESS the default singleton while it owns detection — without it the singleton's
// construct auto-enable / song:loaded re-arm / playSong re-arm would render a second
// HUD + mic capture on top of the host's first panel. The internal guards read
// window.__ndSuppressDefault; centralizing the assignment behind this setter keeps the
// whole mechanism owned by, and complete within, this plugin.
window.createNoteDetector.setDefaultSuppressed = function (suppressed) {
    if (typeof window === 'undefined') return;
    window.__ndSuppressDefault = !!suppressed;
    // Flipping the guard only blocks FUTURE auto-enables/re-arms. If the singleton is
    // already running when the host takes over, tear that session down now too —
    // otherwise its live HUD + mic capture is exactly the duplicate state this is meant
    // to prevent. (The host captures wantsDetect()/isEnabled() first if it needs to
    // restore the singleton later.)
    if (suppressed) {
        const def = window.noteDetect;
        if (def && typeof def.isEnabled === 'function' && def.isEnabled()
            && typeof def.disable === 'function') {
            // SILENT — the host is only taking over detection, not ending a song. A
            // plain disable() would pop the end-of-song summary modal + emit
            // notedetect:session once the singleton has a few judgments.
            try { def.disable({ silent: true }); } catch (_) { /* best-effort */ }
        }
    }
};

_ndInstallPlaySongHook();
// Only inject on first evaluation — re-injecting on a subsequent load
// would duplicate the button, since the old one is still in the DOM.
if (!_ndExistingDefault) _ndDefaultInstance.injectButton();
