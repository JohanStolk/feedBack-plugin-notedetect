// Technique Assessment subsystem (nd-carve-9 cut 9).
// Extracted from createNoteDetector() in main.js.
//
// Read-only guided probes via scoreChord harmonicVerify for diagnosing
// input channel, gain, tuning, and picking technique. Does NOT change
// thresholds, scoring, latency, or apply settings. Formerly called
// Instrument Calibration Lab (_calLab*).

/* global window, document, setTimeout, clearTimeout, setInterval, clearInterval, URL, fetch */

// ── createTechniqueAssessment ─────────────────────────────────────────────────
// DI params — all mutable factory deps are live accessors (never captured raw
// at construction time per the LIVE-ACCESSOR RULE).
//
//   Live accessors (mutable, read at call time):
//     getUsingDesktopBridge, getDetectionMethod, getSelectedChannel,
//     getInputGain, getCurrentArrangement, getCurrentStringCount,
//     getTuningOffsets, getLatencyOffset, getEnabled,
//     getNdUsingEngineVerifier, getCapo,
//     getPitchTolerance, getTimingTolerance, getChordHitRatio
//
//   Stable values / function refs (safe to capture at construction):
//     diagCatalog           — factory-level const object, never reassigned
//     ndBridgeScoreAvailable — factory-level function ref, never reassigned
//     ndBridgeScoreChord    — factory-level function ref, never reassigned
//     ndMidiFromStringFret  — factory-level function ref, never reassigned
//     ndMidiToName          — factory-level function ref, never reassigned
//     calibrationFormatLevel — factory-level function ref, never reassigned
//     getCalibrationSnapshot — factory-level function ref, never reassigned
//
export function createTechniqueAssessment({
    getUsingDesktopBridge,
    getDetectionMethod,
    getSelectedChannel,
    getInputGain,
    getCurrentArrangement,
    getCurrentStringCount,
    getTuningOffsets,
    getLatencyOffset,
    getEnabled,
    getNdUsingEngineVerifier,
    getCapo,
    getPitchTolerance,
    getTimingTolerance,
    getChordHitRatio,
    diagCatalog,
    ndBridgeScoreAvailable,
    ndBridgeScoreChord,
    ndMidiFromStringFret,
    ndMidiToName,
    calibrationFormatLevel,
    getCalibrationSnapshot,
}) {

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
        // the SAME live tuning the Lab scores against (getCurrentArrangement() /
        // getCurrentStringCount() / getTuningOffsets() / capo), so the named chord always
        // matches what's actually tested (standard guitar → E5; honors a loaded
        // song's tuning/capo). The "<root>5" chord name is only asserted when the
        // two notes really are a perfect fifth (7 semitones); exotic tunings
        // where the fixed s0f0+s1f2 shape isn't a fifth just name the two notes.
        // Falls back to standard-tuning E5 on any error.
        let root = 'E2', fifth = 'B2', chord = 'E5';
        try {
            if (getCurrentStringCount() >= 2) {
                const rootMidi = ndMidiFromStringFret(0, 0, getCurrentArrangement(), getCurrentStringCount(), getTuningOffsets(), getCapo());
                const fifthMidi = ndMidiFromStringFret(1, 2, getCurrentArrangement(), getCurrentStringCount(), getTuningOffsets(), getCapo());
                if (Number.isFinite(rootMidi) && Number.isFinite(fifthMidi)) {
                    root = ndMidiToName(rootMidi);
                    fifth = ndMidiToName(fifthMidi);
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
        const pitchTol = _calLabEffectivePitchTol(getPitchTolerance(), flags || {});
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
        return getCurrentStringCount() - stringIndex;
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
            const midi = ndMidiFromStringFret(
                stringIndex, fret, getCurrentArrangement(), getCurrentStringCount(), getTuningOffsets(), getCapo());
            if (Number.isFinite(midi)) expectedNote = ndMidiToName(midi);
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
            const expectedMidi = ndMidiFromStringFret(
                noteTick.string, noteTick.fret, getCurrentArrangement(), getCurrentStringCount(), getTuningOffsets(), getCapo());
            if (!Number.isFinite(expectedMidi)) return '—';
            return ndMidiToName(expectedMidi + noteTick.centsError / 100);
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
            const _dd = diagCatalog && diagCatalog.getDiagDetector();
            if (_dd && _dd.path) detectorPath = _dd.path;
            else if (getNdUsingEngineVerifier()) detectorPath = 'desktop-engine-verifier';
        } catch (_) { /* read-only */ }
        return {
            root: sum.root,
            fifth: sum.fifth,
            likely_cause: sum.likelyCause,
            input_channel: snap.channel || getSelectedChannel(),
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
        return !!(getEnabled() && getUsingDesktopBridge() && ndBridgeScoreAvailable());
    }

    async function _calLabRunScoreProbe(notes) {
        if (!_calLabCanProbe()) return null;
        const ctx = {
            arrangement: getCurrentArrangement(),
            stringCount: getCurrentStringCount(),
            offsets: getTuningOffsets().slice(0, getCurrentStringCount()),
            capo: getCapo(),
            pitchCheckCents: getPitchTolerance(),
            minHitRatio: getChordHitRatio(),
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
            return await ndBridgeScoreChord(ctx);
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
        for (let si = 0; si < getCurrentStringCount(); si++) {
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
                pitch_tolerance_cents: getPitchTolerance(),
                pitch_check_cents_verify: _ND_VERIFY_PITCH_CENTS,
                timing_tolerance_s: getTimingTolerance(),
                latency_offset_s: getLatencyOffset(),
                input_gain: getInputGain(),
                method: getDetectionMethod(),
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
        for (let i = 0; i < getCurrentStringCount(); i++) {
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


    return {
        openInstrumentCalibrationLab,
        calibrationLabClose,
        calibrationLabNext,
        calibrationLabBack,
        getCalibrationReport,
        downloadCalibrationReport: _calLabDownloadReport,
    };
}
