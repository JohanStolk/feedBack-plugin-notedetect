// src/calibration-wizard.js — subsystem E: Calibration Wizard v2
// nd-carve-8: extracted from src/main.js lines 6407-8645.
// Every mutable factory dep goes through a live accessor (LIVE-ACCESSOR RULE).
// Write-back callbacks for all factory-state mutations.

// ponytail: pure constants duplicated from main.js — no import dep needed
const _CAL_WIZARD_INSTRUMENT_CONFIGS = [
    { id: 'bass-4',   label: '4-string bass',   arrangement: 'bass',   stringCount: 4 },
    { id: 'bass-5',   label: '5-string bass',   arrangement: 'bass',   stringCount: 5 },
    { id: 'bass-6',   label: '6-string bass',   arrangement: 'bass',   stringCount: 6 },
    { id: 'guitar-6', label: '6-string guitar', arrangement: 'guitar', stringCount: 6 },
    { id: 'guitar-7', label: '7-string guitar', arrangement: 'guitar', stringCount: 7 },
    { id: 'guitar-8', label: '8-string guitar', arrangement: 'guitar', stringCount: 8 },
];
const CAL_TARGET_PEAK = 0.25; // -12 dBFS — ponytail: duplicated from main.js, pure numeric constant

export function createCalibrationWizard({
    // ── Live accessors (read at call time — LIVE-ACCESSOR RULE) ──────────────
    getInputLevel, getInputPeak,
    getDetectedMidi, getDetectedConfidence, getDetectedString, getDetectedFret,
    getDetectedDisplayMidi, getDetectionConfidenceMin,
    getLatencyOffset, getInputGain, getEngineInputGain,
    getEnabled, getUsingDesktopBridge,
    getAudioCtx, getBridgeSampleRate, getBridgeDesktop,
    getSelectedDeviceId, getSelectedChannel,
    getCurrentArrangement, getCurrentStringCount, getTuningOffsets,
    getHits, getMisses, getDetectionMethod,
    getDiagCatalog,
    // ── Write-back callbacks ──────────────────────────────────────────────────
    setInputGain,          // writes inputGain + gainNode.gain.value in main.js
    setLatencyOffset,      // writes latencyOffset
    setEngineInputGain,    // writes engineInputGain
    setCurrentArrangement, // writes currentArrangement
    setSelectedChannel,    // writes selectedChannel (binding note: was bare write)
    // ── Stable fn refs ────────────────────────────────────────────────────────
    resolveHw, enable, saveSettings,
    applyEngineGain,          // _ndApplyEngineGain
    openInputSource,          // _ndOpenSelectedInputSource
    closeInputSource,         // _ndCloseSelectedInputSource
    syncChartFromHw,          // _syncChartStateFromHw
    resetCalibrationSamples,  // _resetCalibrationSamples (sole reset path — binding note 3)
    ndSetEngineGain, ndResolveAudioBridge,
    ndMidiToName, ndMidiFromStringFret, ndStandardMidiFor, ndNearestOctaveCents,
    ndFormatMs, ndEscapeHtml,
    ndHealthDetectedLine, ndHealthInputChannelLabel, ndHealthDetectorPathLabel,
    formatLevel,              // calibrationFormatLevel (moved before wizard in main.js)
    calRequester,             // ND_AUDIO_CAL_REQUESTER = 'note_detect:calibration'
    restartAudio,
    openCalibrationLab,       // openInstrumentCalibrationLab
}) {
    // ── Module-private wizard state (moved from main.js factory vars 2294-2320) ──
    let _calWizardEl = null;
    let _calWizardTick = null;
    let _calWizardState = null;
    // One-shot callbacks for the public launchCalibration() entry (input_setup
    // onboarding). Set after the wizard opens; cleared on close.
    let _calWizardOnDone = null;
    let _calWizardOnCancel = null;
    // Instrument forced by launchCalibration({instrument}) for the standalone
    // (no-song) onboarding flow. _syncChartStateFromHw resets currentArrangement
    // to 'guitar' on every resolve when no chart is loaded, which would clobber a
    // bass calibration; honor this override while no real song tuning exists.
    let _calWizardForceArrangement = null;
    const _CAL_WIZARD_NOTE_CHECK_DEFS = [
        { id: 'lowE', string: 0, fallbackLabel: 'Low E', fallbackMidi: 40 },
        { id: 'openA', string: 1, fallbackLabel: 'Open A', fallbackMidi: 45 },
    ];
    const _CAL_WIZARD_STEPS = [
        { id: 'welcome', title: 'Welcome' },
        { id: 'audio', title: 'Audio Input' },
        { id: 'tuner', title: 'Tuner' },
        { id: 'noise', title: 'Noise Floor' },
        { id: 'signal', title: 'Signal Level' },
        { id: 'notes', title: 'Note Detection' },
        { id: 'timing', title: 'Timing / Latency' },
        { id: 'review', title: 'Review' },
        { id: 'apply', title: 'Apply' },
    ];



    const _CAL_WIZARD_CHANNEL_PROBE_MS = 3000;
    const _CAL_WIZARD_CHANNEL_PROBE_INTERVAL_MS = 100;
    const _CAL_WIZARD_CHANNEL_PROBE_SETTLE_MS = 250;
    const _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK = 0.05;
    const _CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO = 0.10;
    const _CAL_WIZARD_INPUT_CHANNEL_OPTIONS = [
        { ch: -1, label: 'Default / Mono Mix' },
        { ch: 0, label: 'Input 1 / Ch 1' },
        { ch: 1, label: 'Input 2 / Ch 2' },
    ];
    const _CAL_WIZARD_TIMED_PLAYALONG_SEC = 30;
    const _CAL_WIZARD_PLAY_ALONG_WAIT_MS = 60000;
    const _CAL_WIZARD_PLAY_ALONG_WAIT_POLL_MS = 250;
    const _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_SEC = 0.02;
    const _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_GAP_MS = 150;
    const _CAL_WIZARD_PAUSE_RETRY_DELAYS_MS = [0, 150, 500, 1200, 2500, 4000];
    let _calWizardPauseRetryTimers = [];

    function _calWizardDefaultAllStringsState() {
        return {
            running: false,
            index: 0,
            ids: [],
            complete: false,
            failedId: null,
            detailsOpen: false,
            message: null,
        };
    }

    function _calWizardClearPauseRetries() {
        _calWizardPauseRetryTimers.forEach((id) => clearTimeout(id));
        _calWizardPauseRetryTimers = [];
    }

    function _calWizardNewState() {
        return {
            step: 0,
            startedAt: Date.now(),
            tunerMinimized: false,
            noise: null,
            signal: null,
            notes: {},
            allStrings: _calWizardDefaultAllStringsState(),
            // Standalone instrument preset chosen in the note-detection step
            // (4/5/6-string bass, 6/7/8-string guitar); null = auto from song.
            selectedInstrumentConfig: null,
            timing: null,
            recommended: { inputGain: null, latencyOffset: null, reasons: {} },
            applyChecked: { inputGain: true, latencyOffset: true },
            applied: null,
            complete: null,
            playAlong: null,
            timingCaptureNote: null,
            autoCapture: null,
            channelProbeRunning: false,
            channelProbeResult: null,
            channelProbeError: null,
            channelProbeAbort: null,
        };
    }

    function _calWizardStopAutoCapture() {
        const wiz = _calWizardState;
        if (!wiz) return;
        if (wiz.autoCapture) {
            const ac = wiz.autoCapture;
            if (ac.timerId) clearTimeout(ac.timerId);
            if (ac.intervalId) clearInterval(ac.intervalId);
            wiz.autoCapture = null;
        }
        if (wiz.channelProbeAbort) {
            wiz.channelProbeAbort = null;
            wiz.channelProbeRunning = false;
        }
    }

    function _calWizardNoiseStatus(avgPct) {
        if (!Number.isFinite(avgPct)) return 'unknown';
        if (avgPct < 5) return 'good';
        if (avgPct < 15) return 'elevated';
        return 'too_noisy';
    }

    function _calWizardSignalStatus(avgPct, peakPct, noiseAvg) {
        if (!Number.isFinite(avgPct)) return 'unknown';
        const floor = Number.isFinite(noiseAvg) ? noiseAvg + 6 : 8;
        if (avgPct < floor) return 'too_low';
        if ((peakPct || avgPct) > 85) return 'too_hot';
        return 'good';
    }

    // ponytail: was in main.js pre-carve-8 between health and wizard block — moved here
    function _calWizardNoiseStatusDisplay(status) {
        if (status === 'good') return 'Good — quiet room (under 5%)';
        if (status === 'elevated') return 'Elevated — some background noise (5–15%)';
        if (status === 'too_noisy') return 'Too noisy — over 15%; lower gain or quiet the room';
        return status || '—';
    }

    function _calWizardSignalStatusDisplay(status) {
        if (status === 'good') return 'Good — strong enough for detection';
        if (status === 'too_low') return 'Too low — play louder or raise input gain';
        if (status === 'too_hot') return 'Too hot — risk of clipping; lower input gain';
        return status || '—';
    }

    // TARGET-BASED input normalization (replaces the old relative ±nudge): set the
    // gain so the player's HARDEST playing peaks at CAL_TARGET_PEAK (-12 dBFS), so
    // every instrument — quiet passive or hot active — lands at the SAME level and
    // the rig_builder amps stay clean. `signalPeakPct` is the captured peak as a %
    // of full scale; `measuredAtGain` is the gain it was captured at (1.0 on desktop
    // where the signal step forces the engine to unity, else the current web gain),
    // divided out to recover the raw peak before solving for the target.
    function _calWizardRecommendInputGain(signalStatus, currentGain, signalAvg, signalPeakPct, measuredAtGain) {
        // The measurement basis must be a known positive gain. A null/invalid
        // value means we couldn't establish it (e.g. on the desktop engine path
        // the unity-set failed), so DON'T recommend — dividing the peak by an
        // assumed `1` (or the unrelated web gain) would yield a wrong calibration.
        if (!(Number.isFinite(measuredAtGain) && measuredAtGain > 0)) return null;
        const measGain = measuredAtGain;
        const rawPeak = (Number.isFinite(signalPeakPct) ? signalPeakPct / 100 : 0) / measGain;
        if (rawPeak < 0.02) return null;   // no real signal captured — don't recommend
        const target = Math.max(0.1, Math.min(5, CAL_TARGET_PEAK / rawPeak));
        const pct = Math.round(rawPeak * 100);
        return {
            value: +target.toFixed(2),
            reason: `Hardest playing peaked at ~${pct}% of full scale — set input to ${target.toFixed(2)}× so it lands near −12 dBFS (keeps the amps clean and matches other instruments).`,
        };
    }

    function _calWizardRecommendLatency(medianMs, currentLatencyS) {
        if (!Number.isFinite(medianMs) || Math.abs(medianMs) < 8) return null;
        const cur = Number.isFinite(currentLatencyS) ? currentLatencyS : 0.08;
        const delta = (medianMs / 1000) * 0.5;
        const target = Math.max(0, Math.min(0.25, cur + delta));
        if (Math.abs(target - cur) < 0.005) return null;
        const dir = medianMs > 0 ? 'late' : 'early';
        return {
            value: +target.toFixed(3),
            reason: `Hit timing median is ${ndFormatMs(medianMs)} (${dir}) — adjusting audio latency offset may align notes with the chart.`,
        };
    }

    function _calWizardBuildSafeRecommendations(wiz, snap) {
        const rec = { inputGain: null, latencyOffset: null, reasons: {} };
        if (wiz && wiz.signal) {
            const g = _calWizardRecommendInputGain(
                wiz.signal.status, getInputGain(), wiz.signal.avgPct, wiz.signal.peakPct, wiz._measuredAtGain);
            if (g) {
                rec.inputGain = g.value;
                rec.reasons.inputGain = g.reason;
            }
        }
        const med = wiz && wiz.timing && Number.isFinite(wiz.timing.medianMs)
            ? wiz.timing.medianMs
            : (snap && snap.timingMedianMs);
        const lat = _calWizardRecommendLatency(med, getLatencyOffset());
        if (lat) {
            rec.latencyOffset = lat.value;
            rec.reasons.latencyOffset = lat.reason;
        }
        wiz.recommended = rec;
        return rec;
    }

    function _calWizardSetAutoStatus(html) {
        const el = _calWizardEl && _calWizardEl.querySelector('.nd-cal-auto-status');
        if (el) el.innerHTML = html;
    }

    function _calWizardSetChannelProbeStatus(html) {
        const el = _calWizardEl && _calWizardEl.querySelector('.nd-cal-channel-probe-status');
        if (el) el.innerHTML = html;
    }

    function _calWizardSetTunerOpenStatus(message, tone) {
        const el = _calWizardEl && _calWizardEl.querySelector('.nd-cal-tuner-open-status');
        if (!el) return;
        if (!message) {
            el.innerHTML = '';
            return;
        }
        const cls = tone === 'warn' ? 'text-amber-200/90' : 'text-gray-400';
        el.innerHTML = `<span class="${cls}">${message}</span>`;
    }

    function _calWizardIsTunerUiVisible() {
        const el = document.getElementById('tuner-plugin-ui');
        if (!el || el.classList.contains('hidden')) return false;
        const cs = window.getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }

    async function _calWizardWaitForTunerUiVisible(maxMs) {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            if (_calWizardIsTunerUiVisible()) return true;
            await _calWizardSleep(100);
        }
        return _calWizardIsTunerUiVisible();
    }

    async function _calWizardOpenTunerFromWizard() {
        if (!window.tuner || typeof window.tuner.enable !== 'function') {
            _calWizardSetTunerOpenStatus(
                'Tuner plugin is not loaded. Enable the Tuner plugin, then try again.', 'warn');
            return;
        }
        _calWizardSetTunerOpenStatus('Opening tuner…', 'neutral');
        try {
            await window.tuner.enable();
        } catch (e) {
            console.warn('[note_detect] tuner enable:', e);
            _calWizardSetTunerOpenStatus(
                'Tuner did not open. Check microphone permission or open the Tuner from the bottom toolbar.', 'warn');
            return;
        }
        const visible = await _calWizardWaitForTunerUiVisible(4000);
        if (visible) {
            _calWizardSetTunerOpenStatus('', 'neutral');
            _calWizardSetTunerMinimized(true);
            return;
        }
        _calWizardSetTunerOpenStatus(
            'Tuner did not open. Check microphone permission or open the Tuner from the bottom toolbar.', 'warn');
    }

    function _calWizardFinishLevelSample(wiz, kind, samples) {
        if (!samples.length) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">No samples — turn Detect on and retry.</span>');
            return;
        }
        let sum = 0;
        let maxPeak = 0;
        for (const s of samples) {
            sum += s.level;
            if (s.peak > maxPeak) maxPeak = s.peak;
        }
        const avg = Math.round(sum / samples.length);
        const peak = maxPeak;
        if (kind === 'noise') {
            wiz.noise = {
                avgPct: avg,
                peakPct: peak,
                status: _calWizardNoiseStatus(avg),
                captured: true,
                at: Date.now(),
            };
            const label = _calWizardNoiseStatusDisplay(wiz.noise.status);
            _calWizardSetAutoStatus(
                `<span class="text-green-300/90">Captured:</span> avg ${avg}% · peak ${peak}% · <span class="font-semibold">${label}</span>`);
        } else if (kind === 'signal') {
            const noiseAvg = wiz.noise && wiz.noise.avgPct;
            wiz.signal = {
                avgPct: avg,
                peakPct: peak,
                status: _calWizardSignalStatus(avg, peak, noiseAvg),
                captured: true,
                at: Date.now(),
            };
            const label = _calWizardSignalStatusDisplay(wiz.signal.status);
            let extra = '';
            const gRec = _calWizardRecommendInputGain(wiz.signal.status, getInputGain(), avg, peak, wiz._measuredAtGain);
            if (gRec) extra = `<div class="text-gray-400 mt-1">Suggested input gain: ${gRec.value}x</div>`;
            // We forced the engine to unity to measure the raw peak. Don't leave it
            // there — on the engine path, drop it to the just-computed target now, so
            // whether the user applies (this becomes the calibration) or cancels, the
            // engine sits at a safe level instead of hot at unity. (No-op without a
            // recommendation, e.g. no signal captured; the host still re-asserts its
            // preset gain on the next tone load.)
            if (gRec && wiz._onEnginePath) ndSetEngineGain(gRec.value);
            _calWizardSetAutoStatus(
                `<span class="text-green-300/90">Captured:</span> avg ${avg}% · peak ${peak}% · <span class="font-semibold">${label}</span>${extra}`);
            _calWizardBuildSafeRecommendations(wiz, getCalibrationSnapshot());
        }
        renderCalibrationWizard();
    }

    function _calWizardRunLevelSampler(wiz, kind, durationMs, onDone) {
        _calWizardStopAutoCapture();
        const samples = [];
        const started = Date.now();
        wiz.autoCapture = { kind, phase: 'listening', samples, started };
        const tick = () => {
            const snap = getCalibrationSnapshot();
            samples.push({ level: snap.inputLevelPct, peak: snap.inputPeakPct, t: Date.now() });
            const elapsed = Date.now() - started;
            _calWizardSetAutoStatus(
                `<span class="text-cyan-300/90">Listening…</span> ${Math.round(elapsed / 1000)}s / ${Math.round(durationMs / 1000)}s · `
                + formatLevel(snap.inputLevelPct, snap.inputPeakPct));
            if (elapsed >= durationMs) {
                _calWizardStopAutoCapture();
                onDone(samples);
            }
        };
        tick();
        wiz.autoCapture.intervalId = setInterval(tick, 120);
        wiz.autoCapture.timerId = setTimeout(() => {
            _calWizardStopAutoCapture();
            onDone(samples);
        }, durationMs + 200);
    }

    function _calWizardBeginCountdownThen(kind, countdownSec, afterCountdown) {
        const wiz = _calWizardState;
        if (!wiz) return;
        _calWizardStopAutoCapture();
        let left = countdownSec;
        wiz.autoCapture = { kind, phase: 'countdown', left };
        const tick = () => {
            if (!_calWizardState || _calWizardState !== wiz) return;
            // Keep the live counter on autoCapture so the per-string row cells
            // (rendered by _calWizardRefreshLive) can show the same countdown
            // inline, next to the Check button the user just pressed.
            if (wiz.autoCapture) wiz.autoCapture.left = left;
            _calWizardSetAutoStatus(`<span class="text-cyan-300/90">Get ready…</span> <span class="text-2xl font-bold text-white">${left}</span>`);
            if (left <= 0) {
                _calWizardStopAutoCapture();
                afterCountdown();
                return;
            }
            left--;
            wiz.autoCapture.timerId = setTimeout(tick, 1000);
        };
        tick();
    }

    function _calWizardStartNoiseCapture() {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calWizardBeginCountdownThen('noise', 3, () => {
            _calWizardSetAutoStatus('<span class="text-cyan-300/90">Listening…</span> Mute all strings.');
            _calWizardRunLevelSampler(wiz, 'noise', 1600, (samples) => {
                _calWizardFinishLevelSample(wiz, 'noise', samples);
            });
        });
    }

    function _calWizardStartSignalCapture() {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        const noiseFloor = (wiz.noise && wiz.noise.avgPct) || 3;
        const trigger = noiseFloor + 8;
        // Measure at UNITY engine gain so the captured peak is the RAW input (the
        // engine meter is post-gain). Record whether we're on the desktop engine
        // path so a *failed* unity-set isn't mis-measured against the web gain
        // (which isn't in the engine signal path). On the engine path: force unity
        // and record 1.0 (or null if it didn't take → the recommendation bails).
        // On the browser path: no engine bridge, so the peak reflects the current
        // web gain (`inputGain`), which the recommendation divides back out.
        wiz._onEnginePath = !!ndResolveAudioBridge();
        wiz._measuredAtGain = wiz._onEnginePath
            ? (ndSetEngineGain(1.0) ? 1.0 : null)
            : getInputGain();
        _calWizardBeginCountdownThen('signal', 3, () => {
            _calWizardStopAutoCapture();
            const samples = [];
            const started = Date.now();
            const maxWait = 12000;
            wiz.autoCapture = { kind: 'signal', phase: 'wait_signal', samples, started };
            const tick = () => {
                const s = getCalibrationSnapshot();
                const lvl = s.inputLevelPct;
                const elapsed = Date.now() - started;
                if (lvl >= trigger && wiz.autoCapture.phase === 'wait_signal') {
                    wiz.autoCapture.phase = 'listening';
                    wiz.autoCapture.signalStarted = Date.now();
                    _calWizardSetAutoStatus('<span class="text-cyan-300/90">Signal detected — listening…</span> Play open low E.');
                }
                if (wiz.autoCapture.phase === 'listening') {
                    samples.push({ level: lvl, peak: s.inputPeakPct, t: Date.now() });
                    const listenFor = Date.now() - (wiz.autoCapture.signalStarted || started);
                    _calWizardSetAutoStatus(
                        `<span class="text-cyan-300/90">Listening…</span> ${Math.round(listenFor / 1000)}s · `
                        + formatLevel(lvl, s.inputPeakPct));
                    if (listenFor >= 1600) {
                        _calWizardStopAutoCapture();
                        _calWizardFinishLevelSample(wiz, 'signal', samples);
                        return;
                    }
                } else {
                    _calWizardSetAutoStatus(
                        `<span class="text-cyan-300/90">Waiting for signal…</span> Play open low E (need ≥${trigger}%). `
                        + formatLevel(lvl, s.inputPeakPct));
                    if (elapsed >= maxWait) {
                        _calWizardStopAutoCapture();
                        _calWizardSetAutoStatus('<span class="text-amber-200/90">Timeout — no signal detected. Retry when ready.</span>');
                    }
                }
            };
            tick();
            wiz.autoCapture.intervalId = setInterval(tick, 120);
        });
    }

    function _calWizardResolveNoteCheckContext() {
        try { syncChartFromHw(); } catch (_) { /* read-only refresh */ }
        const hw = resolveHw();
        let info = null;
        try { info = (hw && hw.getSongInfo) ? hw.getSongInfo() : null; } catch (_) {}
        const hasTuning = !!(info && Array.isArray(info.tuning) && info.tuning.length > 0);
        // No real song tuning (onboarding standalone). Priority for what to
        // calibrate: (1) the user's explicit instrument-config dropdown, then
        // (2) the launchCalibration() arrangement override, else (3) the
        // guitar default. _syncChartStateFromHw just reset getCurrentArrangement()
        // to 'guitar', so without these overrides a bass/extended-range player
        // would silently calibrate a 6-string guitar.
        const cfgId = _calWizardState && _calWizardState.selectedInstrumentConfig;
        const cfg = (!hasTuning && cfgId)
            ? _CAL_WIZARD_INSTRUMENT_CONFIGS.find((c) => c.id === cfgId)
            : null;
        const forced = !hasTuning && !cfg && _calWizardForceArrangement;
        let arrangement;
        let stringCount;
        if (cfg) {
            arrangement = cfg.arrangement;
            stringCount = cfg.stringCount;
        } else {
            arrangement = forced
                ? _calWizardForceArrangement
                : (getCurrentArrangement() || 'guitar');
            // When forcing a standalone arrangement with no host chart,
            // _syncChartStateFromHw left getCurrentStringCount() at the guitar
            // default (6); pick the arrangement's own default so a bass
            // calibration shows 4 strings, not 6 (two of them blank).
            stringCount = (Number.isFinite(getCurrentStringCount()) && getCurrentStringCount() > 0)
                ? getCurrentStringCount() : 6;
            if (forced && _calWizardForceArrangement === 'bass') stringCount = 4;
        }
        const offsets = Array.isArray(getTuningOffsets()) ? getTuningOffsets() : [0, 0, 0, 0, 0, 0];
        // `preset` is the standalone instrument the user picked (or null). When
        // set we know the real open-string notes even with no song loaded, so
        // labels should show them instead of the generic Low E / Open A.
        return { hasTuning, arrangement, stringCount, offsets, preset: cfg || null };
    }

    function _calWizardOpenStringMidi(stringIndex, ctx) {
        const { hasTuning, arrangement, stringCount, offsets } = ctx;
        let expectedMidi = null;
        if (hasTuning) {
            try {
                const computed = ndMidiFromStringFret(
                    stringIndex, 0, arrangement, stringCount, offsets, 0);
                if (Number.isFinite(computed)) expectedMidi = computed;
            } catch (_) { /* fall through to fallback */ }
        }
        if (!Number.isFinite(expectedMidi)) {
            try {
                const base = ndStandardMidiFor(arrangement, stringCount);
                if (base && base[stringIndex] !== undefined) expectedMidi = base[stringIndex];
            } catch (_) { /* ignore */ }
        }
        return expectedMidi;
    }

    function _calWizardOpenStringDisplayNum(stringIndex, stringCount) {
        return stringCount - stringIndex;
    }

    function _calWizardOpenStringLabel(stringIndex, stringCount, expectedNote, hasTuning) {
        const n = _calWizardOpenStringDisplayNum(stringIndex, stringCount);
        const note = expectedNote || '—';
        if (stringIndex === 0) {
            return hasTuning
                ? `String ${n} — low string (${note})`
                : `String ${n} — low string`;
        }
        if (stringIndex === stringCount - 1) {
            return hasTuning
                ? `String ${n} — high string (${note})`
                : `String ${n} — high string`;
        }
        return hasTuning ? `String ${n} (${note})` : `String ${n}`;
    }

    function _calWizardResolveNoteChecks(opts) {
        const mode = (opts && opts.mode === 'all') ? 'all' : 'quick';
        const ctx = _calWizardResolveNoteCheckContext();
        const { hasTuning, stringCount } = ctx;
        // Always name the target note so the player knows exactly what to play
        // (tester feedback: the generic "Low E / Open A" tests were unclear).
        // We always resolve a concrete expectedMidi below — from the song tuning,
        // a chosen standalone preset, or the standard-tuning fallback — so the
        // label can always show it. An extended-range player who hasn't loaded a
        // song still sees the standard-tuning note and can pick a preset to refine.
        const showNote = true;
        if (mode === 'all') {
            const specs = [];
            for (let s = 0; s < stringCount; s++) {
                const expectedMidi = _calWizardOpenStringMidi(s, ctx);
                if (!Number.isFinite(expectedMidi)) continue;
                const expectedNote = ndMidiToName(expectedMidi);
                specs.push({
                    id: 'openS' + s,
                    label: _calWizardOpenStringLabel(s, stringCount, expectedNote, showNote),
                    expectedMidi,
                    expectedNote,
                    string: s,
                    displayString: _calWizardOpenStringDisplayNum(s, stringCount),
                });
            }
            return specs;
        }
        const specs = [];
        for (const def of _CAL_WIZARD_NOTE_CHECK_DEFS) {
            if (def.string >= stringCount) continue;
            let expectedMidi = _calWizardOpenStringMidi(def.string, ctx);
            if (!Number.isFinite(expectedMidi)) expectedMidi = def.fallbackMidi;
            const expectedNote = ndMidiToName(expectedMidi);
            const label = def.string === 0
                ? (showNote ? `Open low string (${expectedNote})` : def.fallbackLabel)
                : (showNote ? `Open 2nd string (${expectedNote})` : def.fallbackLabel);
            specs.push({
                id: def.id,
                label,
                expectedMidi,
                expectedNote,
                string: def.string,
            });
        }
        if (!specs.length) {
            return _CAL_WIZARD_NOTE_CHECK_DEFS.map((def) => ({
                id: def.id,
                label: def.fallbackLabel,
                expectedMidi: def.fallbackMidi,
                expectedNote: ndMidiToName(def.fallbackMidi),
                string: def.string,
            }));
        }
        return specs;
    }

    function _calWizardFindNoteCheckSpec(noteId) {
        if (!noteId) return null;
        const quick = _calWizardResolveNoteChecks({ mode: 'quick' });
        const hit = quick.find((n) => n.id === noteId);
        if (hit) return hit;
        const all = _calWizardResolveNoteChecks({ mode: 'all' });
        return all.find((n) => n.id === noteId) || null;
    }

    // The open strings shown (and run) in the advanced panel: every open string
    // EXCEPT the ones the quick Open low / Open 2nd checks above already cover.
    // Shared by the render and the Run-All sweep so the run only ever targets
    // strings that have a visible row (with its own inline countdown/result).
    function _calWizardResolveAdvancedStringChecks() {
        const quickStrings = new Set(_calWizardResolveNoteChecks({ mode: 'quick' }).map((s) => s.string));
        return _calWizardResolveNoteChecks({ mode: 'all' }).filter((s) => !quickStrings.has(s.string));
    }

    // Result-cell colour + text for one open-string check, shared by the static
    // render and the live per-row refresh so a row reads the same either way.
    function _calWizardNoteResultParts(spec) {
        const wiz = _calWizardState;
        const r = wiz && wiz.notes ? wiz.notes[spec.id] : null;
        if (r && r.ok) {
            return { cls: 'text-green-300/90', txt: `OK — heard ${r.heardNote} (${r.confidencePct}%)` };
        }
        if (r) {
            return { cls: 'text-amber-200/90', txt: `Failed — expected ${r.expectedNote || spec.expectedNote}` };
        }
        return { cls: 'text-gray-500', txt: `Expected ${spec.expectedNote}` };
    }

    // The open-string check (if any) currently counting down or listening, so
    // its inline row cell shows live status instead of the stored result. The
    // countdown autoCapture encodes the note id in `kind` ("note_<id>"); the
    // listening autoCapture carries it on `noteId`.
    function _calWizardActiveNoteCapture() {
        const ac = _calWizardState && _calWizardState.autoCapture;
        if (!ac) return null;
        if (ac.phase === 'countdown' && typeof ac.kind === 'string' && ac.kind.startsWith('note_')) {
            return { id: ac.kind.slice(5), phase: 'countdown', left: Number.isFinite(ac.left) ? ac.left : '' };
        }
        if (ac.kind === 'note' && ac.noteId) {
            return { id: ac.noteId, phase: 'listening' };
        }
        return null;
    }

    // Wizard-only raw pitch readout — bypasses chart-aware getDetectedDisplayMidi().
    function _calWizardRawPitchFields() {
        const confOk = getDetectedConfidence() > getDetectionConfidenceMin();
        const rawMidi = (getDetectedMidi() >= 0 && confOk) ? getDetectedMidi() : null;
        const rawNote = Number.isFinite(rawMidi) ? ndMidiToName(rawMidi) : '—';
        let displayNote = null;
        if (getDetectedString() >= 0 && confOk) {
            const dm = Number.isFinite(getDetectedDisplayMidi()) ? getDetectedDisplayMidi() : getDetectedMidi();
            if (Number.isFinite(dm)) displayNote = ndMidiToName(dm);
        }
        return {
            rawMidi,
            rawNote,
            displayNote,
            confidencePct: confOk ? Math.round(getDetectedConfidence() * 100) : null,
            channel: ndHealthInputChannelLabel(),
        };
    }

    function _calWizardMidiNearTarget(detectedMidi, targetMidi, centsTol) {
        if (!Number.isFinite(detectedMidi) || !Number.isFinite(targetMidi)) return false;
        return Math.abs(ndNearestOctaveCents(detectedMidi, targetMidi)) <= centsTol;
    }

    function _calWizardStopAllStringsRun(reason, opts) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.allStrings) return;
        const seq = wiz.allStrings;
        const wasRunning = seq.running;
        seq.running = false;
        if (opts && opts.clearMessage) seq.message = null;
        if (reason === 'restart') {
            seq.complete = false;
            seq.failedId = null;
        }
        if (wasRunning && wiz.autoCapture && wiz.autoCapture.kind === 'note') {
            const nid = wiz.autoCapture.noteId;
            if (nid && seq.ids && seq.ids.includes(nid)) {
                _calWizardStopAutoCapture();
            }
        }
    }

    function _calWizardStartAllStringsRun() {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calWizardStopAllStringsRun('restart', { clearMessage: true });
        // Sweep only the advanced rows (the two lowest strings are covered by
        // the quick Open low / Open 2nd checks) so every run target has a
        // visible row to show its countdown/result.
        const specs = _calWizardResolveAdvancedStringChecks();
        if (!specs.length) return;
        for (const key of Object.keys(wiz.notes)) {
            if (key.startsWith('openS')) delete wiz.notes[key];
        }
        const ids = specs.map((s) => s.id);
        const first = specs[0];
        wiz.allStrings = {
            running: true,
            index: 0,
            ids,
            complete: false,
            failedId: null,
            detailsOpen: true,
            message: first ? `Play ${first.label}` : null,
        };
        renderCalibrationWizard();
        _calWizardStartNoteCapture(ids[0]);
    }

    function _calWizardAdvanceAllStringsRun(noteId, ok) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.allStrings || !wiz.allStrings.running) return false;
        const seq = wiz.allStrings;
        const expectedId = seq.ids[seq.index];
        if (noteId !== expectedId) return true;
        seq.detailsOpen = true;
        if (!ok) {
            seq.running = false;
            seq.failedId = noteId;
            const spec = _calWizardFindNoteCheckSpec(noteId);
            const label = spec ? spec.label : noteId;
            seq.message = `${label} did not pass — retry the run or check manually.`;
            renderCalibrationWizard();
            return true;
        }
        seq.index += 1;
        if (seq.index >= seq.ids.length) {
            seq.running = false;
            seq.complete = true;
            seq.message = 'Remaining strings passed.';
            _calWizardSetAutoStatus('<span class="text-green-300/90">Remaining strings passed.</span>');
            renderCalibrationWizard();
            return true;
        }
        const nextId = seq.ids[seq.index];
        const nextSpec = _calWizardFindNoteCheckSpec(nextId);
        seq.message = nextSpec ? `Play ${nextSpec.label}` : `Play string ${seq.index + 1}`;
        renderCalibrationWizard();
        _calWizardStartNoteCapture(nextId);
        return true;
    }

    function _calWizardStartNoteCapture(noteId) {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            if (wiz.allStrings && wiz.allStrings.running) {
                _calWizardStopAllStringsRun('detect-off');
            }
            return;
        }
        _calWizardBeginCountdownThen('note_' + noteId, 2, () => {
            const spec = _calWizardFindNoteCheckSpec(noteId);
            if (!spec) return;
            _calWizardStopAutoCapture();
            const stable = [];
            const started = Date.now();
            const maxWait = 14000;
            wiz.autoCapture = { kind: 'note', noteId, stable, started };
            const tick = () => {
                const s = getCalibrationSnapshot();
                const heardMidi = _calWizardRawPitchFields().rawMidi;
                if (_calWizardMidiNearTarget(heardMidi, spec.expectedMidi, 100)) {
                    stable.push({ midi: heardMidi, conf: getDetectedConfidence(), t: Date.now() });
                } else {
                    stable.length = 0;
                }
                const elapsed = Date.now() - started;
                if (stable.length >= 4) {
                    const last = stable[stable.length - 1];
                    wiz.notes[noteId] = {
                        ok: true,
                        label: spec.label,
                        expectedNote: spec.expectedNote,
                        expectedMidi: spec.expectedMidi,
                        heardNote: ndMidiToName(last.midi),
                        confidencePct: Math.round(last.conf * 100),
                        at: Date.now(),
                    };
                    _calWizardStopAutoCapture();
                    _calWizardSetAutoStatus(
                        `<span class="text-green-300/90">${spec.label} OK</span> — `
                        + `expected ${spec.expectedNote}, heard ${wiz.notes[noteId].heardNote} `
                        + `(${wiz.notes[noteId].confidencePct}% conf)`);
                    if (!_calWizardAdvanceAllStringsRun(noteId, true)) {
                        renderCalibrationWizard();
                    }
                    return;
                }
                _calWizardSetAutoStatus(
                    `<span class="text-cyan-300/90">Listening for ${spec.label}…</span> `
                    + (s.heardConfidencePct != null
                        ? `Expected: ${spec.expectedNote} · Heard: ${s.rawHeardNote ?? s.heardNote} · ${s.heardConfidencePct}%`
                        : `Expected: ${spec.expectedNote} · Channel: ${s.channel || '—'} · Live: `
                        + formatLevel(s.inputLevelPct, s.inputPeakPct)));
                if (elapsed >= maxWait) {
                    _calWizardStopAutoCapture();
                    wiz.notes[noteId] = {
                        ok: false,
                        label: spec.label,
                        expectedNote: spec.expectedNote,
                        expectedMidi: spec.expectedMidi,
                        at: Date.now(),
                    };
                    _calWizardSetAutoStatus(
                        `<span class="text-amber-200/90">${spec.label}: no stable note detected. `
                        + `Expected ${spec.expectedNote}. Retry.</span>`);
                    if (!_calWizardAdvanceAllStringsRun(noteId, false)) {
                        renderCalibrationWizard();
                    }
                }
            };
            tick();
            wiz.autoCapture.intervalId = setInterval(tick, 150);
        });
    }

    function _calWizardCaptureTimingSnapshot() {
        const wiz = _calWizardState;
        if (!wiz) return;
        let d = null;
        try { d = getCalibrationSnapshot().diagnostic; } catch (_) {}
        const dist = d && d.timing_error_ms_hits ? d.timing_error_ms_hits : {};
        const med = dist.median;
        const count = dist.count || 0;
        wiz.timing = {
            medianMs: Number.isFinite(med) ? med : null,
            sampleCount: count,
            captured: true,
            at: Date.now(),
        };
        _calWizardBuildSafeRecommendations(wiz, getCalibrationSnapshot());
        renderCalibrationWizard();
    }

    // Hides the wizard card and passes clicks through — reused for tuner step and
    // timing play-along (not tuner-specific despite the name).
    function _calWizardSetTunerMinimized(minimized) {
        const wiz = _calWizardState;
        if (!_calWizardEl || !wiz) return;
        wiz.tunerMinimized = !!minimized;
        const card = _calWizardEl.querySelector('.nd-cal-wizard-card');
        const ret = _calWizardEl.querySelector('.nd-cal-return-wizard');
        if (minimized) {
            _calWizardEl.style.background = 'transparent';
            _calWizardEl.style.pointerEvents = 'none';
            if (card) card.style.visibility = 'hidden';
            if (ret) ret.style.display = 'block';
        } else {
            _calWizardEl.style.background = 'rgba(0,0,0,0.65)';
            _calWizardEl.style.pointerEvents = 'auto';
            if (card) card.style.visibility = 'visible';
            if (ret) ret.style.display = 'none';
            _calWizardUpdateReturnButtonTimer(null);
        }
    }

    function _calWizardMinimizeForPlayback() {
        _calWizardSetTunerMinimized(true);
    }

    function _calWizardUpdateReturnButtonTimer(secLeft) {
        if (!_calWizardEl) return;
        const primary = _calWizardEl.querySelector('.nd-cal-return-primary');
        const secondary = _calWizardEl.querySelector('.nd-cal-return-secondary');
        if (!primary || !secondary) return;
        if (secLeft === 'waiting') {
            primary.textContent = 'Press Play to start timing';
            secondary.textContent = `The ${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s timer starts when playback begins`;
        } else if (Number.isFinite(secLeft) && secLeft >= 0) {
            primary.textContent = `Timing test: ${secLeft}s left`;
            secondary.textContent = 'Keep playing — setup will return automatically';
        } else {
            primary.textContent = 'Return to Calibration Wizard';
            secondary.textContent = 'Tap here to continue setup';
        }
    }

    function _calWizardTeardownPlayAlongWait(pa) {
        if (!pa) return;
        if (pa.waitTimeoutId) {
            clearTimeout(pa.waitTimeoutId);
            pa.waitTimeoutId = null;
        }
        if (pa.waitPollId) {
            clearInterval(pa.waitPollId);
            pa.waitPollId = null;
        }
        if (pa.onPlayHandler && window.slopsmith && typeof window.slopsmith.off === 'function') {
            try { window.slopsmith.off('song:play', pa.onPlayHandler); } catch (_) {}
            pa.onPlayHandler = null;
        }
    }

    function _calWizardIsPlaybackActive() {
        try {
            if (window.slopsmith && window.slopsmith.isPlaying) return true;
        } catch (_) { /* host may be unavailable */ }
        return false;
    }

    function _calWizardPlayheadAdvancing(pa) {
        const hw = resolveHw();
        if (!hw || typeof hw.getTime !== 'function' || !pa) return false;
        const t = hw.getTime();
        if (!Number.isFinite(pa._phLast)) {
            pa._phLast = t;
            pa._phLastAt = Date.now();
            return false;
        }
        const gapMs = Date.now() - pa._phLastAt;
        if (gapMs < _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_GAP_MS) return false;
        const advancing = t > pa._phLast + _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_SEC;
        pa._phLast = t;
        pa._phLastAt = Date.now();
        return advancing;
    }

    function _calWizardBeginTimedPlayAlongCountdown() {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong || wiz.playAlong.phase !== 'waiting') return;
        const pa = wiz.playAlong;
        _calWizardTeardownPlayAlongWait(pa);
        pa.phase = 'running';
        pa.endsAt = Date.now() + pa.durationMs;
        const tickCountdown = () => {
            if (!_calWizardState || !_calWizardState.playAlong) return;
            const active = _calWizardState.playAlong;
            if (active.phase !== 'running' || !Number.isFinite(active.endsAt)) return;
            const left = Math.ceil((active.endsAt - Date.now()) / 1000);
            if (left <= 0) {
                _calWizardFinishTimedPlayAlong(false);
                return;
            }
            _calWizardUpdateReturnButtonTimer(left);
        };
        tickCountdown();
        pa.intervalId = setInterval(tickCountdown, 1000);
        pa.timerId = setTimeout(() => _calWizardFinishTimedPlayAlong(false), pa.durationMs + 50);
    }

    function _calWizardPollPlayAlongWait() {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong || wiz.playAlong.phase !== 'waiting') return;
        const pa = wiz.playAlong;
        if (pa.playbackSeen || _calWizardIsPlaybackActive() || _calWizardPlayheadAdvancing(pa)) {
            _calWizardBeginTimedPlayAlongCountdown();
        }
    }

    function _calWizardCancelTimedPlayAlongWaiting(message) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong) return;
        _calWizardStopTimedPlayAlong('cancel-wait');
        _calWizardSetTunerMinimized(false);
        wiz.timingCaptureNote = message;
        renderCalibrationWizard();
        _calWizardRefreshLive();
    }

    function _calWizardStopTimedPlayAlong(reason) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong) return false;
        const pa = wiz.playAlong;
        _calWizardTeardownPlayAlongWait(pa);
        if (pa.timerId) {
            clearTimeout(pa.timerId);
            pa.timerId = null;
        }
        if (pa.intervalId) {
            clearInterval(pa.intervalId);
            pa.intervalId = null;
        }
        wiz.playAlong = null;
        _calWizardUpdateReturnButtonTimer(null);
        return true;
    }

    function _calWizardDispatchPlaybackPause(reason) {
        const caps = window.slopsmith && window.slopsmith.capabilities;
        if (!caps || typeof caps.dispatch !== 'function') {
            return Promise.resolve({ attempted: false, handled: false });
        }
        try {
            const result = caps.dispatch({
                capability: 'playback',
                command: 'pause',
                requester: 'slopsmith-plugin-notedetect',
                args: { requesterId: 'cal-wizard-timed-playalong', reason: reason || 'timed-playalong-complete' },
            });
            const parse = (r) => ({
                attempted: true,
                handled: !!(r && (r.outcome === 'handled' || r.status === 'paused')),
                result: r,
            });
            if (result && typeof result.then === 'function') {
                return result.then(parse).catch((e) => {
                    console.warn('[note_detect] cal-wizard timed playalong pause:', e);
                    return { attempted: true, handled: false, error: e };
                });
            }
            return Promise.resolve(parse(result));
        } catch (e) {
            console.warn('[note_detect] cal-wizard timed playalong pause:', e);
            return Promise.resolve({ attempted: false, handled: false, error: e });
        }
    }

    function _calWizardAppendTimingCaptureNote(fragment) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.timingCaptureNote || !fragment) return;
        if (!wiz.timingCaptureNote.includes(fragment)) {
            wiz.timingCaptureNote += ` ${fragment}`;
            renderCalibrationWizard();
        }
    }

    function _calWizardMaybePauseAfterTimedPlayAlong(pa) {
        if (!pa || pa.wasPlayingAtArm !== false) return;
        if (!_calWizardIsPlaybackActive()) return;
        _calWizardClearPauseRetries();
        const delays = _CAL_WIZARD_PAUSE_RETRY_DELAYS_MS;
        delays.forEach((delayMs, idx) => {
            const isLast = idx === delays.length - 1;
            const timerId = setTimeout(() => {
                _calWizardPauseRetryTimers = _calWizardPauseRetryTimers.filter((id) => id !== timerId);
                if (!_calWizardState) return;
                if (!_calWizardIsPlaybackActive()) {
                    _calWizardAppendTimingCaptureNote('Playback paused.');
                    return;
                }
                const reason = idx === 0
                    ? 'cal-wizard-timed-playalong-complete'
                    : 'cal-wizard-timed-playalong-retry';
                _calWizardDispatchPlaybackPause(reason).then(() => {
                    if (!_calWizardState) return;
                    if (!_calWizardIsPlaybackActive()) {
                        _calWizardAppendTimingCaptureNote('Playback paused.');
                    } else if (isLast) {
                        _calWizardAppendTimingCaptureNote(
                            'Playback may still be running — pause when ready.');
                    }
                });
            }, delayMs);
            _calWizardPauseRetryTimers.push(timerId);
        });
    }

    function _calWizardFinishTimedPlayAlong(partial) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong) return;
        if (wiz.playAlong.phase === 'waiting') {
            _calWizardCancelTimedPlayAlongWaiting('Timed play-along cancelled — returned before playback started.');
            return;
        }
        const stashedPlayAlong = { wasPlayingAtArm: wiz.playAlong.wasPlayingAtArm };
        _calWizardStopTimedPlayAlong('finish');
        _calWizardSetTunerMinimized(false);
        wiz.timingCaptureNote = partial
            ? 'Partial window captured — returned early.'
            : `Timed play-along captured (${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s window).`;
        _calWizardCaptureTimingSnapshot();
        if (!partial) _calWizardMaybePauseAfterTimedPlayAlong(stashedPlayAlong);
    }

    function _calWizardStartTimedPlayAlong(durationSec) {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            wiz.timingCaptureNote = 'Turn Detect on first.';
            renderCalibrationWizard();
            return;
        }
        _calWizardStopTimedPlayAlong('restart');
        try { resetCalibrationSamples(); } catch (e) {
            console.warn('[note_detect] resetCalibrationSamples:', e);
        }
        wiz.timing = null;
        wiz.timingCaptureNote = null;
        const sec = Number.isFinite(durationSec) && durationSec > 0
            ? durationSec : _CAL_WIZARD_TIMED_PLAYALONG_SEC;
        const durationMs = sec * 1000;
        const wasPlayingAtArm = _calWizardIsPlaybackActive();
        wiz.playAlong = {
            phase: 'waiting',
            durationSec: sec,
            durationMs,
            waitStartedAt: Date.now(),
            waitTimeoutId: null,
            waitPollId: null,
            onPlayHandler: null,
            playbackSeen: false,
            wasPlayingAtArm,
            endsAt: null,
            timerId: null,
            intervalId: null,
        };
        _calWizardMinimizeForPlayback();
        _calWizardUpdateReturnButtonTimer('waiting');
        const pa = wiz.playAlong;
        if (_calWizardIsPlaybackActive()) {
            _calWizardBeginTimedPlayAlongCountdown();
            return;
        }
        pa.onPlayHandler = () => {
            const w = _calWizardState;
            if (!w || !w.playAlong || w.playAlong.phase !== 'waiting') return;
            w.playAlong.playbackSeen = true;
            _calWizardPollPlayAlongWait();
        };
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            try { window.slopsmith.on('song:play', pa.onPlayHandler); } catch (_) {}
        }
        pa.waitPollId = setInterval(_calWizardPollPlayAlongWait, _CAL_WIZARD_PLAY_ALONG_WAIT_POLL_MS);
        pa.waitTimeoutId = setTimeout(() => {
            const w = _calWizardState;
            if (!w || !w.playAlong || w.playAlong.phase !== 'waiting') return;
            _calWizardCancelTimedPlayAlongWaiting('Timed play-along cancelled — playback did not start.');
        }, _CAL_WIZARD_PLAY_ALONG_WAIT_MS);
    }

    function _calWizardFmtGain(v) {
        return Number.isFinite(v) ? `${(+v).toFixed(2)}x` : '—';
    }

    function _calWizardFmtLatencyMs(v) {
        return Number.isFinite(v) ? `${Math.round(v * 1000)} ms` : '—';
    }

    function _calWizardCompletionHtml(wiz) {
        const applied = wiz.applied;
        const appliedParts = [];
        if (applied && applied.inputGain != null) {
            appliedParts.push(`Input gain ${_calWizardFmtGain(applied.inputGain)} — your hardest playing now peaks near −12 dBFS, so amps stay clean`);
        }
        if (applied && applied.latencyOffset != null) {
            appliedParts.push(`Detection delay ${_calWizardFmtLatencyMs(applied.latencyOffset)}`);
        }
        if (wiz.complete === 'applied') {
            const detailLine = appliedParts.length
                ? appliedParts.join(' · ')
                : 'Checked settings were applied.';
            return `
                <div class="text-center py-3 mb-4 rounded-xl bg-dark-800/90 border border-green-900/40">
                    <p class="text-xl font-bold text-white mb-2">Calibration applied</p>
                    <p class="text-sm text-gray-200 mb-1">You're done. These settings are now active.</p>
                    <p class="text-xs text-gray-400">${detailLine}</p>
                </div>
                <button type="button" class="nd-cal-done w-full py-3 bg-accent hover:bg-accent-light rounded-xl text-base font-bold text-white mb-3 shadow-lg">Done — Close Wizard</button>
                <button type="button" class="nd-cal-run-lab w-full py-2.5 bg-dark-600 hover:bg-dark-500 border border-purple-900/50 rounded-lg text-sm text-gray-300">Run Technique Assessment</button>`;
        }
        return `
            <div class="text-center py-3 mb-4 rounded-xl bg-dark-800/90 border border-gray-600">
                <p class="text-xl font-bold text-white mb-2">Calibration finished</p>
                <p class="text-sm text-gray-200">No recommended settings were applied.</p>
            </div>
            <button type="button" class="nd-cal-done w-full py-3 bg-accent hover:bg-accent-light rounded-xl text-base font-bold text-white mb-3 shadow-lg">Done — Close Wizard</button>
            <button type="button" class="nd-cal-run-lab w-full py-2.5 bg-dark-600 hover:bg-dark-500 border border-purple-900/50 rounded-lg text-sm text-gray-300">Run Technique Assessment</button>`;
    }

    function _calWizardReleaseTuner() {
        try {
            if (window.tuner && typeof window.tuner.disable === 'function') {
                window.tuner.disable();
            }
        } catch (e) {
            console.warn('[note_detect] cal wizard tuner release:', e);
        }
        if (_calWizardState) _calWizardSetTunerMinimized(false);
        if (getEnabled()) {
            try { restartAudio(); } catch (e) {
                console.warn('[note_detect] cal wizard restartAudio after tuner release:', e);
            }
        }
    }

    function _calWizardApplySafeSettings(wiz) {
        const applied = {};
        const rec = wiz.recommended || {};
        if (wiz.applyChecked.inputGain && Number.isFinite(rec.inputGain)) {
            const cG = Math.max(0.1, Math.min(5, rec.inputGain));
            setInputGain(cG);       // writes inputGain + gainNode.gain.value in main.js
            setEngineInputGain(cG); // writes engineInputGain
            applyEngineGain();
            applied.inputGain = cG;
        }
        if (wiz.applyChecked.latencyOffset && Number.isFinite(rec.latencyOffset)) {
            const cL = Math.max(0, Math.min(0.25, rec.latencyOffset));
            setLatencyOffset(cL);
            applied.latencyOffset = cL;
        }
        saveSettings();
        wiz.applied = applied;
        return applied;
    }

    // Public entry: open the Calibration Wizard for a given instrument and get a
    // one-shot completion/cancel callback. Used by the input_setup onboarding
    // wizard (guitar/bass). Thin wrapper over openCalibrationWizard: sets the
    // instrument context, ensures Detect is on (the measurement steps need live
    // input), and reports the outcome. Callbacks are assigned AFTER
    // openCalibrationWizard so its internal pre-close cannot wipe them.
    function launchCalibration(opts) {
        opts = opts || {};
        const onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
        const onCancel = typeof opts.onCancel === 'function' ? opts.onCancel : null;
        const forcedInstrument = (opts.instrument === 'guitar' || opts.instrument === 'bass')
            ? opts.instrument : null;
        if (forcedInstrument) setCurrentArrangement(forcedInstrument);
        const start = () => {
            try {
                openCalibrationWizard();
            } catch (e) {
                if (onCancel) { try { onCancel('error'); } catch (_) { /* isolate */ } }
                return;
            }
            // Open AFTER openCalibrationWizard() — its first act is a pre-close
            // (calibrationWizardClose) that would otherwise drop a ref opened
            // here. Calibration must measure level / channel / latency on the
            // device the user just picked in the wizard's audio-source step, so
            // open the audio-input domain's selected source (ASIO included) — a
            // selection made since enable() is the one being calibrated.
            openInputSource(calRequester, 'calibration');
            _calWizardOnDone = onDone;
            _calWizardOnCancel = onCancel;
            // Set the arrangement override AFTER openCalibrationWizard so its
            // internal pre-close (calibrationWizardClose) can't wipe it — same
            // reason the callbacks above are assigned here. Survives
            // _syncChartStateFromHw's reset-to-guitar on every note-check resolve
            // while no real song chart is loaded (onboarding standalone).
            _calWizardForceArrangement = forcedInstrument;
        };
        // Measurement steps (noise/signal/notes) need Detect ON. Enable first;
        // fail-soft — open the wizard regardless so the caller is never stranded.
        if (!getEnabled()) {
            let p = null;
            try { p = enable(); } catch (_) { p = null; }
            if (p && typeof p.then === 'function') p.then(start, start); else start();
        } else {
            start();
        }
    }

    function _calWizardDeviceLabel() {
        if (!getSelectedDeviceId()) return 'Default system input';
        return `Device ${getSelectedDeviceId().slice(0, 12)}…`;
    }

    function _calWizardEngineChannelLabel(ch) {
        const opt = _CAL_WIZARD_INPUT_CHANNEL_OPTIONS.find((o) => o.ch === ch);
        return opt ? opt.label : `Channel ${ch}`;
    }

    function _calWizardEngineChannelDisplayLabel(ch) {
        if (ch === 0) return 'Left (Ch 1)';
        if (ch === 1) return 'Right (Ch 2)';
        return 'Default / Mono Mix';
    }

    function _calWizardPluginChannelFromEngine(ch) {
        if (ch === 0) return 'left';
        if (ch === 1) return 'right';
        return 'mono';
    }

    function _calWizardSleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function _calWizardWizardAudioApi() {
        if (getUsingDesktopBridge() && getBridgeDesktop() && getBridgeDesktop().audio) return getBridgeDesktop().audio;
        const desktop = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
        return (desktop && desktop.audio) ? desktop.audio : null;
    }

    async function _calWizardSampleEngineLevels(durationMs, intervalMs) {
        const audio = _calWizardWizardAudioApi();
        if (!audio || typeof audio.getLevels !== 'function') {
            return { maxLevel: 0, avgLevel: 0, maxPeak: 0 };
        }
        let maxLevel = 0;
        let maxPeak = 0;
        let levelSum = 0;
        let levelCount = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < durationMs) {
            try {
                const lv = await audio.getLevels();
                if (lv) {
                    const level = Number.isFinite(lv.inputLevel) ? lv.inputLevel : 0;
                    const peak = Number.isFinite(lv.inputPeak) ? lv.inputPeak : 0;
                    maxLevel = Math.max(maxLevel, level);
                    maxPeak = Math.max(maxPeak, peak);
                    levelSum += level;
                    levelCount++;
                }
            } catch (_) { /* read-only */ }
            await _calWizardSleep(intervalMs);
        }
        const avgLevel = levelCount > 0 ? levelSum / levelCount : 0;
        return { maxLevel, avgLevel, maxPeak };
    }

    function _calWizardChannelProbeTrialShortLabel(t) {
        if (!t) return '?';
        if (t.ch === -1) return 'Mono';
        if (t.ch === 0) return 'Ch 1';
        if (t.ch === 1) return 'Ch 2';
        return t.label || '?';
    }

    function _calWizardChannelProbeProgressLabel(ch) {
        if (ch === -1) return 'Mono Mix';
        if (ch === 0) return 'Ch 1';
        if (ch === 1) return 'Ch 2';
        return 'Channel';
    }

    function _calWizardChannelProbeTrialsSummary(trials) {
        if (!trials || !trials.length) return '';
        return trials.map((t) => `${_calWizardChannelProbeTrialShortLabel(t)} ${Math.round((t.maxLevel || 0) * 100)}%`).join(', ');
    }

    function _calWizardLevelsClose(a, b, ratio) {
        const hi = Math.max(a, b);
        if (hi <= 0) return true;
        return Math.abs(a - b) / hi <= ratio;
    }

    function _calWizardTrialByCh(trials, ch) {
        return trials.find((t) => t.ch === ch) || null;
    }

    function _calWizardPickChannelProbeWinner(trials) {
        if (!trials || !trials.length) return null;
        let best = trials[0];
        for (let i = 1; i < trials.length; i++) {
            const t = trials[i];
            if (t.maxLevel > best.maxLevel
                || (t.maxLevel === best.maxLevel && t.avgLevel > best.avgLevel)) {
                best = t;
            }
        }
        const mono = trials.find((t) => t.ch === -1);
        if (!mono || best.ch !== -1) return best;
        let bestSingle = null;
        for (const t of trials) {
            if (t.ch !== 0 && t.ch !== 1) continue;
            if (!bestSingle || t.maxLevel > bestSingle.maxLevel
                || (t.maxLevel === bestSingle.maxLevel && t.avgLevel > bestSingle.avgLevel)) {
                bestSingle = t;
            }
        }
        if (!bestSingle) return best;
        const hi = Math.max(mono.maxLevel, bestSingle.maxLevel);
        if (hi > 0 && Math.abs(mono.maxLevel - bestSingle.maxLevel) / hi <= _CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO) {
            return bestSingle;
        }
        return best;
    }

    function _calWizardAnalyzeChannelProbeTrials(trials) {
        const ratio = _CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO;
        const ch1 = _calWizardTrialByCh(trials, 0);
        const ch2 = _calWizardTrialByCh(trials, 1);
        const best = _calWizardPickChannelProbeWinner(trials);
        const ch1ch2Close = !!(ch1 && ch2
            && _calWizardLevelsClose(ch1.maxLevel, ch2.maxLevel, ratio));
        const ch1usable = !!(ch1 && ch1.maxLevel >= _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK);
        const ch2usable = !!(ch2 && ch2.maxLevel >= _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK);
        const ambiguousCh12 = ch1ch2Close && ch1usable && ch2usable;
        let suggested = ch2;
        let alternate = ch1;
        if (ch1 && ch2) {
            if (ch2.maxLevel > ch1.maxLevel) {
                suggested = ch2;
                alternate = ch1;
            } else if (ch1.maxLevel > ch2.maxLevel) {
                suggested = ch1;
                alternate = ch2;
            } else if (ch2.avgLevel > ch1.avgLevel) {
                suggested = ch2;
                alternate = ch1;
            } else if (ch1.avgLevel > ch2.avgLevel) {
                suggested = ch1;
                alternate = ch2;
            } else {
                // Exact tie — default suggestion to Ch 2 (Spark LIVE guitar path).
                suggested = ch2;
                alternate = ch1;
            }
        }
        return {
            best,
            ch1,
            ch2,
            ch1ch2Close,
            ambiguousCh12,
            suggested,
            alternate,
        };
    }

    async function _calWizardApplyEngineInputChannel(ch) {
        const audio = _calWizardWizardAudioApi();
        if (!audio || typeof audio.setInputChannel !== 'function') return false;
        await audio.setInputChannel(ch);
        if (typeof audio.loadDeviceSettings === 'function'
            && typeof audio.saveDeviceSettings === 'function') {
            try {
                const cur = await audio.loadDeviceSettings();
                const base = (cur && typeof cur === 'object') ? cur : {};
                await audio.saveDeviceSettings({
                    ...base,
                    inputChannel: String(ch),
                    savedAt: Date.now(),
                });
            } catch (e) {
                console.warn('[note_detect] cal wizard saveDeviceSettings:', e);
            }
        }
        setSelectedChannel(_calWizardPluginChannelFromEngine(ch));
        saveSettings();
        return true;
    }

    function _calWizardFormatChannelProbeResult(result) {
        const summary = (result && result.trials) ? _calWizardChannelProbeTrialsSummary(result.trials) : '';
        if (!result || result.ok === false) {
            return `<span class="text-amber-200/90">No strong input detected.</span> Check guitar volume, cable, Spark USB routing, input gain, or try another device.${summary ? `<div class="text-gray-500 mt-1">${summary}</div>` : ''}`;
        }
        if (result.ok === 'ambiguous') {
            const sug = Number.isFinite(result.suggestedCh)
                ? _calWizardEngineChannelDisplayLabel(result.suggestedCh)
                : '—';
            const alt = Number.isFinite(result.alternateCh)
                ? _calWizardEngineChannelDisplayLabel(result.alternateCh)
                : '—';
            return `<span class="text-amber-200/90">Ch 1 and Ch 2 are very close.</span> Suggested: ${sug}, but ${alt} is also usable. Choose the channel that matches your setup.${summary ? `<div class="text-gray-500 mt-1">${summary}</div>` : ''}`;
        }
        const levelPct = Math.round((result.bestLevel || 0) * 100);
        const peakPct = Math.round((result.bestPeak || 0) * 100);
        const disp = Number.isFinite(result.bestCh)
            ? _calWizardEngineChannelDisplayLabel(result.bestCh)
            : (result.bestLabel || '—');
        const peakNote = peakPct > levelPct ? ` (peak ${peakPct}%)` : '';
        return `<span class="text-green-300/90">Best channel: ${disp}, level ${levelPct}%${peakNote}</span>${summary ? `<div class="text-gray-500 mt-1">${summary}</div>` : ''}`;
    }

    async function _calWizardApplyChannelProbeUserPick(ch) {
        const wiz = _calWizardState;
        if (!wiz || !Number.isFinite(ch)) return;
        const applied = await _calWizardApplyEngineInputChannel(ch);
        if (!applied) return;
        const trial = wiz.channelProbeResult && wiz.channelProbeResult.trials
            ? _calWizardTrialByCh(wiz.channelProbeResult.trials, ch)
            : null;
        wiz.channelProbeResult = {
            ok: true,
            userPicked: true,
            bestCh: ch,
            bestLabel: trial ? trial.label : _calWizardEngineChannelLabel(ch),
            bestLevel: trial ? trial.maxLevel : 0,
            bestPeak: trial ? trial.maxPeak : 0,
            trials: wiz.channelProbeResult.trials,
        };
        renderCalibrationWizard();
        _calWizardRefreshLive();
    }

    async function _calWizardAutoDetectInputChannel() {
        const wiz = _calWizardState;
        if (!wiz) return;
        if (wiz.channelProbeRunning) {
            _calWizardSetChannelProbeStatus(
                '<span class="text-amber-200/90">Detection already in progress...</span>');
            return;
        }
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            wiz.channelProbeError = 'Turn Detect on first.';
            renderCalibrationWizard();
            return;
        }
        const audio = _calWizardWizardAudioApi();
        if (!getUsingDesktopBridge() || !audio
            || typeof audio.setInputChannel !== 'function'
            || typeof audio.getLevels !== 'function') {
            wiz.channelProbeError = 'Auto-detect needs the desktop audio engine.';
            renderCalibrationWizard();
            return;
        }
        wiz.channelProbeRunning = true;
        wiz.channelProbeError = null;
        wiz.channelProbeResult = null;
        const token = {};
        wiz.channelProbeAbort = token;
        renderCalibrationWizard();
        const trials = [];
        const probeSteps = _CAL_WIZARD_INPUT_CHANNEL_OPTIONS;
        try {
            for (let i = 0; i < probeSteps.length; i++) {
                const opt = probeSteps[i];
                if (wiz.channelProbeAbort !== token) return;
                const progLabel = _calWizardChannelProbeProgressLabel(opt.ch);
                _calWizardSetChannelProbeStatus(
                    `<span class="text-cyan-300/90">Strum hard…</span> Testing <strong>${progLabel} (${i + 1} of ${probeSteps.length})</strong>…`);
                await audio.setInputChannel(opt.ch);
                if (typeof audio.resetPeaks === 'function') await audio.resetPeaks();
                await _calWizardSleep(_CAL_WIZARD_CHANNEL_PROBE_SETTLE_MS);
                const { maxLevel, avgLevel, maxPeak } = await _calWizardSampleEngineLevels(
                    _CAL_WIZARD_CHANNEL_PROBE_MS,
                    _CAL_WIZARD_CHANNEL_PROBE_INTERVAL_MS,
                );
                if (wiz.channelProbeAbort !== token) return;
                trials.push({ ch: opt.ch, label: opt.label, maxLevel, avgLevel, maxPeak });
            }
            const analysis = _calWizardAnalyzeChannelProbeTrials(trials);
            const { best, ambiguousCh12, suggested, alternate } = analysis;
            const ok = best && best.maxLevel >= _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK;
            if (!ok) {
                wiz.channelProbeResult = {
                    ok: false,
                    trials,
                    bestLevel: best ? best.maxLevel : 0,
                    bestPeak: best ? best.maxPeak : 0,
                };
            } else if (ambiguousCh12) {
                wiz.channelProbeResult = {
                    ok: 'ambiguous',
                    ambiguousCh12: true,
                    suggestedCh: suggested ? suggested.ch : null,
                    alternateCh: alternate ? alternate.ch : null,
                    trials,
                };
            } else {
                await _calWizardApplyEngineInputChannel(best.ch);
                wiz.channelProbeResult = {
                    ok: true,
                    clearWinner: true,
                    bestCh: best.ch,
                    bestLabel: best.label,
                    bestLevel: best.maxLevel,
                    bestPeak: best.maxPeak,
                    trials,
                };
            }
        } catch (e) {
            wiz.channelProbeError = (e && e.message) ? e.message : String(e);
        } finally {
            if (wiz.channelProbeAbort === token) wiz.channelProbeAbort = null;
            wiz.channelProbeRunning = false;
            renderCalibrationWizard();
            _calWizardRefreshLive();
        }
    }

    function getCalibrationSnapshot() {
        let d = null;
        try { d = getDiagCatalog().buildDiagnosticPayload(); } catch (_) { /* read-only */ }
        const hw = resolveHw();
        let avMs = null;
        try { avMs = hw && hw.getAvOffset ? hw.getAvOffset() : null; } catch (_) {}
        const teHits = (d && d.timing_error_ms_hits) ? d.timing_error_ms_hits : {};
        const total = getHits() + getMisses();
        const pitch = _calWizardRawPitchFields();
        const heardNote = pitch.rawNote;
        const heardConfPct = pitch.confidencePct;
        let hearingLine = '—';
        try { hearingLine = ndHealthDetectedLine(); } catch (_) {}
        const sr = getAudioCtx() && getAudioCtx().sampleRate
            ? Math.round(getAudioCtx().sampleRate)
            : (getBridgeSampleRate() ? Math.round(getBridgeSampleRate()) : null);
        return {
            enabled: !!getEnabled(),
            inputLevelPct: Math.round((getInputLevel() || 0) * 100),
            inputPeakPct: Math.round((getInputPeak() || 0) * 100),
            hearingLine,
            heardNote,
            heardConfidencePct: heardConfPct,
            rawHeardNote: pitch.rawNote,
            displayHeardNote: pitch.displayNote,
            rawMidi: pitch.rawMidi,
            channel: pitch.channel,
            source: ndHealthDetectorPathLabel(),
            sampleRateHz: sr,
            avOffsetMs: avMs,
            latencyOffsetMs: Math.round(getLatencyOffset() * 1000),
            timingMedianMs: teHits.median,
            diagnostic: d,
            stats: {
                hits: getHits(),
                misses: getMisses(),
                total,
                accuracy: total > 0 ? Math.round((getHits() / total) * 100) : null,
            },
            method: getDetectionMethod(),
        };
    }

    function calibrationWizardClose() {
        // Capture launchCalibration() callback context before teardown nulls it.
        const _calHadWizard = !!_calWizardEl;
        const _calAppliedResult = (_calWizardState && _calWizardState.applied) || null;
        _calWizardStopAllStringsRun('close');
        _calWizardClearPauseRetries();
        _calWizardStopAutoCapture();
        // Re-assert the calibrated engine input gain on close (the just-applied
        // value, or a prior calibration). The signal step already drops the engine
        // off unity to the measured target right after capture, so a never-calibrated
        // cancel isn't left hot here; this is the backstop for an applied/prior value.
        // No-op when never calibrated (engineInputGain == null).
        applyEngineGain();
        _calWizardStopTimedPlayAlong('close');
        _calWizardReleaseTuner();
        if (_calWizardTick) {
            clearInterval(_calWizardTick);
            _calWizardTick = null;
        }
        if (_calWizardEl) {
            _calWizardEl.remove();
            _calWizardEl = null;
        }
        _calWizardState = null;
        _calWizardForceArrangement = null;
        // Fire the one-shot launchCalibration() callbacks: applied settings →
        // done, otherwise → cancel. Only when a wizard was actually open (so the
        // open-time pre-close is a no-op).
        if (_calHadWizard) {
            // Release the transient calibration input-source ref — ONLY on a real
            // close (a wizard was open). Guarding on _calHadWizard is essential:
            // openCalibrationWizard() calls this as a pre-close BEFORE the new
            // wizard's source is opened, and an unguarded close there would wipe
            // the fresh calibration ref. Live detection (if still getEnabled()) keeps
            // its own ND_AUDIO_REQUESTER ref, so the device stays open for play.
            closeInputSource(calRequester);
            const onDone = _calWizardOnDone;
            const onCancel = _calWizardOnCancel;
            _calWizardOnDone = null;
            _calWizardOnCancel = null;
            if (_calAppliedResult && typeof onDone === 'function') { try { onDone(_calAppliedResult); } catch (_) { /* isolate */ } }
            else if (typeof onCancel === 'function') { try { onCancel('closed'); } catch (_) { /* isolate */ } }
        }
    }

    function _calWizardDetectBanner(snap) {
        if (snap && snap.enabled) return '';
        return '<p class="nd-cal-detect-warn text-amber-200/90 text-xs mb-2">Turn Detect on first for live input and timing checks.</p>';
    }

    function _calWizardRefreshLive() {
        if (!_calWizardEl || !_calWizardState) return;
        const snap = getCalibrationSnapshot();
        const wiz = _calWizardState;
        const live = _calWizardEl.querySelector('.nd-cal-live-level');
        if (live) live.textContent = 'Live: ' + formatLevel(snap.inputLevelPct, snap.inputPeakPct);
        const heard = _calWizardEl.querySelector('.nd-cal-heard');
        if (heard) {
            if (wiz.step === 5) {
                heard.textContent = snap.heardConfidencePct != null
                    ? `Now hearing: ${snap.rawHeardNote ?? snap.heardNote} · ${snap.heardConfidencePct}% confidence`
                    : `Now hearing: nothing yet — play a note · Channel: ${snap.channel || '—'} · Live: `
                    + formatLevel(snap.inputLevelPct, snap.inputPeakPct);
            } else {
                heard.textContent = snap.heardConfidencePct != null
                    ? `Now hearing: ${snap.heardNote} · ${snap.heardConfidencePct}% confidence`
                    : `Now hearing: ${snap.hearingLine === '—' ? 'nothing yet — play a note' : snap.hearingLine}`;
            }
        }
        const debugEl = _calWizardEl.querySelector('.nd-cal-pitch-debug');
        if (debugEl) {
            if (wiz.step === 5) {
                let expectNote = '—';
                if (wiz.autoCapture && wiz.autoCapture.kind === 'note' && wiz.autoCapture.noteId) {
                    const active = _calWizardFindNoteCheckSpec(wiz.autoCapture.noteId);
                    if (active) expectNote = active.expectedNote;
                }
                if (expectNote === '—') {
                    const noteSpecs = _calWizardResolveNoteChecks({ mode: 'quick' });
                    const primary = noteSpecs[0];
                    if (primary) expectNote = primary.expectedNote;
                }
                if (snap.heardConfidencePct != null) {
                    let line = `Expected: ${expectNote} · Heard: ${snap.rawHeardNote ?? '—'}`;
                    if (snap.displayHeardNote && snap.displayHeardNote !== snap.rawHeardNote) {
                        line += ` · Display: ${snap.displayHeardNote}`;
                        const now = Date.now();
                        if (!wiz._lastPitchDbg || now - wiz._lastPitchDbg > 2000) {
                            console.debug('[cal-wizard] pitch', {
                                expected: expectNote,
                                raw: snap.rawHeardNote,
                                display: snap.displayHeardNote,
                                conf: snap.heardConfidencePct,
                                channel: snap.channel,
                            });
                            wiz._lastPitchDbg = now;
                        }
                    }
                    line += ` · Conf: ${snap.heardConfidencePct}% · Channel: ${snap.channel || '—'}`;
                    debugEl.textContent = line;
                    debugEl.classList.remove('hidden');
                } else {
                    debugEl.textContent = `Expected: ${expectNote} · Channel: ${snap.channel || '—'} · Live: `
                        + formatLevel(snap.inputLevelPct, snap.inputPeakPct);
                    debugEl.classList.remove('hidden');
                }
            } else {
                debugEl.textContent = '';
                debugEl.classList.add('hidden');
            }
        }
        if (wiz.step === 5) {
            const rowCells = _calWizardEl.querySelectorAll('.nd-cal-all-row-result');
            if (rowCells.length) {
                const active = _calWizardActiveNoteCapture();
                const byId = {};
                _calWizardResolveNoteChecks({ mode: 'all' }).forEach((s) => { byId[s.id] = s; });
                rowCells.forEach((cell) => {
                    const id = cell.getAttribute('data-note-result');
                    if (active && active.id === id) {
                        cell.className = 'nd-cal-all-row-result text-cyan-300/90 text-[10px] text-right shrink-0';
                        cell.innerHTML = active.phase === 'countdown'
                            ? `Get ready… <strong class="text-white">${active.left}</strong>`
                            : 'Listening…';
                        return;
                    }
                    const spec = byId[id];
                    if (!spec) return;
                    const res = _calWizardNoteResultParts(spec);
                    cell.className = `nd-cal-all-row-result ${res.cls} text-[10px] text-right shrink-0`;
                    cell.textContent = res.txt;
                });
            }
        }
        const medEl = _calWizardEl.querySelector('.nd-cal-timing-median');
        if (medEl) {
            const t = wiz.timing;
            const m = t && Number.isFinite(t.medianMs) ? t.medianMs : snap.timingMedianMs;
            const n = t && t.sampleCount ? t.sampleCount : 0;
            medEl.textContent = Number.isFinite(m)
                ? `Your average timing vs chart: ${ndFormatMs(m)} · ${n} hit samples`
                : `Your average timing vs chart: not enough getHits() yet (${n} samples)`;
        }
    }

    function _calWizardReviewChanges(wiz) {
        const rec = wiz.recommended || {};
        const changes = [];
        const consider = (key, label, curVal, recVal, fmt, reason) => {
            if (!Number.isFinite(recVal)) return;
            if (Number.isFinite(curVal) && Math.abs(recVal - curVal) < 0.004) return;
            changes.push({ key, label, curVal, recVal, fmt, reason: reason || '' });
        };
        consider('inputGain', 'Input gain', getInputGain(), rec.inputGain,
            _calWizardFmtGain, rec.reasons && rec.reasons.inputGain);
        consider('getLatencyOffset()', 'Detection delay', getLatencyOffset(), rec.latencyOffset,
            _calWizardFmtLatencyMs, rec.reasons && rec.reasons.latencyOffset);
        return changes;
    }

    function _calWizardReviewSummaryHtml(wiz, opts = {}) {
        const showCheckboxes = opts.showCheckboxes !== false;
        const onlyChecked = !!opts.onlyChecked;
        const changes = _calWizardReviewChanges(wiz);
        const visible = onlyChecked
            ? changes.filter((c) => wiz.applyChecked[c.key] !== false)
            : changes;
        if (!visible.length) {
            if (onlyChecked && changes.length) {
                return '<p class="text-sm text-gray-300 mb-3">No settings are selected to apply. Go back to Review to check items, or finish without applying.</p>';
            }
            return '<p class="text-sm text-gray-300 mb-3">No safe setting changes recommended — you can finish without applying.</p>';
        }
        const cards = visible.map((c) => {
            const checked = wiz.applyChecked[c.key] !== false ? 'checked' : '';
            const chk = showCheckboxes
                ? `<input type="checkbox" class="nd-cal-apply-chk accent-green-400 mt-0.5 shrink-0" data-key="${c.key}" ${checked}>`
                : '';
            return `<div class="flex items-start gap-3 p-3 rounded-lg bg-dark-800/90 border border-gray-600">
                ${chk}
                <div class="min-w-0 flex-1">
                    <div class="text-sm font-medium text-gray-100">${c.label}</div>
                    <div class="text-sm text-gray-300 mt-1">${c.fmt(c.curVal)} → <span class="text-green-300 font-mono font-medium">${c.fmt(c.recVal)}</span></div>
                </div>
            </div>`;
        }).join('');
        return `<div class="space-y-2 mb-3">${cards}</div>`;
    }

    function _calWizardReviewDetailsHtml(wiz) {
        const changes = _calWizardReviewChanges(wiz);
        if (!changes.length) return '';
        const rows = changes.map((c) => {
            const checked = wiz.applyChecked[c.key] !== false ? 'checked' : '';
            return `<tr class="border-b border-gray-700/50">
                <td class="py-1.5 pr-2 text-gray-300">${c.label}</td>
                <td class="py-1.5 text-gray-400 font-mono">${c.fmt(c.curVal)}</td>
                <td class="py-1.5 text-green-300/90 font-mono">${c.fmt(c.recVal)}</td>
                <td class="py-1.5 text-xs text-gray-400">${c.reason}</td>
                <td class="py-1.5"><input type="checkbox" class="nd-cal-apply-chk accent-green-400" data-key="${c.key}" ${checked}></td></tr>`;
        }).join('');
        return `<details class="mb-3">
            <summary class="text-sm text-gray-400 cursor-pointer hover:text-gray-200 py-1 select-none">Show technical details</summary>
            <table class="w-full text-xs mt-2"><thead><tr class="text-gray-500 text-left">
                <th class="py-1 pr-1">Setting</th><th class="pr-1">Current</th><th class="pr-1">Recommended</th><th class="pr-1">Reason</th><th>Apply</th>
            </tr></thead><tbody>${rows}</tbody></table>
        </details>`;
    }

    function renderCalibrationWizard() {
        if (!_calWizardEl || !_calWizardState) return;
        const body = _calWizardEl.querySelector('.nd-cal-body');
        const title = _calWizardEl.querySelector('.nd-cal-title');
        const backBtn = _calWizardEl.querySelector('.nd-cal-back');
        const nextBtn = _calWizardEl.querySelector('.nd-cal-next');
        if (!body || !title) return;
        const step = _calWizardState.step;
        const snap = getCalibrationSnapshot();
        const wiz = _calWizardState;
        const meta = _CAL_WIZARD_STEPS[step] || { title: 'Step' };
        title.textContent = `Calibration Wizard — ${meta.title}`;
        if (backBtn) backBtn.style.visibility = step > 0 && step < 8 ? 'visible' : 'hidden';
        if (nextBtn) {
            if (step >= 8) {
                nextBtn.style.display = 'none';
            } else {
                nextBtn.style.display = '';
                nextBtn.textContent = step === 7 ? 'Continue to Apply' : 'Next';
            }
        }
        if (step === 7) _calWizardBuildSafeRecommendations(wiz, snap);

        let html = '';
        if (step === 0) {
            html = `
                <p class="text-gray-300 text-xs mb-2"><strong class="text-gray-200">Calibration Wizard</strong> sets up your audio input, levels, and timing.</p>
                <p class="text-gray-300 text-xs mb-2"><strong class="text-gray-200">Technique Assessment</strong> (separate tool) checks how well specific playing techniques verify — bends, harmonics, palm mutes, and more.</p>
                <p class="text-gray-400 text-[10px] mb-2">This wizard may recommend <strong>input gain</strong> and <strong>detection delay (latency offset)</strong> only. It does not change scoring strictness, pitch windows, or detection thresholds.</p>
                <p class="text-gray-400 text-[10px]">Tip: turn <strong>Detect</strong> on before starting step 1.</p>`;
        } else if (step === 1) {
            const engineOk = snap.enabled && (getUsingDesktopBridge() || getAudioCtx());
            const probeBusy = wiz.channelProbeRunning;
            const probeAmbiguous = wiz.channelProbeResult && wiz.channelProbeResult.ok === 'ambiguous';
            const probePickHtml = probeAmbiguous
                ? `<div class="flex flex-col gap-1 mt-2">
                    <button type="button" class="nd-cal-pick-channel w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200" data-ch="0">Ch 1 — Dry / Clean</button>
                    <button type="button" class="nd-cal-pick-channel w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200" data-ch="1">Ch 2 — Wet / FX</button>
                   </div>`
                : '';
            const probeResultBoxClass = 'nd-cal-channel-probe-result text-[11px] mt-2 p-2 rounded-lg border border-gray-600 bg-dark-800/90';
            const probeResultHtml = wiz.channelProbeResult
                ? `<div class="${probeResultBoxClass}">${_calWizardFormatChannelProbeResult(wiz.channelProbeResult)}${probePickHtml}</div>`
                : (wiz.channelProbeError
                    ? `<div class="${probeResultBoxClass} text-amber-200/90">${ndEscapeHtml(wiz.channelProbeError)}</div>`
                    : '');
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Confirm which input channel Slopsmith is listening to. Strum while auto-detect runs.</p>
                <div class="text-[11px] text-gray-300 font-mono space-y-1 mb-2">
                    <div>Device: ${_calWizardDeviceLabel()}</div>
                    <div>Channel: ${snap.channel || '—'}</div>
                    <div>Detector: ${snap.source || '—'}</div>
                    <div>Engine: ${engineOk ? 'Running' : 'Not ready — enable Detect'}</div>
                </div>
                <div class="nd-cal-live-level text-cyan-300/90 text-xs font-mono mb-2">Live: —</div>
                <button type="button" class="nd-cal-auto-channel w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2${probeBusy ? ' opacity-60 cursor-not-allowed' : ''}"${probeBusy ? ' disabled' : ''}>${probeBusy ? 'Detecting...' : 'Auto-detect Channel'}</button>
                <div class="nd-cal-channel-probe-status text-[11px] text-gray-400 mb-2 min-h-[1.5rem]">${probeBusy
                    ? '<span class="text-cyan-300/90">Testing Mono Mix (1 of 3)…</span>'
                    : 'Tests Mono Mix, Ch 1 (dry), and Ch 2 (wet) on the desktop audio engine.'}</div>
                ${probeResultHtml}
                <p class="text-[10px] text-gray-500 mb-1"><strong class="text-gray-400">Desktop:</strong> this step sets the native audio engine channel (saved automatically when a winner is found).</p>
                <p class="text-[10px] text-gray-500">The <strong>Input Channel</strong> dropdown below only applies to browser microphone fallback — not desktop audio.</p>
                <p class="text-[10px] text-amber-200/80">If stuck: check USB cable, interface gain, turn Detect on, and strum loudly during the test.</p>`;
        } else if (step === 2) {
            html = `
                <p class="text-gray-300 text-xs mb-2">Tune your guitar using the bottom <strong class="text-gray-200">Tuner</strong> panel.</p>
                <p class="text-[10px] text-gray-500 mb-2">The tuner opens automatically and hides this wizard. Tap <strong>Return to Calibration Wizard</strong> when done — or use <strong>Open Tuner</strong> below to reopen it.</p>
                <p class="text-[10px] text-amber-200/80">If notes miss often later: retune here before continuing.</p>
                <button type="button" class="nd-cal-open-tuner w-full mb-2 py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200">Open Tuner</button>
                <div class="nd-cal-tuner-open-status text-[11px] mb-2 min-h-[1.5rem]"></div>
                <button type="button" class="nd-cal-tuned w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white">I'm Tuned — Continue</button>`;
        } else if (step === 3) {
            const nDone = wiz.noise && wiz.noise.captured;
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Mute all strings and rest your hands on the strings. The wizard listens automatically after a short countdown.</p>
                <div class="nd-cal-live-level text-cyan-300/90 text-xs font-mono mb-2">Live: —</div>
                <div class="nd-cal-auto-status text-[11px] text-gray-400 mb-2 h-[2.75rem] overflow-y-auto">${nDone
                    ? `Captured: avg ${wiz.noise.avgPct}% · peak ${wiz.noise.peakPct}% · ${_calWizardNoiseStatusDisplay(wiz.noise.status)}`
                    : 'Ready to measure room noise.'}</div>
                <button type="button" class="nd-cal-start-noise w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-1">${nDone ? 'Retry Noise Capture' : 'Start Noise Capture'}</button>
                <p class="text-[10px] text-gray-500">If <strong>Too noisy</strong>: lower input gain, move away from amps/fans, or try the dry (Ch 1) input.</p>`;
        } else if (step === 4) {
            const sDone = wiz.signal && wiz.signal.captured;
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Play your <strong class="text-gray-200">open low E</strong> at normal playing volume when prompted. Listening starts after the countdown.</p>
                <div class="nd-cal-live-level text-cyan-300/90 text-xs font-mono mb-2">Live: —</div>
                <div class="nd-cal-auto-status text-[11px] text-gray-400 mb-2 h-[2.75rem] overflow-y-auto">${sDone
                    ? `Captured: avg ${wiz.signal.avgPct}% · peak ${wiz.signal.peakPct}% · ${_calWizardSignalStatusDisplay(wiz.signal.status)}`
                    : 'Ready to measure your playing level.'}</div>
                <button type="button" class="nd-cal-start-signal w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-1">${sDone ? 'Retry Signal Capture' : 'Start Signal Capture'}</button>
                <p class="text-[10px] text-gray-500">If <strong>Too low</strong>: raise interface gain or play closer to the mic/DI. If <strong>Too hot</strong>: lower gain to avoid clipping.</p>`;
        } else if (step === 5) {
            const noteSpecs = _calWizardResolveNoteChecks({ mode: 'quick' });
            // Standalone (no song): let the player pick their instrument so the
            // open-string targets cover 5/6-string bass and 7/8-string guitar.
            const _calCtx = _calWizardResolveNoteCheckContext();
            const _instrOpts = _CAL_WIZARD_INSTRUMENT_CONFIGS.map((c) =>
                `<option value="${c.id}"${wiz.selectedInstrumentConfig === c.id ? ' selected' : ''}>${c.label}</option>`
            ).join('');
            const instrumentPickerHtml = _calCtx.hasTuning ? '' : `
                <div class="nd-cal-instrument-picker mb-2 p-2 bg-dark-700 rounded-lg border border-gray-700">
                    <label class="block text-[11px] text-gray-300 mb-1">Your instrument <span class="text-gray-500">(no song loaded)</span></label>
                    <select class="nd-cal-instrument-config w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200">
                        <option value="">— Auto (6-string guitar) —</option>
                        ${_instrOpts}
                    </select>
                    <p class="text-[9px] text-gray-500 mt-1">Pick a 4/5/6-string bass or 6/7/8-string guitar so the open-string targets match your instrument.</p>
                </div>`;
            const allStr = wiz.allStrings || _calWizardDefaultAllStringsState();
            const allRunning = !!allStr.running;
            const detailsOpen = !!(allStr.detailsOpen || allStr.running || allStr.complete || allStr.failedId);
            const noteRowHtml = (spec, compact) => {
                const res = _calWizardNoteResultParts(spec);
                const labelCls = compact ? 'text-[10px]' : 'text-xs';
                return `<div class="flex justify-between py-1 border-b border-gray-700/50 gap-2">
                    <span class="text-gray-300 ${labelCls}">${spec.label}</span>
                    <span class="${res.cls} text-[10px] text-right shrink-0">${res.txt}</span></div>`;
            };
            const noteRows = noteSpecs.map((spec) => noteRowHtml(spec, false)).join('');
            const noteButtons = noteSpecs.map((spec) =>
                `<button type="button" class="nd-cal-check-note w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-1" data-note="${spec.id}">Check ${spec.label}</button>`
            ).join('');
            const allBtnDisabled = allRunning ? ' disabled' : '';
            const allBtnDisabledCls = allRunning ? ' opacity-50 cursor-not-allowed' : '';
            // Per-string manual checks: skip the strings the quick Open low / Open
            // 2nd checks above already cover — they were redundant (tester
            // feedback). Each remaining string is one compact row: Check button +
            // label + an inline result/countdown cell so the status is never
            // scrolled off the bottom (kept live by _calWizardRefreshLive). Run-All
            // sweeps this same set, so every run target has a visible row.
            const advancedSpecs = _calWizardResolveAdvancedStringChecks();
            const active = _calWizardActiveNoteCapture();
            const allRows = advancedSpecs.map((spec) => {
                let res;
                if (active && active.id === spec.id) {
                    res = active.phase === 'countdown'
                        ? { cls: 'text-cyan-300/90', txt: `Get ready… ${active.left}` }
                        : { cls: 'text-cyan-300/90', txt: 'Listening…' };
                } else {
                    res = _calWizardNoteResultParts(spec);
                }
                return `<div class="flex items-center gap-2 py-1 border-b border-gray-700/50">
                    <button type="button" class="nd-cal-check-note-all shrink-0 px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded text-[10px] text-gray-200${allBtnDisabledCls}" data-note="${spec.id}"${allBtnDisabled}>Check</button>
                    <span class="text-gray-300 text-[10px] flex-1 min-w-0">${spec.label}</span>
                    <span class="nd-cal-all-row-result ${res.cls} text-[10px] text-right shrink-0" data-note-result="${spec.id}">${res.txt}</span>
                </div>`;
            }).join('');
            let seqStatusHtml = '';
            if (allStr.message) {
                const seqCls = allStr.complete
                    ? 'text-green-300/90'
                    : allStr.failedId
                        ? 'text-amber-200/90'
                        : 'text-cyan-300/90';
                seqStatusHtml = `<p class="text-[10px] ${seqCls} mb-2">${allStr.message}</p>`;
            }
            const runBtnLabel = allRunning ? 'Checking…' : 'Check All Remaining Strings';
            const runBtnDisabled = allRunning ? ' disabled' : '';
            const runBtnCls = allRunning ? ' opacity-60 cursor-not-allowed' : '';
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Quick check that Slopsmith hears open strings. This is simpler than Technique Assessment — just confirms basic detection works.</p>
                <p class="text-[10px] text-gray-500 mb-2">Targets match the current song tuning. Use the same tone and pitch-shift path you will play the song with.</p>
                <p class="text-[10px] text-gray-500 mb-2">Load a song first for song tuning in the tuner.</p>
                ${instrumentPickerHtml}
                <div class="nd-cal-heard text-cyan-300/90 text-[10px] font-mono mb-2 h-[2rem] overflow-y-auto">Now hearing: —</div>
                <div class="nd-cal-pitch-debug text-[9px] text-gray-500 font-mono mb-1 hidden"></div>
                <div class="nd-cal-auto-status text-[11px] text-gray-400 mb-2 h-[2.75rem] overflow-y-auto">—</div>
                <div class="mb-2">${noteRows}</div>
                ${noteButtons}
                <details class="nd-cal-all-strings mt-3 mb-2"${detailsOpen ? ' open' : ''}>
                    <summary class="text-sm text-gray-400 cursor-pointer hover:text-gray-200 py-1 select-none">Check remaining strings (advanced)</summary>
                    <p class="text-[10px] text-gray-500 mt-2 mb-2">Optional — verify the remaining open strings against song tuning. The two lowest are covered by the Open low / Open 2nd checks above. Not required to continue.</p>
                    <button type="button" class="nd-cal-run-all-strings w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2${runBtnCls}"${runBtnDisabled}>${runBtnLabel}</button>
                    ${seqStatusHtml}
                    <div class="mb-2">${allRows}</div>
                </details>
                <p class="text-[10px] text-gray-500">If a check fails: retune, confirm the right input channel, raise gain slightly, and try the other channel (dry vs wet).</p>`;
        } else if (step === 6) {
            const t = wiz.timing;
            const liveMed = snap.timingMedianMs;
            const liveN = (snap.diagnostic && snap.diagnostic.timing_error_ms_hits)
                ? snap.diagnostic.timing_error_ms_hits.count : 0;
            const playAlongBusy = !!(wiz.playAlong);
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2"><strong class="text-gray-200">Play part of a song</strong> with Detect on so getHits() are scored. Tap <strong>Minimize Wizard — Play Song</strong> to reach the song highway (then <strong>Return to Calibration Wizard</strong> to come back), or <strong>Start Timed Play-Along Test</strong> for a clean ${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s sample window.</p>
                <p class="text-[10px] text-gray-500 mb-2">Use the speed you normally practice. This measures input vs chart alignment, not tempo.</p>
                <div class="nd-cal-timing-median text-gray-300 text-xs mb-2">Your average timing vs chart: —</div>
                <p class="text-[10px] text-gray-500 mb-2">Live session: ${Number.isFinite(liveMed) ? ndFormatMs(liveMed) + ' average' : 'not enough getHits() yet'} · ${liveN} hit samples</p>
                <p class="text-[10px] text-gray-500 mb-2"><strong class="text-gray-400">Chart/video offset</strong> (main Settings) moves notes on screen. <strong class="text-gray-400">Detection delay</strong> (latency offset) moves when your playing is judged — this step helps tune detection delay.</p>
                <p class="text-[10px] text-amber-200/80">Mostly late? Detection delay may need increasing. Mostly early? Try lowering it.</p>
                ${wiz.timingCaptureNote ? `<p class="text-[10px] text-cyan-300/90 mb-2">${wiz.timingCaptureNote}</p>` : ''}
                <button type="button" class="nd-cal-start-playalong w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2${playAlongBusy ? ' opacity-60 cursor-not-allowed' : ''}"${playAlongBusy ? ' disabled' : ''}>Start Timed Play-Along Test (${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s)</button>
                <button type="button" class="nd-cal-minimize-play w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Minimize Wizard — Play Song</button>
                <button type="button" class="nd-cal-reset-timing w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Reset Timing Samples</button>
                <button type="button" class="nd-cal-capture-timing w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-1">Capture Timing Snapshot</button>
                ${t && t.captured ? `<p class="text-[10px] text-green-300/90">Stored: ${ndFormatMs(t.medianMs)} · ${t.sampleCount} samples</p>` : ''}`;
        } else if (step === 7) {
            html = `
                <p class="text-sm text-gray-200 mb-3">Review safe recommendations. Uncheck anything you do not want applied.</p>
                ${_calWizardReviewSummaryHtml(wiz, { showCheckboxes: true })}
                ${_calWizardReviewDetailsHtml(wiz)}
                <p class="text-xs text-gray-500 mt-2"><strong class="text-gray-400">Never changed by this wizard:</strong> pitch tolerance, timing tolerance, chord leniency, clean timing/pitch thresholds, harmonic SNR, note verifier / scoring thresholds</p>`;
        } else if (step === 8) {
            if (wiz.complete) {
                html = _calWizardCompletionHtml(wiz);
            } else {
                html = `
                <p class="text-base font-medium text-gray-100 mb-3">Ready to apply recommended calibration settings.</p>
                ${_calWizardReviewSummaryHtml(wiz, { showCheckboxes: false, onlyChecked: true })}
                <p class="text-sm text-gray-400 mb-4">Apply updates input gain and/or detection delay only. Scoring strictness and detection thresholds are not changed.</p>
                <button type="button" class="nd-cal-apply-safe w-full py-3 bg-accent hover:bg-accent-light rounded-xl text-sm font-bold text-white mb-3 shadow-lg">Apply Recommended Settings</button>
                <button type="button" class="nd-cal-finish-no-apply w-full py-2.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-sm text-gray-300">Finish Without Applying</button>`;
            }
        }
        body.innerHTML = html;

        const openTuner = body.querySelector('.nd-cal-open-tuner');
        if (openTuner) {
            openTuner.onclick = () => { _calWizardOpenTunerFromWizard(); };
        }
        const tunedBtn = body.querySelector('.nd-cal-tuned');
        if (tunedBtn) {
            tunedBtn.onclick = () => {
                _calWizardReleaseTuner();
                calibrationWizardNext();
            };
        }

        const startNoise = body.querySelector('.nd-cal-start-noise');
        if (startNoise) startNoise.onclick = () => _calWizardStartNoiseCapture();

        const startSignal = body.querySelector('.nd-cal-start-signal');
        if (startSignal) startSignal.onclick = () => _calWizardStartSignalCapture();

        const autoChannel = body.querySelector('.nd-cal-auto-channel');
        if (autoChannel) {
            autoChannel.onclick = () => {
                if (_calWizardState && _calWizardState.channelProbeRunning) {
                    _calWizardSetChannelProbeStatus(
                        '<span class="text-amber-200/90">Detection already in progress...</span>');
                    return;
                }
                _calWizardAutoDetectInputChannel();
            };
        }

        body.querySelectorAll('.nd-cal-pick-channel').forEach((btn) => {
            btn.onclick = () => {
                const ch = parseInt(btn.getAttribute('data-ch'), 10);
                if (Number.isFinite(ch)) _calWizardApplyChannelProbeUserPick(ch);
            };
        });

        body.querySelectorAll('.nd-cal-check-note').forEach((btn) => {
            btn.onclick = () => {
                const id = btn.getAttribute('data-note');
                if (id) _calWizardStartNoteCapture(id);
            };
        });

        body.querySelectorAll('.nd-cal-check-note-all').forEach((btn) => {
            btn.onclick = () => {
                if (_calWizardState && _calWizardState.allStrings && _calWizardState.allStrings.running) return;
                const id = btn.getAttribute('data-note');
                if (id) _calWizardStartNoteCapture(id);
            };
        });

        const runAllStrings = body.querySelector('.nd-cal-run-all-strings');
        if (runAllStrings) {
            runAllStrings.onclick = () => {
                if (_calWizardState && _calWizardState.allStrings && _calWizardState.allStrings.running) return;
                _calWizardStartAllStringsRun();
            };
        }

        const instrSelect = body.querySelector('.nd-cal-instrument-config');
        if (instrSelect) {
            instrSelect.onchange = () => {
                if (_calWizardState) {
                    // Stop any in-flight all-strings run / countdown / auto-capture
                    // first — otherwise it can land a result for the OLD instrument
                    // into the freshly reset state after the switch.
                    _calWizardStopAllStringsRun('switch');
                    _calWizardStopAutoCapture();
                    _calWizardState.selectedInstrumentConfig = instrSelect.value || null;
                    // Expected open-string notes change with the instrument, so
                    // drop stale per-string + quick-check results.
                    _calWizardState.allStrings = _calWizardDefaultAllStringsState();
                    _calWizardState.notes = {};
                }
                renderCalibrationWizard();
            };
        }

        const resetTiming = body.querySelector('.nd-cal-reset-timing');
        if (resetTiming) {
            resetTiming.onclick = () => {
                _calWizardStopTimedPlayAlong('reset');
                try { resetCalibrationSamples(); } catch (e) { console.warn('[note_detect] resetCalibrationSamples:', e); }
                wiz.timing = null;
                wiz.timingCaptureNote = null;
                _calWizardRefreshLive();
                renderCalibrationWizard();
            };
        }
        const capTiming = body.querySelector('.nd-cal-capture-timing');
        if (capTiming) {
            capTiming.onclick = () => {
                wiz.timingCaptureNote = null;
                _calWizardCaptureTimingSnapshot();
            };
        }

        const startPlayAlong = body.querySelector('.nd-cal-start-playalong');
        if (startPlayAlong) {
            startPlayAlong.onclick = () => _calWizardStartTimedPlayAlong(_CAL_WIZARD_TIMED_PLAYALONG_SEC);
        }

        const minimizePlay = body.querySelector('.nd-cal-minimize-play');
        if (minimizePlay) {
            minimizePlay.onclick = () => {
                _calWizardStopTimedPlayAlong('manual-minimize');
                _calWizardMinimizeForPlayback();
            };
        }

        body.querySelectorAll('.nd-cal-apply-chk').forEach((chk) => {
            chk.onchange = () => {
                const key = chk.getAttribute('data-key');
                if (key) wiz.applyChecked[key] = chk.checked;
            };
        });

        const applyBtn = body.querySelector('.nd-cal-apply-safe');
        if (applyBtn) {
            applyBtn.onclick = () => {
                _calWizardApplySafeSettings(wiz);
                wiz.complete = 'applied';
                renderCalibrationWizard();
            };
        }
        const finishNo = body.querySelector('.nd-cal-finish-no-apply');
        if (finishNo) {
            finishNo.onclick = () => {
                wiz.complete = 'finished';
                wiz.applied = null;
                renderCalibrationWizard();
            };
        }

        const doneBtn = body.querySelector('.nd-cal-done');
        if (doneBtn) doneBtn.onclick = () => calibrationWizardClose();

        const runLabBtn = body.querySelector('.nd-cal-run-lab');
        if (runLabBtn) {
            runLabBtn.onclick = () => {
                calibrationWizardClose();
                try { openCalibrationLab(); } catch (e) {
                    console.warn('[note_detect] openInstrumentCalibrationLab:', e);
                }
            };
        }

        if (step >= 1 && step <= 6) _calWizardRefreshLive();

        // One-shot, per-step-entry reveal of the surface that lives *behind*
        // this modal (tester feedback: clicking the Tuner panel did nothing
        // because the wizard overlay covers it). On entering the Tuner step,
        // open the tuner (it minimizes the wizard). The guard is set BEFORE
        // firing so the re-render this triggers can't recurse, and a step that
        // didn't change (e.g. returning from the tuner) never re-fires.
        //
        // The Timing step does NOT auto-minimize: a later tester reported the
        // step "does not load" because the card vanished the instant they
        // reached it. The step keeps explicit "Minimize Wizard — Play Song" and
        // "Start Timed Play-Along Test" buttons (both minimize on click) so the
        // highway is still reachable on demand.
        const enteredStep = wiz._autoEnterStep !== step;
        wiz._autoEnterStep = step;
        if (enteredStep && !wiz.complete && !wiz.tunerMinimized) {
            if (step === 2) {
                _calWizardOpenTunerFromWizard();
            }
        }
    }

    function calibrationWizardNext() {
        if (!_calWizardState) return;
        _calWizardStopAllStringsRun('next');
        _calWizardStopAutoCapture();
        if (_calWizardState.step === 2) {
            _calWizardReleaseTuner();
        } else if (_calWizardState.tunerMinimized) {
            _calWizardSetTunerMinimized(false);
        }
        if (_calWizardState.step >= 8) return;
        _calWizardState.step++;
        renderCalibrationWizard();
    }

    function calibrationWizardBack() {
        if (!_calWizardState || _calWizardState.step <= 0) return;
        _calWizardStopAllStringsRun('back');
        _calWizardStopAutoCapture();
        if (_calWizardState.tunerMinimized) _calWizardSetTunerMinimized(false);
        _calWizardState.step--;
        renderCalibrationWizard();
    }

    function openCalibrationWizard() {
        calibrationWizardClose();
        _calWizardState = _calWizardNewState();
        const overlay = document.createElement('div');
        overlay.className = 'nd-cal-wizard';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);pointer-events:auto;';
        overlay.innerHTML = `
            <button type="button" class="nd-cal-return-wizard bg-accent hover:bg-accent-light text-white shadow-2xl border-2 border-white/25" style="display:none;pointer-events:auto;position:fixed;left:50%;transform:translateX(-50%);bottom:120px;z-index:301;padding:16px 32px;border-radius:16px;max-width:calc(100vw - 2rem);text-align:center;cursor:pointer;">
                <span class="nd-cal-return-primary block text-sm font-bold leading-tight">Return to Calibration Wizard</span>
                <span class="nd-cal-return-secondary block text-[11px] font-normal opacity-90 mt-1">Tap here to continue setup</span>
            </button>
            <div class="nd-cal-wizard-card bg-dark-700 border border-gray-600 rounded-2xl shadow-2xl text-sm" style="width:24rem;max-width:calc(100vw - 2rem);max-height:calc(100vh - 3rem);display:flex;flex-direction:column;">
                <div class="flex justify-between items-center px-4 py-3 border-b border-gray-700">
                    <span class="nd-cal-title text-gray-200 font-semibold text-xs">Calibration Wizard</span>
                    <button type="button" class="nd-cal-close text-gray-500 hover:text-white text-lg leading-none" title="Close">&times;</button>
                </div>
                <div class="nd-cal-body px-4 py-3 overflow-y-auto flex-1 text-xs"></div>
                <div class="flex gap-2 px-4 py-3 border-t border-gray-700">
                    <button type="button" class="nd-cal-back flex-1 py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300">Back</button>
                    <button type="button" class="nd-cal-next flex-1 py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white">Next</button>
                </div>
            </div>`;
        overlay.onclick = (e) => { if (e.target === overlay) calibrationWizardClose(); };
        overlay.querySelector('.nd-cal-close').onclick = () => calibrationWizardClose();
        overlay.querySelector('.nd-cal-back').onclick = () => calibrationWizardBack();
        overlay.querySelector('.nd-cal-next').onclick = () => calibrationWizardNext();
        const ret = overlay.querySelector('.nd-cal-return-wizard');
        if (ret) {
            ret.onclick = () => {
                if (_calWizardState && _calWizardState.playAlong) {
                    if (_calWizardState.playAlong.phase === 'waiting') {
                        _calWizardCancelTimedPlayAlongWaiting(
                            'Timed play-along cancelled — returned before playback started.');
                        return;
                    }
                    _calWizardFinishTimedPlayAlong(true);
                    return;
                }
                _calWizardSetTunerMinimized(false);
                _calWizardRefreshLive();
            };
        }
        document.body.appendChild(overlay);
        _calWizardEl = overlay;
        renderCalibrationWizard();
        _calWizardTick = setInterval(() => {
            if (!_calWizardEl || !_calWizardEl.isConnected) {
                calibrationWizardClose();
                return;
            }
            if (_calWizardState && !_calWizardState.tunerMinimized
                && _calWizardState.step >= 1 && _calWizardState.step <= 6) {
                _calWizardRefreshLive();
            }
        }, 200);
    }

    return {
        openCalibrationWizard,
        calibrationWizardClose,
        calibrationWizardNext,
        calibrationWizardBack,
        getCalibrationSnapshot,
        launchCalibration,
    };
}
