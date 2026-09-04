// nd-carve-5 cut 4 — settings panel subsystem
// Extracted from createNoteDetector() factory closure in src/main.js.
//
// Non-verbatim deltas vs. the original inline code:
//   1. VU-meter state (_vuPanelEl/_vuBarEl/_vuPeakEl/_vuPanelAbsent) becomes
//      local to this factory rather than outer-closure vars in main.js; caller
//      retargets drawSettingsVU() + _vuSetPanel(null) to _settingsPanel.*
//   2. Settings var reads for slider init use getState() accessor (live snapshot)
//      instead of direct closure reads — keeps the panel free of closure imports.
//   3. Settings var writes go through applySettings(changes) DI (pure assigns in
//      main.js) + saveSettings() call; interdependency clamping logic stays here.
//   4. saveSettings() stays in main.js (called from 15+ non-panel sites); passed
//      as DI so byte-identical localStorage persistence is preserved.
//   5. setChannel() stays in main.js (audio pipeline deps + public API export);
//      onChannelChange() here calls DI setChannel(idx).
//   6. setMethod() moved here; writes via applySettings() + calls DI loadCrepe().
//   7. onDeviceChange() moved here; writes via applySettings() + DI restartAudio().
//   8. populateDevices() moved here; reads selected device via getState().
//   9. showSettings() _ndCanNativeFrames check is a local IIFE (unchanged logic).
//  10. edgeFlash clear inside nd-edge-flash.onchange accesses instanceRoot via DI.
//  11. _ndWireSettingsRangeScrollLock passed as DI (no closure deps; stays in main).
//  12. All recording/health/calibration operations passed as DI fn refs.

/**
 * createSettingsPanel — settings panel subsystem for one note-detector instance.
 *
 * @param {object} opts
 * @param {Element}  opts.instanceRoot
 * @param {Function} opts.saveSettings           — () => void; persist all settings to localStorage
 * @param {Function} opts.getState               — () => snapshot; all current closure values
 * @param {Function} opts.getInputLevel          — () => number 0–1; live VU bar level
 * @param {Function} opts.getInputPeak           — () => number 0–1; live VU peak
 * @param {Function} opts.applySettings          — (changes: object) => void; pure var assigns in main.js
 * @param {Function} opts.attachInstanceRoot     — () => void
 * @param {Function} opts.setChannel             — (idx: number) => boolean; stays in main.js
 * @param {Function} opts.loadCrepe              — () => void; _ndLoadCrepe
 * @param {Function} opts.restartAudio           — () => void
 * @param {Function} opts.getEnabled             — () => boolean; for nativeDetection restart guard
 * @param {Function} opts.getRecordingState      — () => object
 * @param {Function} opts.armRecording           — () => void
 * @param {Function} opts.disarmRecording        — () => void
 * @param {Function} opts.armRecordingForTraining — () => Promise<void>
 * @param {Function} opts.saveRecordingNow       — () => Promise<void>
 * @param {Function} opts.discardRecording       — () => void
 * @param {Function} opts.renderDetectionHealth  — (panel: Element) => void
 * @param {Function} opts.openCalibrationWizard  — () => void
 * @param {Function} opts.openInstrumentCalibrationLab — () => void
 * @param {Function} opts.launchDiagnosticTrack  — (trackId: string, panel: Element) => void
 * @param {Function} opts.wireRangeScrollLock    — (panel: Element) => void
 */
export function createSettingsPanel({
    instanceRoot,
    saveSettings,
    getState,
    getInputLevel,
    getInputPeak,
    applySettings,
    attachInstanceRoot,
    setChannel,
    loadCrepe,
    restartAudio,
    getEnabled,
    getRecordingState,
    armRecording,
    disarmRecording,
    armRecordingForTraining,
    saveRecordingNow,
    discardRecording,
    renderDetectionHealth,
    openCalibrationWizard,
    openInstrumentCalibrationLab,
    launchDiagnosticTrack,
    wireRangeScrollLock,
}) {
    // ── VU meter state (splitscreen-safe; one set of refs per detector) ──
    // Cached refs so the always-on level-meter loop (60 Hz rAF or 20 Hz bridge
    // poll) doesn't querySelector on every tick while the settings panel is open.
    // _vuPanelAbsent latches a confirmed-closed panel so we skip queries when closed.
    let _vuPanelEl      = null;
    let _vuBarEl        = null;
    let _vuPeakEl       = null;
    let _vuPanelAbsent  = false;

    // ── VU helper ─────────────────────────────────────────────────────────
    function _vuSetPanel(panel) {
        if (panel) {
            _vuPanelEl = panel;
            _vuBarEl   = panel.querySelector('.nd-vu-bar');
            _vuPeakEl  = panel.querySelector('.nd-vu-peak');
            _vuPanelAbsent = !_vuBarEl;
        } else {
            _vuPanelEl     = null;
            _vuBarEl       = null;
            _vuPeakEl      = null;
            _vuPanelAbsent = true;
        }
    }

    // Called by the always-on level-meter loop (startLevelMeter rAF /
    // startBridgeLevelMeter 20Hz). Re-resolves only when the cached node is
    // gone or the panel was rebuilt. Once we confirm the panel is absent we
    // latch _vuPanelAbsent so the loop doesn't querySelector every frame.
    function drawSettingsVU() {
        let bar = _vuBarEl;
        if (!bar || !bar.isConnected) {
            if (_vuPanelAbsent) return;
            const panel = _vuPanelEl && _vuPanelEl.isConnected ? _vuPanelEl : null;
            if (!panel) { _vuSetPanel(null); return; }
            _vuSetPanel(panel);
            bar = _vuBarEl;
            if (!bar) return;
        }
        const peak = _vuPeakEl && _vuPeakEl.isConnected ? _vuPeakEl : null;
        const pct  = Math.round(getInputLevel() * 100);
        bar.style.width = pct + '%';
        bar.className = pct > 85
            ? 'nd-vu-bar h-full rounded transition-all duration-75 bg-red-500'
            : pct > 60
                ? 'nd-vu-bar h-full rounded transition-all duration-75 bg-yellow-500'
                : 'nd-vu-bar h-full rounded transition-all duration-75 bg-green-500';
        if (peak) {
            const peakPct = Math.round(getInputPeak() * 100);
            peak.style.left = Math.min(peakPct, 100) + '%';
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────
    function onDeviceChange(deviceId) {
        applySettings({ selectedDeviceId: deviceId });
        saveSettings();
        restartAudio();
    }

    function onChannelChange(channel) {
        // Route through setChannel() (stays in main.js) so a bound engine
        // source is RE-TARGETED to the new channel, not just the browser
        // splitter. setChannel updates _ndChannelIndex + selectedChannel,
        // retargets the source, saves, restarts.
        const idx = channel === 'left' ? 0 : channel === 'right' ? 1 : -1;
        setChannel(idx);
    }

    function setMethod(method) {
        applySettings({ detectionMethod: method, detectionMethodUserSet: true });
        saveSettings();
        if (method === 'crepe') loadCrepe();
    }

    async function populateDevices() {
        const sel = document.querySelector('.nd-settings-panel .nd-device-select');
        if (!sel) return;
        // When note detection actually captures through the native engine, the
        // input device + channel are chosen once in the onboarding Input Setup
        // wizard (audio-input domain) — a browser device list here would be
        // misleading (it only enumerates WASAPI inputs, never ASIO, and is
        // ignored on the native path), so show the managed state instead.
        // Gate on the engine being AVAILABLE, not merely "on desktop": if the
        // native addon failed to load, note detection falls back to getUserMedia
        // and the user still needs the browser device list to pick an input.
        const caps = (typeof window !== 'undefined') && window.slopsmith && window.slopsmith.capabilities;
        const desktop = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
        let nativeManaged = false;
        if (desktop && desktop.isDesktop && desktop.audio
            && caps && typeof caps.command === 'function'
            && typeof desktop.audio.isAvailable === 'function') {
            try { nativeManaged = !!(await desktop.audio.isAvailable()); }
            catch (_) { nativeManaged = false; }
        }
        if (nativeManaged) {
            sel.innerHTML = '<option value="">Set in Input Setup</option>';
            sel.disabled = true;
            sel.title = 'Your input device and input are chosen in the Input Setup wizard.';
            return;
        }
        sel.disabled = false;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            sel.innerHTML = '<option value="">Default</option>';
            for (const d of devices) {
                if (d.kind !== 'audioinput') continue;
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
                if (d.deviceId === getState().selectedDeviceId) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch (e) { /* permission not yet granted */ }
    }

    // ── Settings panel ────────────────────────────────────────────────────
    function showSettings() {
        attachInstanceRoot();

        let panel = document.querySelector('.nd-settings-panel');
        if (panel) {
            if (panel._ndHealthTick) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
            }
            _vuSetPanel(null);
            if (panel.isConnected) {
                panel.remove();
                return;
            }
            panel.remove();
        }

        panel = document.createElement('div');
        // Position/size via inline styles — several Tailwind utilities used
        // here (top-16, right-4, w-80, z-[150]) are not in the built
        // slopsmith CSS bundle, so class-only styling left the panel
        // unboxed and its labels flowed over the highway. Mount on
        // document.body so fixed placement is relative to the viewport.
        panel.className = 'nd-settings-panel bg-dark-700 border border-gray-600 rounded-xl p-4 shadow-2xl text-sm';
        panel.style.pointerEvents = 'auto';
        panel.style.position = 'fixed';
        panel.style.top = '4rem';
        panel.style.right = '1rem';
        panel.style.zIndex = '250';
        panel.style.width = '20rem';
        panel.style.maxWidth = 'calc(100vw - 2rem)';
        panel.style.maxHeight = 'calc(100vh - 5rem)';
        panel.style.overflowY = 'auto';
        // The native-frame detection toggle only does something on a desktop
        // build whose engine exposes the raw-audio-frame pull this instance
        // would use — hide it entirely in the browser / on a downlevel addon
        // so it can't read as a dead switch.
        //
        // This check must be session-independent (the settings panel can open
        // while Detect is off, when bridgeDesktop is null and
        // _ndBridgeRawFramesAvailable() always returns false). Probe
        // window.feedBackDesktop directly and accept either getRawAudioFrame
        // (default / unbound source) or getSourceRawAudioFrame (source-bound /
        // splitscreen / multi-input), so the toggle is shown for any capable
        // desktop build regardless of audio session state.
        //
        // Edge case: a source-bound instance on an addon that has
        // getRawAudioFrame but not getSourceRawAudioFrame would see the toggle
        // even though it cannot enter native-frame mode (startAudio() requires
        // getSourceRawAudioFrame for bound sources). This is accepted: in
        // practice, source binding requires a newer addon that has BOTH APIs,
        // so the scenario never arises in field builds. The alternative —
        // hiding the toggle for all unbound instances on such an addon — is
        // a worse trade-off.
        const _ndCanNativeFrames = (function () {
            const d = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
            const a = d && d.isDesktop && d.audio;
            if (!a) return false;
            return typeof a.getRawAudioFrame === 'function'
                || typeof a.getSourceRawAudioFrame === 'function';
        })();

        // Read current values once (live snapshot) for slider initialization.
        const s = getState();
        panel.innerHTML = `
            <div class="flex justify-between items-center mb-3">
                <span class="text-gray-200 font-semibold">Note Detection Settings</span>
                <button class="nd-settings-close text-gray-500 hover:text-white">&times;</button>
            </div>

            <div class="nd-health-block bg-dark-600/40 border border-gray-700 rounded-lg p-3 mb-3 text-[11px] text-gray-300 leading-snug">
                <div class="text-gray-200 text-xs font-semibold uppercase tracking-wider mb-2">Detection Health</div>
                <div class="nd-health-status text-gray-400 mb-1">—</div>
                <div class="nd-health-input text-gray-400 mb-1">—</div>
                <div class="nd-health-hearing text-cyan-300/90 mb-1 font-mono text-[10px]">—</div>
                <div class="nd-health-session text-gray-300 mb-1">—</div>
                <div class="nd-health-top-miss text-gray-400 mb-1">—</div>
                <div class="nd-health-align text-gray-400 mb-1">—</div>
                <div class="nd-health-level text-gray-400 mb-1">—</div>
                <div class="text-gray-200 text-[10px] font-semibold uppercase tracking-wider mt-2 mb-1">Recent notes that did not verify</div>
                <div class="nd-health-rejects text-gray-400 text-[10px] whitespace-pre-line leading-snug mb-1">—</div>
                <div class="nd-health-hint text-amber-200/90 mt-2 pt-2 border-t border-gray-700/80">—</div>
                <div class="text-[10px] text-gray-500 mt-1 leading-tight">Read-only health stats. Use the diagnostic track for playthrough assessment, Calibration Wizard for setup, and Advanced Signal Check for deeper signal detail.</div>
                <div class="text-[10px] text-gray-500 mt-2 mb-1 leading-tight">Play a short built-in track to check timing, open strings, fretted notes, and power chords on the highway.</div>
                <button type="button" class="nd-diag-launch-basic w-full py-2 bg-dark-600 hover:bg-dark-500 border border-cyan-900/50 rounded-lg text-xs text-gray-200 transition">
                    Run Basic Guitar Diagnostic
                </button>
                <div class="nd-health-diag-launch-status text-[10px] text-cyan-200/90 mt-1 mb-2 leading-snug"></div>
                <div class="text-[10px] text-gray-500 mb-1 leading-tight">Set up audio input, levels, and timing before you play.</div>
                <button type="button" class="nd-cal-wizard-open w-full py-2 bg-dark-600 hover:bg-dark-500 border border-gray-700 rounded-lg text-xs text-gray-200 transition">
                    Run Calibration Wizard
                </button>
                <div class="text-[10px] text-gray-500 mt-2 mb-1 leading-tight">Optional deeper troubleshooting for root/fifth, SNR, tuning, and signal-clarity details after a diagnostic track.</div>
                <button type="button" class="nd-cal-lab-open w-full py-2 bg-dark-600 hover:bg-dark-500 border border-purple-900/50 rounded-lg text-xs text-gray-200 transition">
                    Advanced Signal Check
                </button>
            </div>

            ${s.tuningMode ? `
            <div class="nd-rec-block bg-dark-600/40 border border-gray-700 rounded-lg p-3 mb-3">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-gray-200 text-xs font-semibold uppercase tracking-wider">Reference Recording</span>
                    <span class="nd-rec-state text-[10px] uppercase tracking-wider text-gray-500">idle</span>
                </div>
                <div class="nd-rec-info text-[11px] text-gray-400 leading-snug mb-2">Click Arm, then press Play on the song.</div>
                <div class="flex gap-1.5">
                    <button class="nd-rec-arm flex-1 bg-accent hover:bg-accent-light disabled:bg-dark-600 disabled:cursor-not-allowed disabled:text-gray-600 px-2 py-1.5 rounded text-xs font-semibold text-white transition">
                        Arm
                    </button>
                    <button class="nd-rec-arm-training flex-1 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:cursor-not-allowed disabled:text-gray-600 px-2 py-1.5 rounded text-xs font-semibold text-white transition" title="Capture this take and upload it to the curated training dataset (WAV + detect-stream + manifest, zipped, sent to pCloud)">
                        Arm (training)
                    </button>
                    <button class="nd-rec-save px-3 py-1.5 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed" title="Save what's captured so far">
                        Save
                    </button>
                    <button class="nd-rec-discard px-3 py-1.5 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed" title="Throw out the in-flight buffer">
                        Discard
                    </button>
                </div>
                <div class="nd-rec-saved text-[10px] text-gray-500 mt-2 break-all"></div>
                <div class="nd-rec-upload text-[10px] mt-1 break-all"></div>
            </div>
            ` : ''}

            <label class="block text-gray-400 text-xs mb-1">Audio Input Device</label>
            <select class="nd-device-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="">Default</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Channel</label>
            <select class="nd-channel-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="mono" ${s.selectedChannel === 'mono' ? 'selected' : ''}>Mono (mix both channels)</option>
                <option value="left" ${s.selectedChannel === 'left' ? 'selected' : ''}>Left (Ch 1) — typically dry/DI</option>
                <option value="right" ${s.selectedChannel === 'right' ? 'selected' : ''}>Right (Ch 2) — typically wet/FX</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Level</label>
            <div class="relative h-3 bg-dark-600 rounded overflow-hidden mb-1">
                <div class="nd-vu-bar h-full rounded transition-all duration-75 bg-green-500" style="width:0%"></div>
                <div class="nd-vu-peak absolute top-0 w-0.5 h-full bg-white/70" style="left:0%"></div>
            </div>
            <div class="flex justify-between text-[9px] text-gray-600 mb-3">
                <span>-inf</span><span>-18dB</span><span>-6dB</span><span>0dB</span>
            </div>

            <label class="block text-gray-400 text-xs mb-1">Detection Method</label>
            <select class="nd-method-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-3">
                <option value="yin" ${s.detectionMethod === 'yin' ? 'selected' : ''}>YIN (lightweight, clean signals)</option>
                <option value="hps" ${s.detectionMethod === 'hps' ? 'selected' : ''}>HPS (bass with weak fundamental, no model)</option>
                <option value="crepe" ${s.detectionMethod === 'crepe' ? 'selected' : ''}>CREPE/SPICE (robust, ~20MB model)</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Audio Latency Offset: <span class="nd-latency-val">${Math.round(s.latencyOffset * 1000)}</span>ms</label>
            <input type="range" min="0" max="250" value="${Math.round(s.latencyOffset * 1000)}"
                   class="nd-latency-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Compensates for USB/audio interface delay. Increase if notes register late.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Timing Tolerance: <span class="nd-timing-val">${Math.round(s.timingTolerance * 1000)}</span>ms</label>
            <input type="range" min="30" max="300" value="${Math.round(s.timingTolerance * 1000)}"
                   class="nd-timing-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-2 leading-tight">
                Outer match window. Detections outside this range are ignored.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Pitch Tolerance: <span class="nd-pitch-val">${s.pitchTolerance}</span> cents</label>
            <input type="range" min="10" max="100" value="${s.pitchTolerance}"
                   class="nd-pitch-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Outer pitch match window. Wider values correlate more attempts.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Clean Timing: <span class="nd-timing-hit-val">${Math.round(s.timingHitThreshold * 1000)}</span>ms</label>
            <input type="range" min="30" max="${Math.round(s.timingTolerance * 1000)}" value="${Math.round(s.timingHitThreshold * 1000)}"
                   class="nd-timing-hit-slider w-full accent-blue-400 mb-2">

            <label class="block text-gray-400 text-xs mb-1">Chord Timing Window: <span class="nd-chord-timing-val">${Math.round(s.chordTimingHitThreshold * 1000)}</span>ms</label>
            <input type="range" min="${Math.round(s.timingHitThreshold * 1000)}" max="${Math.round(s.timingTolerance * 1000)}" value="${Math.round(s.chordTimingHitThreshold * 1000)}"
                   class="nd-chord-timing-slider w-full accent-blue-400 mb-1">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Chord strums have more inherent timing jitter than single notes (multi-string strike spread + analysis-window smearing). Fast power-chord punk also anticipates the beat. Wider than Clean Timing; pinned >= it.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Clean Pitch: <span class="nd-pitch-hit-val">${s.pitchHitThreshold}</span> cents</label>
            <input type="range" min="5" max="${s.pitchTolerance}" value="${s.pitchHitThreshold}"
                   class="nd-pitch-hit-slider w-full accent-blue-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Detection Confidence: <span class="nd-conf-val">${Math.round(s.detectionConfidenceMin * 100)}</span>%</label>
            <input type="range" min="5" max="50" value="${Math.round(s.detectionConfidenceMin * 100)}"
                   class="nd-conf-slider w-full accent-purple-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Minimum confidence to accept a YIN/HPS/CREPE frame. Lower this if too many notes register as "pure miss" with no detection — at the cost of more false positives on quiet/noisy signals.
            </div>

            ${_ndCanNativeFrames ? `
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <input type="checkbox" class="nd-native-detect accent-purple-400" ${s.nativeDetection ? 'checked' : ''}>
                Detect in-plugin (native audio)
            </label>
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Desktop only. Runs note_detect's own ${'YIN/HPS/CREPE'} on the engine-captured guitar signal (instead of the engine's built-in detector), while chords are still verified by the engine's harmonic-comb scorer. Use this to pick HPS/CREPE on desktop. Takes effect immediately if Detect is currently on; otherwise on the next Detect toggle.
            </div>` : ''}

            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-timing accent-green-400" ${s.showTimingErrors ? 'checked' : ''}>
                Show early/late labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-pitch accent-green-400" ${s.showPitchErrors ? 'checked' : ''}>
                Show sharp/flat labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <input type="checkbox" class="nd-edge-flash accent-green-400" ${s.edgeFlashEnabled ? 'checked' : ''}>
                Screen-edge flash on hit/miss
            </label>
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Off by default — the highway now lights up the note itself on a hit. Turn on for the old full-screen green/red edge flash.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Miss Marker Duration: <span class="nd-miss-duration-val">${s.missMarkerDuration.toFixed(1)}</span>s</label>
            <input type="range" min="5" max="50" value="${Math.round(s.missMarkerDuration * 10)}"
                   class="nd-miss-duration-slider w-full accent-red-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Input Gain: <span class="nd-gain-val">${s.inputGain.toFixed(1)}</span>x</label>
            <input type="range" min="1" max="50" value="${Math.round(s.inputGain * 10)}"
                   class="nd-gain-slider w-full accent-green-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Chord Leniency: <span class="nd-chord-ratio-val">${Math.round(s.chordHitRatio * 100)}</span>% of strings</label>
            <input type="range" min="25" max="100" value="${Math.round(s.chordHitRatio * 100)}"
                   class="nd-chord-ratio-slider w-full accent-green-400 mb-1">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Chord detection uses per-string band analysis. This sets how many strings must ring to count as a hit (e.g. 60% = 4 of 6). Lower for beginners or dense voicings.
            </div>

            <div class="text-[10px] text-gray-600 mt-1 leading-tight">
                Tip: For multi-effects pedals with USB audio (e.g. Valeton GP-5), select <b>Left (Ch 1)</b> for the dry/DI signal — it gives the most accurate pitch detection.
                See the <b>Pitch Detection Methods</b> section of the plugin README for guidance on choosing between YIN, HPS, and CREPE.
            </div>
        `;

        document.body.appendChild(panel);
        // Cache the VU-meter refs for the always-on level loop so
        // drawSettingsVU() stops querying the DOM every frame.
        _vuSetPanel(panel);

        // Wire up controls
        panel.querySelector('.nd-settings-close').onclick = () => {
            if (panel._ndHealthTick) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
            }
            _vuSetPanel(null);
            panel.remove();
        };

        const calWizardBtn = panel.querySelector('.nd-cal-wizard-open');
        if (calWizardBtn) {
            calWizardBtn.onclick = () => openCalibrationWizard();
        }
        const calLabBtn = panel.querySelector('.nd-cal-lab-open');
        if (calLabBtn) {
            calLabBtn.onclick = () => openInstrumentCalibrationLab();
        }
        const diagLaunchBtn = panel.querySelector('.nd-diag-launch-basic');
        if (diagLaunchBtn) {
            diagLaunchBtn.onclick = () => launchDiagnosticTrack('basic-guitar-6', panel);
        }

        try {
            renderDetectionHealth(panel);
        } catch (e) {
            console.warn('[note_detect] Detection Health render failed:',
                e && e.message ? e.message : e);
        }
        panel._ndHealthTick = setInterval(() => {
            if (!panel.isConnected) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
                return;
            }
            try {
                renderDetectionHealth(panel);
            } catch (e) {
                console.warn('[note_detect] Detection Health render failed:',
                    e && e.message ? e.message : e);
            }
        }, 400);

        // Reference-recording controls — present only when tuningMode is
        // on (the .nd-rec-block element is conditional in the template
        // above). Status updates on a self-cancelling 1s interval so the
        // duration tick + "Saved to ..." path appear in real time while
        // the popover is open.
        const recBlock = panel.querySelector('.nd-rec-block');
        if (recBlock) {
            const armBtn    = recBlock.querySelector('.nd-rec-arm');
            const armTrnBtn = recBlock.querySelector('.nd-rec-arm-training');
            const saveBtn   = recBlock.querySelector('.nd-rec-save');
            const discBtn   = recBlock.querySelector('.nd-rec-discard');
            const stateEl   = recBlock.querySelector('.nd-rec-state');
            const infoEl    = recBlock.querySelector('.nd-rec-info');
            const savedEl   = recBlock.querySelector('.nd-rec-saved');
            const uploadEl  = recBlock.querySelector('.nd-rec-upload');
            // Declared up-front (vs. `const` after setInterval below) so
            // the bail-out branch in renderRec can call clearInterval
            // even if it fires on the very first synchronous call before
            // the interval has been installed — e.g., when instanceRoot
            // isn't attached to document.body in some host/test context.
            // Without this, the early bail-out would hit the temporal
            // dead zone and ReferenceError-out instead of cleaning up.
            let tick = null;

            function renderRec() {
                if (!document.body.contains(panel)) { if (tick != null) clearInterval(tick); return; }
                const r = getRecordingState();
                const hasBuffer = r.samples > 0;
                const trainTag = r.armedForTraining ? ' (training)' : '';
                let label, info;
                if (r.saveInFlight) { label = 'saving…'; info = 'Encoding + uploading the WAV…'; }
                else if (r.trainingUploadInFlight) { label = 'uploading…'; info = 'Bundling WAV + detect-stream + manifest and shipping to pCloud…'; }
                else if (r.lastError) { label = 'error'; info = 'Last attempt failed: ' + r.lastError; }
                else if (r.armed && r.songPlaying) { label = 'recording' + trainTag; info = `Capturing… ${r.durationS.toFixed(1)} s (${r.samples} samples @ ${r.sampleRate} Hz). Auto-saves on song end${r.armedForTraining ? ' and uploads to the training dataset' : ''}.`; }
                else if (r.armed && !r.detectEnabled) { label = 'armed (Detect off)' + trainTag; info = 'Armed, but Detect isn\'t on — no audio is flowing.'; }
                else if (r.armed) { label = 'armed' + trainTag; info = 'Armed. Press Play to start capturing.'; }
                else if (hasBuffer) { label = 'paused'; info = `${r.durationS.toFixed(1)} s captured; Save to keep it or Discard to throw it out.`; }
                else if (r.lastSavePath) { label = 'idle'; info = 'Ready. Click Arm for the next take.'; }
                else { label = 'idle'; info = 'Click Arm, then press Play.'; }
                if (stateEl) stateEl.textContent = label;
                if (infoEl)  {
                    infoEl.textContent = info;
                    infoEl.className = 'nd-rec-info text-[11px] leading-snug mb-2 ' + (r.lastError ? 'text-red-400' : 'text-gray-400');
                }
                // Build the "<label> <code>filename</code>" line with
                // textContent, never innerHTML — the path / bundle name
                // can contain server-side filesystem strings (the retry
                // endpoint accepts any training_*.zip), so interpolating
                // them into innerHTML would be an injection surface.
                const _setCodeLine = (el, lbl, codeText) => {
                    el.textContent = lbl;
                    const c = document.createElement('code');
                    c.className = 'text-gray-300';
                    c.textContent = codeText;
                    el.appendChild(c);
                };
                if (savedEl) {
                    if (r.lastSavePath && !r.armed && !r.lastError) {
                        _setCodeLine(savedEl, 'Saved: ', r.lastSavePath);
                    } else {
                        savedEl.textContent = '';
                    }
                }
                if (uploadEl) {
                    const tr = r.trainingUploadResult;
                    if (tr && tr.ok) {
                        uploadEl.className = 'nd-rec-upload text-[10px] text-green-400 mt-1 break-all';
                        _setCodeLine(uploadEl, 'Uploaded to training dataset: ', tr.bundle_filename || '(unknown)');
                    } else if (tr && !tr.ok) {
                        uploadEl.className = 'nd-rec-upload text-[10px] text-red-400 mt-1 break-all';
                        uploadEl.textContent = 'Upload failed: ' + (tr.error || 'unknown error') + (tr.local_bundle ? ' (bundle retained at ' + tr.local_bundle + ')' : '');
                    } else {
                        uploadEl.textContent = '';
                    }
                }
                // Disable the alternate arm path while one is active or
                // an upload is in flight — switching modes mid-take would
                // leave _recArmedForTraining ambiguous.
                if (armBtn)    { armBtn.textContent = (r.armed && !r.armedForTraining) ? 'Disarm' : 'Arm'; armBtn.disabled = r.saveInFlight || r.trainingUploadInFlight || (r.armed && r.armedForTraining); }
                if (armTrnBtn) { armTrnBtn.textContent = (r.armed && r.armedForTraining) ? 'Disarm' : 'Arm (training)'; armTrnBtn.disabled = r.saveInFlight || r.trainingUploadInFlight || (r.armed && !r.armedForTraining); }
                // Save is disabled during a training arm — a training
                // take auto-saves + uploads on song:ended; a manual
                // mid-take save would only orphan _recArmedForTraining /
                // the live stream / the parallel capture.
                if (saveBtn) saveBtn.disabled = !hasBuffer || r.saveInFlight || r.trainingUploadInFlight || r.armedForTraining;
                if (discBtn) discBtn.disabled = !(r.armed || hasBuffer) || r.saveInFlight || r.trainingUploadInFlight;
            }
            if (armBtn) armBtn.onclick = () => {
                const r = getRecordingState();
                if (r.armed && !r.armedForTraining) disarmRecording();
                else if (!r.armed) armRecording();
                renderRec();
            };
            if (armTrnBtn) armTrnBtn.onclick = async () => {
                const r = getRecordingState();
                if (r.armed && r.armedForTraining) {
                    disarmRecording();
                } else if (!r.armed) {
                    // armRecordingForTraining awaits getUserMedia when
                    // the desktop bridge is active. Surface a permission /
                    // device failure through _recLastSaveError (rendered
                    // below) rather than as an uncaught promise rejection.
                    try { await armRecordingForTraining(); } catch (_) { /* lastSaveError set inside */ }
                }
                renderRec();
            };
            if (saveBtn) saveBtn.onclick = async () => {
                await saveRecordingNow();
                renderRec();
            };
            if (discBtn) discBtn.onclick = () => { discardRecording(); renderRec(); };
            renderRec();
            tick = setInterval(renderRec, 1000);
        }

        // ── Slider / toggle wiring ─────────────────────────────────────
        // Each handler computes new values (with clamping where sliders
        // are interdependent), calls applySettings() to write them to
        // the main.js closure, then calls saveSettings() to persist.
        panel.querySelector('.nd-device-select').onchange  = (e) => onDeviceChange(e.target.value);
        panel.querySelector('.nd-channel-select').onchange = (e) => onChannelChange(e.target.value);
        panel.querySelector('.nd-method-select').onchange  = (e) => setMethod(e.target.value);

        panel.querySelector('.nd-latency-slider').oninput = (e) => {
            applySettings({ latencyOffset: e.target.value / 1000 });
            panel.querySelector('.nd-latency-val').textContent = e.target.value;
            saveSettings();
        };

        panel.querySelector('.nd-timing-slider').oninput = (e) => {
            const ms = +e.target.value;
            const newTolerance = ms / 1000;
            const cur = getState();
            const newHit    = Math.min(cur.timingHitThreshold, newTolerance);
            let newChordHit = Math.min(cur.chordTimingHitThreshold, newTolerance);
            if (newChordHit < newHit) newChordHit = newHit;
            applySettings({ timingTolerance: newTolerance, timingHitThreshold: newHit, chordTimingHitThreshold: newChordHit });
            panel.querySelector('.nd-timing-val').textContent = e.target.value;
            const hitSlider = panel.querySelector('.nd-timing-hit-slider');
            if (hitSlider) {
                hitSlider.max = e.target.value;
                hitSlider.value = Math.round(newHit * 1000);
                panel.querySelector('.nd-timing-hit-val').textContent = hitSlider.value;
            }
            const chordSlider = panel.querySelector('.nd-chord-timing-slider');
            if (chordSlider) {
                chordSlider.max = e.target.value;
                chordSlider.min = Math.round(newHit * 1000);
                chordSlider.value = Math.round(newChordHit * 1000);
                panel.querySelector('.nd-chord-timing-val').textContent = chordSlider.value;
            }
            saveSettings();
        };

        panel.querySelector('.nd-pitch-slider').oninput = (e) => {
            const newTolerance = +e.target.value;
            const cur = getState();
            const newHit = Math.min(cur.pitchHitThreshold, newTolerance);
            applySettings({ pitchTolerance: newTolerance, pitchHitThreshold: newHit });
            panel.querySelector('.nd-pitch-val').textContent = e.target.value;
            const hitSlider = panel.querySelector('.nd-pitch-hit-slider');
            if (hitSlider) {
                hitSlider.max = e.target.value;
                hitSlider.value = newHit;
                panel.querySelector('.nd-pitch-hit-val').textContent = hitSlider.value;
            }
            saveSettings();
        };

        panel.querySelector('.nd-timing-hit-slider').oninput = (e) => {
            const newHit = e.target.value / 1000;
            const cur = getState();
            // Keep the chord-timing slider's lower bound + value in sync —
            // chord threshold can never be stricter than single-note.
            const newChordHit = cur.chordTimingHitThreshold < newHit ? newHit : cur.chordTimingHitThreshold;
            applySettings({ timingHitThreshold: newHit, chordTimingHitThreshold: newChordHit });
            panel.querySelector('.nd-timing-hit-val').textContent = e.target.value;
            const chordSlider = panel.querySelector('.nd-chord-timing-slider');
            if (chordSlider) {
                chordSlider.min = e.target.value;
                chordSlider.value = Math.round(newChordHit * 1000);
                panel.querySelector('.nd-chord-timing-val').textContent = chordSlider.value;
            }
            saveSettings();
        };

        panel.querySelector('.nd-chord-timing-slider').oninput = (e) => {
            const cur = getState();
            // Enforce the invariant on direct edits — slider min should
            // already prevent inversion, but a stale DOM state during fast
            // drag can momentarily produce values below the current
            // single-note threshold. Clamp here to be safe.
            let newChordHit = e.target.value / 1000;
            const clamped = newChordHit < cur.timingHitThreshold;
            if (clamped) newChordHit = cur.timingHitThreshold;
            // When we clamped up, sync the slider's value back to the
            // clamped position so the thumb doesn't sit below the setting.
            if (clamped) e.target.value = Math.round(newChordHit * 1000);
            applySettings({ chordTimingHitThreshold: newChordHit });
            panel.querySelector('.nd-chord-timing-val').textContent = Math.round(newChordHit * 1000);
            saveSettings();
        };

        panel.querySelector('.nd-pitch-hit-slider').oninput = (e) => {
            applySettings({ pitchHitThreshold: +e.target.value });
            panel.querySelector('.nd-pitch-hit-val').textContent = e.target.value;
            saveSettings();
        };

        panel.querySelector('.nd-conf-slider').oninput = (e) => {
            // Slider is in percent (5-50); state is the 0.05-0.50 fraction.
            applySettings({ detectionConfidenceMin: (+e.target.value) / 100 });
            panel.querySelector('.nd-conf-val').textContent = e.target.value;
            saveSettings();
        };

        // Native-frame detection toggle — only present on a capable desktop
        // build (see _ndCanNativeFrames), so null-guard the lookup. The mode
        // is captured per-session in startAudio(), so restart the audio path
        // if Detect is currently on for the change to take effect immediately.
        const nativeDetectEl = panel.querySelector('.nd-native-detect');
        if (nativeDetectEl) {
            nativeDetectEl.onchange = (e) => {
                applySettings({ nativeDetection: !!e.target.checked });
                saveSettings();
                if (getEnabled()) restartAudio();
            };
        }

        panel.querySelector('.nd-show-timing').onchange = (e) => {
            applySettings({ showTimingErrors: !!e.target.checked });
            saveSettings();
        };

        panel.querySelector('.nd-show-pitch').onchange = (e) => {
            applySettings({ showPitchErrors: !!e.target.checked });
            saveSettings();
        };

        panel.querySelector('.nd-edge-flash').onchange = (e) => {
            applySettings({ edgeFlashEnabled: !!e.target.checked });
            if (!e.target.checked) {
                // Clear any flash that's mid-fade so it doesn't linger.
                const fe = instanceRoot.querySelector('.nd-flash-overlay');
                if (fe) fe.style.borderColor = 'transparent';
            }
            saveSettings();
        };

        panel.querySelector('.nd-miss-duration-slider').oninput = (e) => {
            const v = e.target.value / 10;
            applySettings({ missMarkerDuration: v });
            panel.querySelector('.nd-miss-duration-val').textContent = v.toFixed(1);
            saveSettings();
        };

        panel.querySelector('.nd-gain-slider').oninput = (e) => {
            const v = e.target.value / 10;
            applySettings({ inputGain: v });
            panel.querySelector('.nd-gain-val').textContent = v.toFixed(1);
            saveSettings();
        };

        panel.querySelector('.nd-chord-ratio-slider').oninput = (e) => {
            applySettings({ chordHitRatio: e.target.value / 100 });
            panel.querySelector('.nd-chord-ratio-val').textContent = e.target.value;
            saveSettings();
        };

        wireRangeScrollLock(panel);
        populateDevices();
    }

    // ── Public API ────────────────────────────────────────────────────────
    return {
        showSettings,
        drawSettingsVU,
        // Exposed so startAudio() call sites in main.js can populate the
        // device dropdown after stream negotiation.
        populateDevices,
        // Exposed so main.js can clear the VU refs on disable() / destroy().
        vuSetPanel: _vuSetPanel,
    };
}
