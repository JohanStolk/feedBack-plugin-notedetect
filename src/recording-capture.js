// Reference-recording capture subsystem (nd-carve-7 cut 7).
// Extracted from createNoteDetector() in main.js.
//
// Captures the SAME Float32 audio frames the detector is running its analysis
// on, while a song is playing, so the headless harness has a known-aligned WAV
// to feed it — no DAW / Audacity needed. Auto-starts on song:play once armed,
// auto-saves on song:ended. The WAV lands under
// `static/note_detect_recordings/` via the routes.py POST endpoint; that dir
// is bind-mounted in the dev container so the harness on the host can read it
// back without a copy step.

/* global window, navigator, document, localStorage, fetch */

// ── WAV encoder ──────────────────────────────────────────────────────────────
// 16-bit PCM mono RIFF/WAVE blob. Moved here from module scope in main.js
// (nd-carve-7 cut 7) so the encoder lives alongside its only consumer.
// Re-exported so any future sibling that needs WAV encoding can import it.
// Soft-clips to int16 range; no dithering — fine for the detector's downstream
// analysis but don't ship this as a master.
export function _ndEncodeWavPcm16(chunks, sampleRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const buf = new ArrayBuffer(44 + total * 2);
    const v = new DataView(buf);
    let off = 0;
    const w4  = (s) => { for (let i = 0; i < 4; i++) v.setUint8(off++, s.charCodeAt(i)); };
    const w16 = (n) => { v.setUint16(off, n, true); off += 2; };
    const w32 = (n) => { v.setUint32(off, n, true); off += 4; };
    w4('RIFF');  w32(36 + total * 2);  w4('WAVE');
    w4('fmt ');  w32(16);
    w16(1);                                          // PCM
    w16(1);                                          // mono
    w32(sampleRate);
    w32(sampleRate * 2);                             // byte rate
    w16(2);                                          // block align
    w16(16);                                         // bits per sample
    w4('data');  w32(total * 2);
    for (const c of chunks) {
        for (let i = 0; i < c.length; i++) {
            let s = c[i];
            if (s > 1)  s =  1;
            else if (s < -1) s = -1;
            v.setInt16(off, (s * 32767) | 0, true);
            off += 2;
        }
    }
    return buf;
}

// ── createRecordingCapture ────────────────────────────────────────────────────
// DI params — all mutable factory deps are live accessors (never captured raw
// at construction time per the LIVE-ACCESSOR RULE).
//
//   Accessors (mutable):
//     getHw, getSelectedChannel, getSelectedDeviceId, getInputGain,
//     getLatencyOffset, getTuningMode, getAutoRecord, getDetectPreference,
//     getCurrentFilename, getDiagCatalog, getSummaryUi,
//     getDetectionMethod, getTimingTolerance, getTimingHitThreshold,
//     getPitchTolerance, getUsingDesktopBridge, getEnabled
//
//   Stable values / function refs (safe to capture at construction):
//     isDefault            — !!opts.isDefault, constant per-instance
//     openInstrumentStream — factory-level function ref, never reassigned
//     getTrainingChartSnapshot — factory-level function ref, never reassigned
export function createRecordingCapture({
    getHw,
    getSelectedChannel,
    getSelectedDeviceId,
    getInputGain,
    getLatencyOffset,
    getTuningMode,
    getAutoRecord,
    getDetectPreference,
    isDefault,                  // constant — !!opts.isDefault
    getCurrentFilename,
    getDiagCatalog,
    getSummaryUi,
    getDetectionMethod,
    getTimingTolerance,
    getTimingHitThreshold,
    getPitchTolerance,
    getUsingDesktopBridge,
    getEnabled,
    openInstrumentStream,       // stable factory-local function ref
    getTrainingChartSnapshot,   // stable factory-local function ref
}) {
    // ── State ────────────────────────────────────────────────────────────────
    let _recArmed = false;            // user clicked Arm; waiting for / actively recording
    let _recArmedForTraining = false; // set alongside _recArmed when the user clicked Arm (training);
                                      // triggers the post-save POST to /training-bundle that
                                      // zips WAV+JSONL+manifest and uploads to pCloud
    let _recSongPlaying = false;      // tracks song:play / song:pause / song:ended
    let _recChunks = [];              // Array<Float32Array>; concatenated only on save
    let _recSampleRate = 44100;       // captured from audioCtx when the first frame lands
    let _recLastSavePath = null;      // host-visible relative path of the most recent save
    let _recLastSaveError = null;     // surfaced in the UI when a save fails
    let _recSaveInFlight = false;     // de-dupe rapid saves
    let _recCappedAt = null;          // seconds into the take where the client-side cap kicked in (null = no cap hit)
    let _recTotalSamples = 0;         // running sum of _recChunks lengths — avoids O(n²) reduce on the detection hot path
    // Training-upload tracking — surfaced in the gear popover so the
    // user knows whether the bundle made it to the curated dataset.
    let _recTrainingUploadInFlight = false;
    let _recTrainingUploadResult = null; // { ok, bundle_filename, pcloud_result } | { ok:false, error, local_bundle }
    // Parallel getUserMedia capture for training takes when the desktop
    // bridge is active. The bridge intentionally does NOT open a JS-side
    // audio chain (the native JUCE engine owns the device), so the
    // existing _recChunks push site inside processFrame() never runs
    // and the WAV would always be empty. This capture is orthogonal:
    // its own MediaStream / AudioContext / ScriptProcessor solely to
    // copy Float32 frames into _recChunks. Closed on disarm / discard /
    // save-completion / destroy. Null when not in use.
    let _trainingCapture = null;

    // ── processFrame tap ──────────────────────────────────────────────────────
    // Called by main.js processFrame() when _recCapture.isArmed() is true.
    // Pushes one Float32 audio frame into the capture buffer, respecting the
    // client-side cap. Callers pass the sample rate from the live AudioContext
    // so we don't hold a reference to it.
    function pushFrame(buffer, sampleRate) {
        if (!_recSongPlaying) return;
        _recSampleRate = sampleRate || _recSampleRate;
        // Client-side cap mirrors the routes.py 32 MB ceiling so a
        // runaway arm (user walks away with Detect still capturing)
        // can't balloon the page's heap before the server-side cap
        // rejects the upload. 32 MB / 4 bytes per Float32 ≈ 8M
        // samples ≈ 190 s at 44.1 kHz (~3.2 min) — well past a
        // single benchmark take. When we hit it, the buffer stays
        // at the cap and `_recCappedAt` is set so the save path
        // can surface a "truncated" note on the resulting WAV.
        //
        // Track the running sample count in `_recTotalSamples`
        // rather than `_recChunks.reduce(...)` per frame. The
        // reduce was O(n) per frame and O(n²) over a take — a
        // measurable hit on the detection hot path on long
        // recordings.
        const maxSamples = Math.floor((32 * 1024 * 1024) / 4);
        if (_recTotalSamples >= maxSamples) {
            if (!_recCappedAt) _recCappedAt = _recTotalSamples / (_recSampleRate || 44100);
            // Silently drop further frames — the cap is the upper bound
            // and we'd rather keep the first N minutes than truncate the
            // tail of a long take.
            return;
        }
        // slice() because the analyser may overwrite the buffer the
        // next time processFrame fires.
        const copy = buffer.slice();
        _recChunks.push(copy);
        _recTotalSamples += copy.length;
    }

    // ── Capture commands ─────────────────────────────────────────────────────
    function armRecording() {
        _recArmed = true;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        // Bind song-event listeners lazily so an idle plugin instance
        // doesn't sit on the slopsmith bus. Unbind in disarm / save /
        // destroy. Idempotent.
        _recBindEvents();
    }
    async function _startParallelTrainingCapture() {
        if (_trainingCapture) return;
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            throw new Error('getUserMedia is not available in this context');
        }
        const constraints = { audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // Request stereo so the channel-select below can pick the
            // user's instrument channel — same as the main capture path.
            channelCount: 2,
        }};
        const selectedDeviceId = getSelectedDeviceId();
        if (selectedDeviceId) {
            constraints.audio.deviceId = { exact: selectedDeviceId };
        }
        let stream;
        try {
            // Share the main capture path's over-constrained fallback so a
            // mono-only interface (Real Tone Cable) or stale saved device
            // can still arm a parallel training take.
            stream = await openInstrumentStream(constraints);
        } catch (e) {
            throw new Error('mic permission denied or device unavailable: ' + (e && e.message || e));
        }
        // The getUserMedia await above can take seconds (permission
        // prompt, device open). If the take was disarmed or the song
        // ended meanwhile, bail and release the mic now — otherwise we'd
        // attach a live capture graph to a cancelled take and leave the
        // device open until some later teardown.
        if (!_recArmed || !_recArmedForTraining) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            return;
        }
        // Build the context + graph inside a try: getUserMedia already
        // handed us a live stream, so if any node creation throws we
        // must stop that stream (and close a half-built context) here —
        // _trainingCapture isn't assigned yet, so _stopParallelTraining-
        // Capture() couldn't otherwise reach the open mic.
        let ctx = null;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            const source = ctx.createMediaStreamSource(stream);
            // ScriptProcessor is deprecated but matches the rest of the
            // plugin's audio paths (AudioWorklet would need a separate
            // worklet file shipped with the plugin). Power-of-two buffer
            // size in {256, 512, 1024, 2048, 4096, 8192, 16384}; 4096 is a
            // ~93ms cadence at 44.1kHz, plenty for capture (we're not doing
            // any latency-sensitive analysis in this path — that's the
            // engine's job).
            const processor = ctx.createScriptProcessor(4096, 1, 1);
            // Push to the same _recChunks as the legacy processFrame path
            // so saveRecordingNow() doesn't need to know which capture path
            // produced the buffer. Gating mirrors the legacy push at
            // line 2316: only push while armed AND the song is playing,
            // so we don't fill the buffer with silence pre-Play.
            const selectedChannel = getSelectedChannel();
            const inputGain       = getInputGain();
            processor.onaudioprocess = (e) => {
                if (!_recArmed || !_recSongPlaying) return;
                const input = e.inputBuffer.getChannelData(0);
                const maxSamples = Math.floor((32 * 1024 * 1024) / 4);
                if (_recTotalSamples >= maxSamples) {
                    if (!_recCappedAt) _recCappedAt = _recTotalSamples / (ctx.sampleRate || 44100);
                    return;
                }
                _recSampleRate = ctx.sampleRate || _recSampleRate;
                // slice() — the underlying buffer is reused next callback.
                const copy = input.slice();
                _recChunks.push(copy);
                _recTotalSamples += copy.length;
            };
            // Mirror the main capture graph (see ~line 1942): channel-select
            // + input gain ahead of the processor, so the training WAV is
            // the SAME signal the detector judged and matches the `channel`
            // / `input_gain` recorded in the manifest. Reading channel 0 of
            // the raw source instead would upload the wrong channel for a
            // right-channel-DI user and skip the user's input gain.
            const gain = ctx.createGain();
            gain.gain.value = inputGain;
            let splitter = null, merger = null;
            if (source.channelCount >= 2 && selectedChannel !== 'mono') {
                splitter = ctx.createChannelSplitter(2);
                merger = ctx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                source.connect(splitter);
                splitter.connect(merger, chIdx, 0);
                merger.connect(gain);
            } else {
                source.connect(gain);
            }
            gain.connect(processor);
            // A ScriptProcessor only fires its onaudioprocess callback if
            // it's connected to the destination graph. Route through a
            // muted GainNode so the captured audio doesn't loop back to
            // speakers (would be a feedback hazard with the JUCE engine
            // also driving output).
            const mute = ctx.createGain();
            mute.gain.value = 0;
            processor.connect(mute);
            mute.connect(ctx.destination);
            _trainingCapture = { stream, ctx, source, splitter, merger, gain, processor, mute };
        } catch (e) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            try { if (ctx) ctx.close(); } catch (_) {}
            throw new Error('training capture graph setup failed: ' + (e && e.message || e));
        }
    }
    function _stopParallelTrainingCapture() {
        if (!_trainingCapture) return;
        const cap = _trainingCapture;
        _trainingCapture = null;
        try { cap.source.disconnect(); } catch (_) {}
        try { if (cap.splitter) cap.splitter.disconnect(); } catch (_) {}
        try { if (cap.merger) cap.merger.disconnect(); } catch (_) {}
        try { if (cap.gain) cap.gain.disconnect(); } catch (_) {}
        try { cap.processor.disconnect(); } catch (_) {}
        try { cap.mute.disconnect(); } catch (_) {}
        try { cap.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        try { cap.ctx.close(); } catch (_) {}
    }
    async function armRecordingForTraining() {
        // Same capture-buffer state reset as armRecording, plus a flag
        // that triggers the bundle-and-upload step on song:ended. Also
        // force-binds the live-judgment stream regardless of tuningMode
        // (the training bundle needs both the WAV and the JSONL).
        _recArmed = true;
        _recArmedForTraining = true;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        // Clear the carried-over session id so _recOnEnded's
        // `_liveSessionId || _liveLastSessionId` fallback can only ever
        // resolve to a session minted DURING this take — never a stale
        // one from a previous take. If this take mints no session at
        // all, the bundle simply ships without a JSONL (soft-skip).
        getDiagCatalog().setLiveLastSessionId(null);
        _recBindEvents();
        getDiagCatalog().liveBindEvents();
        // If the user armed AFTER pressing Play, song:play has already
        // fired and won't fire again: _recSongPlaying never flipped true
        // (so the capture gate at processFrame / _startParallelTraining-
        // Capture would stay idle) and _liveOnPlay never minted a live
        // session (so the JSONL take would carry no session_start
        // header). Detect *active playback* here and replay both effects.
        // A nonzero playhead alone is not enough — a paused or seeked
        // song also has one — so sample the renderer clock twice: only
        // real playback advances it. A genuinely paused song is left
        // alone; its song:play will drive both effects when it resumes.
        const hw = getHw();
        const _t1 = (hw && hw.getTime) ? hw.getTime() : 0;
        await new Promise((r) => setTimeout(r, 150));
        // The await above is a yield point — if the user disarmed during
        // it, bail rather than minting a session / flipping capture
        // state for a take that no longer exists.
        if (!_recArmed || !_recArmedForTraining) return;
        const hw2 = getHw();
        const _t2 = (hw2 && hw2.getTime) ? hw2.getTime() : 0;
        if (_t2 > _t1 + 0.02) {
            _recSongPlaying = true;
            // Mint a FRESH session unconditionally — even if tuning mode
            // already had one running. That older session started at
            // song:play and holds pre-arm judgments; reusing it would
            // misalign the detect-stream with a WAV that starts at arm
            // time. A fresh session begins here, aligned with the take.
            getDiagCatalog().startLiveSession();
        }
        // When the desktop bridge is active, the JS-side processFrame()
        // never runs (native engine owns the device), so its
        // _recChunks.push() at line ~2316 never fires and the WAV
        // would always be empty. Open a parallel getUserMedia chain
        // dedicated to capture — orthogonal to whatever the bridge is
        // doing for detection. In non-bridge mode the legacy
        // processFrame path is already pushing, so a parallel capture
        // would double-push; skip it.
        if (getUsingDesktopBridge()) {
            try {
                await _startParallelTrainingCapture();
            } catch (e) {
                // Roll back the arm so the user isn't left thinking a
                // take is being recorded when it isn't.
                _recArmed = false;
                _recArmedForTraining = false;
                _recLastSaveError = String(e && e.message || e);
                _recUnbindEvents();
                if (!getTuningMode()) getDiagCatalog().liveUnbindEvents();
                console.warn('[note_detect] arm-for-training getUserMedia failed:', e);
                throw e;
            }
        }
    }
    function disarmRecording() {
        // Soft stop: turn capture off but keep the buffer so the user
        // can still Save (or Discard) what they captured. Clearing the
        // buffer here would silently throw away the user's take, which
        // is what they were complaining about. Use discardRecording()
        // when you actually want to wipe.
        _recArmed = false;
        _recArmedForTraining = false;
        _recUnbindEvents();
        // Drop the live stream subscription too, unless tuningMode is
        // independently keeping it on. Mirrors the gate in setTuningMode.
        if (!getTuningMode()) getDiagCatalog().liveUnbindEvents();
        // Release the mic. If the user disarmed mid-take the captured
        // buffer is retained for a manual Save.
        _stopParallelTrainingCapture();
    }
    function discardRecording() {
        _recArmed = false;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        _recUnbindEvents();
        if (!getTuningMode()) getDiagCatalog().liveUnbindEvents();
        _stopParallelTrainingCapture();
    }
    async function saveRecordingNow() {
        if (_recSaveInFlight) return null;
        if (_recChunks.length === 0) {
            _recLastSaveError = 'no audio captured (Detect off, or song never played)';
            return null;
        }
        // Snapshot the buffer (alias, not copy) and disarm so any
        // song:ended fired mid-upload doesn't re-enter this path. We
        // intentionally DO NOT clear _recChunks here — if the POST
        // fails the user keeps their take and can retry via the Save
        // button. Earlier behaviour cleared synchronously, which meant
        // a network error or 413 from the server-side cap silently
        // destroyed a recorded session with no way to recover.
        const chunks = _recChunks;
        const sr = _recSampleRate;
        _recArmed = false;
        _recSaveInFlight = true;
        try {
            const wav = _ndEncodeWavPcm16(chunks, sr);
            const hw = getHw();
            const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
            const slug = ((info.title || 'recording') + '')
                .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'recording';
            const resp = await fetch(
                '/api/plugins/note_detect/recording?slug=' + encodeURIComponent(slug),
                { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }
            );
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
            const data = await resp.json();
            _recLastSavePath = data && data.relative_path || null;
            _recLastSaveError = null;
            // SUCCESS — only NOW clear the buffer, so a failed upload
            // doesn't lose the user's audio. _recCappedAt also resets
            // since the take that was capped has shipped.
            _recChunks = [];
            _recTotalSamples = 0;
            _recCappedAt = null;
            return data;
        } catch (e) {
            _recLastSaveError = String(e && e.message || e);
            console.warn('[note_detect] saveRecording failed:', e);
            // Buffer intentionally left in _recChunks so the user can
            // retry via the Save button after fixing the underlying
            // issue (server restart, larger cap, etc.).
            return null;
        } finally {
            _recSaveInFlight = false;
            // Done with this take — release the song-event listeners.
            _recUnbindEvents();
        }
    }
    function getRecordingState() {
        // Use the cached running total instead of reducing the array —
        // the UI's auto-refresh poll calls this every 1500 ms, and on a
        // long take the reduce was O(n) per call. The cache is
        // maintained in lockstep with `_recChunks` (incremented on
        // push, zeroed on arm/discard/successful-save/destroy).
        const samples = _recTotalSamples;
        return {
            armed:        _recArmed,
            armedForTraining: _recArmedForTraining,
            songPlaying:  _recSongPlaying,
            chunks:       _recChunks.length,
            samples,
            sampleRate:   _recSampleRate,
            durationS:    samples / Math.max(1, _recSampleRate),
            saveInFlight: _recSaveInFlight,
            lastSavePath: _recLastSavePath,
            lastError:    _recLastSaveError,
            // null = no cap hit; otherwise the second-mark where the client-
            // side 32 MB cap kicked in. UI can surface "your take was
            // truncated at X s".
            cappedAtS:    _recCappedAt,
            // Recording requires the audio pipeline to be live — surface
            // it here so the UI can prompt the user to enable Detect.
            detectEnabled: getEnabled(),
            // Training-bundle upload status. inFlight while the bundle
            // POST is round-tripping; result is the last server response
            // ({ok:true, bundle_filename, pcloud_result, ...} or
            // {ok:false, error, local_bundle, ...}). Null between
            // takes — the UI shows nothing in that state.
            trainingUploadInFlight: _recTrainingUploadInFlight,
            trainingUploadResult:   _recTrainingUploadResult,
        };
    }
    // Contributor + per-instrument prefs persisted in localStorage so
    // the upload dialog auto-fills on subsequent takes. Song-specific
    // fields (title, custom song filename, tuning) always come from songInfo,
    // so they're NOT persisted — last song's title would be wrong for
    // the next.
    const _TRAINING_PREFS_KEY = 'nd_training_prefs_v1';
    function _loadTrainingPrefs() {
        try {
            const raw = localStorage.getItem(_TRAINING_PREFS_KEY);
            if (!raw) return { name: '', discord: '', instrument: '', notes: '' };
            const p = JSON.parse(raw) || {};
            return {
                name:       typeof p.name       === 'string' ? p.name       : '',
                discord:    typeof p.discord    === 'string' ? p.discord    : '',
                instrument: typeof p.instrument === 'string' ? p.instrument : '',
                notes:      typeof p.notes      === 'string' ? p.notes      : '',
            };
        } catch (_) {
            return { name: '', discord: '', instrument: '', notes: '' };
        }
    }
    function _saveTrainingPrefs(prefs) {
        try {
            localStorage.setItem(_TRAINING_PREFS_KEY, JSON.stringify({
                name:       prefs.name       || '',
                discord:    prefs.discord    || '',
                instrument: prefs.instrument || '',
                notes:      prefs.notes      || '',
            }));
        } catch (_) { /* ignore quota / privacy mode */ }
    }
    // Modal that gates the upload — surfaces auto-detected song fields
    // for review/edit, captures contributor metadata, and requires an
    // explicit consent checkbox before enabling Upload. Stays open
    // during the upload itself so the user sees an inline progress +
    // success / failure status instead of guessing whether the bundle
    // made it. The `doUpload(formData) → Promise<result>` callback is
    // invoked on submit; the modal flips into "uploading" mode while
    // the promise is pending and then shows a result panel with a
    // Close button. Resolves with the final result (or null on cancel)
    // once the user dismisses the modal. Single-shot: no second
    // instance can mount concurrently.
    let _trainingModalActive = false;
    // doUpload(formData) bundles + uploads a fresh take; doRetry(localBundle)
    // re-uploads an already-bundled zip (shown as a Retry button when the
    // first upload fails). doRetry is optional — omit it to disable retry.
    function _showTrainingConsentModal(prefill, doUpload, doRetry) {
        if (_trainingModalActive) return Promise.resolve(null);
        _trainingModalActive = true;
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'nd-train-modal fixed inset-0 z-[99999] flex items-center justify-center bg-black/70 p-4 overflow-y-auto';
            // Dialog semantics so screen readers announce the modal and
            // treat background content as inert. aria-labelledby points
            // at the <h3> title id set below.
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'nd-tr-title');
            // Restore focus to whatever was focused before the modal
            // opened, once it closes.
            const _prevFocus = document.activeElement;
            // Plain-text inputs only — no HTML interpolation of user-
            // controllable strings to avoid an XSS surface from
            // chart-provided song info or localStorage tampering.
            modal.innerHTML = `
                <div class="bg-dark-700 border border-gray-600 rounded-lg max-w-md w-full p-5 shadow-2xl my-4">
                    <h3 id="nd-tr-title" class="nd-tr-title text-base font-semibold text-gray-100 mb-1">Submit Training Take</h3>
                    <p class="nd-tr-intro text-[11px] text-gray-400 mb-4 leading-snug">
                        Review the details below, then check the consent box to upload your take
                        (audio + detection events + this form) to the training dataset. All fields
                        marked optional can be left blank.
                    </p>

                    <div class="nd-tr-form">
                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Song Name</label>
                        <input class="nd-tr-song w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">custom song File Name</label>
                        <input class="nd-tr-custom-song w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Instrument</label>
                        <select class="nd-tr-instr w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">
                            <option value="guitar">Guitar</option>
                            <option value="bass">Bass</option>
                        </select>

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Tuning</label>
                        <input class="nd-tr-tuning w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Your Name <span class="text-gray-500 normal-case">(optional)</span></label>
                        <input class="nd-tr-name w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Discord Handle <span class="text-gray-500 normal-case">(optional)</span></label>
                        <input class="nd-tr-discord w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Extra Notes <span class="text-gray-500 normal-case">(optional)</span></label>
                        <textarea class="nd-tr-notes w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3" rows="3"></textarea>

                        <label class="flex items-start gap-2 mb-4 cursor-pointer">
                            <input type="checkbox" class="nd-tr-consent mt-0.5">
                            <span class="text-xs text-gray-300 leading-snug">
                                I give permission for this recording to be used for training purposes
                                of the note detection system.
                            </span>
                        </label>
                    </div>

                    <!-- Status line: hidden until the user clicks Upload.
                         Tailwind classes get swapped between info/ok/err
                         palettes by the submit handler below. -->
                    <div class="nd-tr-status hidden text-xs leading-snug mb-4 px-3 py-2 rounded border"></div>

                    <div class="flex gap-2">
                        <button class="nd-tr-cancel flex-1 px-3 py-2 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300">Cancel</button>
                        <button class="nd-tr-retry flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-gray-600 disabled:cursor-not-allowed rounded text-xs font-semibold text-white" style="display:none">Retry upload</button>
                        <button class="nd-tr-submit flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-gray-600 disabled:cursor-not-allowed rounded text-xs font-semibold text-white" disabled>Upload</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const $ = (sel) => modal.querySelector(sel);
            // Set values via .value rather than innerHTML so user-
            // controllable strings can't break out into HTML.
            $('.nd-tr-song').value    = prefill.songName || '';
            $('.nd-tr-custom-song').value    = prefill.cdlcFilename || '';
            $('.nd-tr-instr').value   = (prefill.instrument === 'bass') ? 'bass' : 'guitar';
            $('.nd-tr-tuning').value  = prefill.tuning || '';
            $('.nd-tr-name').value    = prefill.name || '';
            $('.nd-tr-discord').value = prefill.discord || '';
            $('.nd-tr-notes').value   = prefill.notes || '';
            // Move focus into the dialog so keyboard / screen-reader
            // users land inside it rather than on background content.
            try { $('.nd-tr-song').focus(); } catch (_) {}

            const submitBtn  = $('.nd-tr-submit');
            const retryBtn   = $('.nd-tr-retry');
            const cancelBtn  = $('.nd-tr-cancel');
            const consentCb  = $('.nd-tr-consent');
            const statusEl   = $('.nd-tr-status');
            const formEl     = $('.nd-tr-form');
            consentCb.addEventListener('change', () => { submitBtn.disabled = !consentCb.checked; });

            let finalResult = null;
            // Promise of the upload currently in flight (doUpload or
            // doRetry), or null. Closing the modal removes it from view
            // immediately, but the modal Promise MUST NOT resolve until
            // this settles — _uploadTrainingBundle's finally (disarm +
            // live-stream unbind) runs on that resolution, and running
            // it mid-upload stops judgment streaming and lets the take
            // be re-armed while its request is still going.
            let _activeUpload = null;
            const cleanup = () => {
                modal.remove();
                _trainingModalActive = false;
                // Return focus to wherever it was before the modal opened.
                try { if (_prevFocus && _prevFocus.focus) _prevFocus.focus(); } catch (_) {}
                if (_activeUpload) {
                    _activeUpload.finally(() => resolve(finalResult));
                } else {
                    resolve(finalResult);
                }
            };
            const setStatus = (kind, text) => {
                statusEl.classList.remove('hidden');
                statusEl.className = 'nd-tr-status text-xs leading-snug mb-4 px-3 py-2 rounded border ' + ({
                    info: 'bg-blue-900/30 border-blue-700/50 text-blue-200',
                    ok:   'bg-green-900/30 border-green-700/50 text-green-200',
                    err:  'bg-red-900/30 border-red-700/50 text-red-200',
                }[kind] || '');
                statusEl.textContent = text;
            };

            // Render an upload outcome (from the initial Upload or a
            // Retry) into the modal. Success collapses the actions
            // behind a green Close; failure shows a red Close and — when
            // the server retained a local bundle and a retry path was
            // supplied — a Retry button so the user can re-ship without
            // recording the song again.
            const applyResult = (result) => {
                finalResult = result;
                _recTrainingUploadResult = result;
                if (result && result.ok) {
                    setStatus('ok', '✓ Uploaded to the training dataset: ' + (result.bundle_filename || '(file)') + '. Thanks for contributing!');
                    submitBtn.style.display = 'none';
                    retryBtn.style.display = 'none';
                    cancelBtn.textContent = 'Close';
                    cancelBtn.className = 'flex-1 px-3 py-2 bg-green-700 hover:bg-green-600 rounded text-xs font-semibold text-white';
                } else {
                    const errMsg = (result && result.error) ? result.error : 'unknown error';
                    const canRetry = !!(doRetry && result && result.local_bundle);
                    const retained = (result && result.local_bundle)
                        ? ('\nThe local bundle was retained at ' + result.local_bundle
                           + (canRetry ? ' — use Retry below.' : ' — you can retry from there.'))
                        : '';
                    setStatus('err', '✗ Upload failed: ' + errMsg + retained);
                    submitBtn.style.display = 'none';
                    cancelBtn.textContent = 'Close';
                    cancelBtn.className = 'flex-1 px-3 py-2 bg-red-700 hover:bg-red-600 rounded text-xs font-semibold text-white';
                    if (canRetry) {
                        retryBtn.style.display = '';
                        retryBtn.disabled = false;
                        retryBtn._localBundle = result.local_bundle;
                    }
                }
            };

            // Close resolves with whatever the last attempt produced —
            // null before any upload (a genuine cancel), or the success/
            // failure result afterwards so the caller records it.
            cancelBtn.onclick = () => { cleanup(); };
            retryBtn.onclick = async () => {
                const localBundle = retryBtn._localBundle;
                if (!localBundle || !doRetry) return;
                retryBtn.disabled = true;
                retryBtn.textContent = 'Retrying…';
                setStatus('info', "Re-uploading the saved bundle to pCloud — no re-recording needed. Don’t close Slopsmith yet.");
                let result = null;
                const p = doRetry(localBundle);
                _activeUpload = p;
                try {
                    result = await p;
                } catch (e) {
                    result = { ok: false, error: String(e && e.message || e), local_bundle: localBundle };
                } finally {
                    if (_activeUpload === p) _activeUpload = null;
                }
                retryBtn.textContent = 'Retry upload';
                applyResult(result);
            };
            submitBtn.onclick = async () => {
                if (!consentCb.checked) return; // belt-and-braces
                const formData = {
                    songName:     $('.nd-tr-song').value.trim(),
                    cdlcFilename: $('.nd-tr-custom-song').value.trim(),
                    instrument:   $('.nd-tr-instr').value,
                    tuning:       $('.nd-tr-tuning').value.trim(),
                    name:         $('.nd-tr-name').value.trim(),
                    discord:      $('.nd-tr-discord').value.trim(),
                    notes:        $('.nd-tr-notes').value.trim(),
                    consent:      true,
                };
                // Lock the form, swap into uploading mode. The form stays
                // visually present (faded) so the user can still see
                // their entries while the network round-trip is in
                // flight; cancelling at this point doesn't abort the
                // upload but does dismiss the modal.
                formEl.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
                formEl.classList.add('opacity-50', 'pointer-events-none');
                submitBtn.disabled = true;
                submitBtn.textContent = 'Uploading…';
                cancelBtn.textContent = 'Hide';
                setStatus('info', "Bundling the WAV, detect-stream, and manifest, then shipping to pCloud. Don't close Slopsmith yet — this can take a few seconds on a slow uplink.");

                let result = null;
                const p = doUpload(formData);
                _activeUpload = p;
                try {
                    result = await p;
                } catch (e) {
                    result = { ok: false, error: String(e && e.message || e) };
                } finally {
                    if (_activeUpload === p) _activeUpload = null;
                }
                applyResult(result);
            };
            // Esc closes the modal. While uploading, Esc still works (the
            // upload promise resolves into _recTrainingUploadResult, so
            // the result is preserved even if the user dismisses).
            modal.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { e.stopPropagation(); cleanup(); }
            });
        });
    }
    async function _uploadTrainingBundle(savedData, sessionId, songInfoSnapshot, chartSnapshot, audioStats, cdlcFilenameSnapshot) {
        // audioStats pins sample-rate / sample-count / cap at song:ended
        // because saveRecordingNow() zeroes the live counters before this
        // runs. Fall back to the (now-reset) live values defensively.
        audioStats = audioStats || {
            sampleRate: _recSampleRate, totalSamples: _recTotalSamples, cappedAtS: _recCappedAt,
        };
        if (_recTrainingUploadInFlight) return null;
        // Owned by this function: set once here, cleared in the finally
        // on every exit path. _showTrainingConsentModal won't resolve
        // until any in-flight upload settles, so the finally is reached
        // only after the real upload work is done.
        _recTrainingUploadInFlight = true;
        try {
            // Recover the slug from the server-returned filename. The
            // /recording endpoint stamps `note_detect_<slug>_<ts>_<ms>_<suf>.wav`,
            // so parsing once here is cheaper and more robust than
            // mirroring saveRecordingNow's slug derivation (which depends
            // on hw.getSongInfo() being identical at this later moment).
            const filename = (savedData && savedData.filename) || '';
            const m = /^note_detect_(.+?)_\d{8}_\d{6}_\d{3}_[0-9a-f]+\.wav$/.exec(filename);
            if (!m) {
                _recTrainingUploadResult = {
                    ok: false,
                    error: 'could not parse slug from saved filename: ' + filename,
                };
                return null;
            }
            const slug = m[1];

            // Prefer the snapshot pinned at song:ended (the caller in
            // _recOnEnded captures it synchronously). Fall back to a
            // fresh read for any other caller / a direct API invocation
            // where no snapshot was provided.
            const hw = getHw();
            const info = songInfoSnapshot
                || ((hw && hw.getSongInfo) ? hw.getSongInfo() : {});
            // custom song filename: prefer the value pinned at song:ended by
            // the caller (cdlcFilenameSnapshot) — _ndShared.currentFilename
            // is a process-global another splitscreen panel can overwrite
            // before this async upload runs. The direct reads are only a
            // fallback for callers that pinned nothing.
            const cdlcFilename = cdlcFilenameSnapshot
                || info.filename || getCurrentFilename() || '';
            const tuningArr = Array.isArray(info.tuning) ? info.tuning.slice() : null;
            // Guess instrument from the arrangement label — covers
            // "Bass", "Lead", "Rhythm", "Combo", etc. The user can
            // override in the modal if the guess is wrong.
            const arrLower = String(info.arrangement || '').toLowerCase();
            const guessedInstrument = arrLower.includes('bass') ? 'bass' : 'guitar';
            const persisted = _loadTrainingPrefs();

            // The modal stays open during the network round-trip so the
            // user sees an inline progress + result panel. doUpload is
            // invoked once the consent box is checked and Upload is
            // clicked; it returns the parsed server response (or an
            // {ok:false, error, local_bundle} object on failure) which
            // the modal renders into its status line.
            const result = await _showTrainingConsentModal({
                songName:     info.title || '',
                cdlcFilename: cdlcFilename,
                tuning:       tuningArr ? tuningArr.join(', ') : '',
                // Persisted instrument wins over the arrangement guess
                // only if the user has actually set one before — that
                // way a fresh user gets the helpful guess, but a known
                // bassist isn't re-confronted with "Guitar" every time.
                instrument:   persisted.instrument || guessedInstrument,
                name:         persisted.name,
                discord:      persisted.discord,
                notes:        persisted.notes,
            }, async (formData) => {
                // Persist the contributor-level fields for next time.
                // Song fields are intentionally excluded — next song
                // will repopulate them from songInfo.
                _saveTrainingPrefs({
                    name:       formData.name,
                    discord:    formData.discord,
                    instrument: formData.instrument,
                    notes:      formData.notes,
                });

                _recTrainingUploadResult = null;

                const manifest = {
                    // schema, created_at, and resolved audio/detect_stream
                    // refs are filled server-side. Everything below is
                    // the client's contribution.
                    plugin: { id: 'note_detect' },
                    song: {
                        filename:    formData.cdlcFilename || cdlcFilename || null,
                        title:       formData.songName || info.title || null,
                        artist:      info.artist || null,
                        arrangement: info.arrangement || null,
                        arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
                        tuning:       tuningArr,                                // original machine-readable
                        tuning_label: formData.tuning || null,                  // user-editable string
                        instrument:   formData.instrument || guessedInstrument, // 'guitar' | 'bass'
                        capo:         (info.capo != null) ? info.capo : null,
                        format:       info.format || null,
                        duration_s:   (info.duration != null) ? info.duration : null,
                        // The difficulty this take was PLAYED at. arrangement.json
                        // is the filtered chart, so it already matches the audio —
                        // these let a consumer segment the dataset by difficulty
                        // (and spot a reduced take) instead of being blind to it.
                        // has_phrase_data false => the song has no phrase data, so
                        // no filtering was possible and the chart is the full one.
                        mastery:          chartSnapshot ? chartSnapshot.mastery : null,
                        has_phrase_data:  chartSnapshot ? !!chartSnapshot.hasPhraseData : false,
                    },
                    settings: {
                        detection_method:        getDetectionMethod(),
                        av_offset_ms:            Math.round(getLatencyOffset() * 1000),
                        timing_tolerance_ms:     Math.round(getTimingTolerance() * 1000),
                        timing_hit_threshold_ms: Math.round(getTimingHitThreshold() * 1000),
                        pitch_tolerance_cents:   getPitchTolerance(),
                    },
                    audio: {
                        // Pinned at song:ended — saveRecordingNow() has
                        // since reset the live _rec* counters to 0.
                        sample_rate: audioStats.sampleRate,
                        channels:    1,
                        bit_depth:   16,
                        duration_s:  audioStats.totalSamples / Math.max(1, audioStats.sampleRate),
                        capped_at_s: audioStats.cappedAtS,
                    },
                    client: {
                        user_agent: navigator.userAgent,
                        platform:   navigator.platform || null,
                        timestamp_local: new Date().toISOString(),
                    },
                    contributor: {
                        name:    formData.name    || null,
                        discord: formData.discord || null,
                        consent: true,
                        consent_text: 'I give permission for this recording to be used for training purposes of the note detection system.',
                        consent_at:   new Date().toISOString(),
                    },
                    notes: formData.notes || null,
                };

                // Read the user-configurable upload URL from the
                // settings.html field's localStorage key. Empty / missing
                // leaves it null so the server falls back to its own
                // hardcoded default. Mirrors the storage key + semantics
                // in settings.html.
                let uploadUrl = null;
                try { uploadUrl = localStorage.getItem('nd_training_upload_url') || null; } catch (_) {}

                // Drain any in-flight /live-judgment POSTs first — the
                // server zips whatever live_<id>.jsonl is on disk when
                // /training-bundle runs, so unflushed judgments (or the
                // session header) would be missing from the bundle.
                await getDiagCatalog().flushLiveJudgments();

                try {
                    const resp = await fetch('/api/plugins/note_detect/training-bundle', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            slug,
                            // Exact WAV filename from the /recording save —
                            // lets the server bundle THIS take's WAV rather
                            // than glob the newest for the slug (wrong WAV
                            // under concurrent same-slug takes).
                            wav_filename: filename || null,
                            // Null (not 'default') when this take minted no
                            // live session — the server soft-skips the JSONL
                            // instead of attaching a stale live_default.jsonl.
                            session: sessionId || null,
                            manifest,
                            // Ground-truth note chart (hw.getNotes/getChords
                            // pinned at song:ended) — the server writes it
                            // into the bundle as arrangement.json. null when
                            // the host exposed no chart.
                            arrangement: chartSnapshot
                                ? { notes: chartSnapshot.notes, chords: chartSnapshot.chords }
                                : null,
                            upload_url: uploadUrl,
                        }),
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (_) { /* leave null; surfaced below */ }
                    if (!resp.ok) {
                        const errStr = (data && (data.detail || data.error)) || resp.statusText;
                        const out = { ok: false, error: `HTTP ${resp.status}: ${errStr}`, local_bundle: data && data.local_bundle || null };
                        _recTrainingUploadResult = out;
                        return out;
                    }
                    _recTrainingUploadResult = data;
                    return data;
                } catch (e) {
                    const out = { ok: false, error: String(e && e.message || e) };
                    _recTrainingUploadResult = out;
                    console.warn('[note_detect] training-bundle upload failed:', e);
                    return out;
                }
            }, async (localBundle) => {
                // Retry path: re-upload the zip already on disk (no
                // re-bundling). The server confines `local_bundle` to
                // the recordings directory, so passing the path back is
                // safe. Honours the same per-user upload-URL override.
                let uploadUrl = null;
                try { uploadUrl = localStorage.getItem('nd_training_upload_url') || null; } catch (_) {}
                try {
                    const resp = await fetch('/api/plugins/note_detect/training-bundle/retry', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ local_bundle: localBundle, upload_url: uploadUrl }),
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (_) { /* leave null; surfaced below */ }
                    if (!resp.ok) {
                        const errStr = (data && (data.detail || data.error)) || resp.statusText;
                        const out = { ok: false, error: `HTTP ${resp.status}: ${errStr}`, local_bundle: (data && data.local_bundle) || localBundle };
                        _recTrainingUploadResult = out;
                        return out;
                    }
                    _recTrainingUploadResult = data;
                    return data;
                } catch (e) {
                    const out = { ok: false, error: String(e && e.message || e), local_bundle: localBundle };
                    _recTrainingUploadResult = out;
                    console.warn('[note_detect] training-bundle retry failed:', e);
                    return out;
                }
            });
            if (!result) {
                // User cancelled before submitting — no upload attempted.
                _recTrainingUploadResult = {
                    ok: false,
                    error: 'cancelled — bundle not uploaded',
                    local_bundle: null,
                };
            }
            return _recTrainingUploadResult;
        } catch (e) {
            _recTrainingUploadResult = { ok: false, error: String(e && e.message || e) };
            console.warn('[note_detect] training-bundle flow failed:', e);
            return null;
        } finally {
            // Clear the in-flight flag on EVERY exit path — including
            // the early returns above (e.g. slug-parse failure) that
            // never opened the modal. Safe to clear here because
            // _showTrainingConsentModal defers its resolution until any
            // in-flight upload settles (see _activeUpload), so this
            // finally never runs mid-upload.
            //
            // Training-arm teardown (_recArmedForTraining / live-stream
            // unbind) is NOT done here — _recOnEnded's own finally owns
            // it, so the teardown also runs when a failed WAV save means
            // this function was never called.
            _recTrainingUploadInFlight = false;
        }
    }

    // Wire song-play / song-end events on the slopsmith bus so an armed
    // recording auto-arms on Play and auto-saves on song-end. Mirrors
    // the drill-mode binding pattern: bind once at construct, tear down
    // in destroy(). The handlers are no-ops while `_recArmed` is false.
    let _recOnPlay = null, _recOnPause = null, _recOnEnded = null;
    let _recSubscribed = false;
    function _recBindEvents() {
        if (_recSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        _recOnPlay  = () => { _recSongPlaying = true; };
        _recOnPause = () => { _recSongPlaying = false; };
        _recOnEnded = () => {
            _recSongPlaying = false;
            if (_recArmed && _recChunks.length > 0) {
                // Capture training intent + session id + songInfo
                // SYNCHRONOUSLY. _liveOnEnded (registered separately)
                // nulls _liveSessionId on the same event, and by the
                // time the async save+upload chain runs the user may
                // have navigated back to the library — at which point
                // hw.getSongInfo() returns {} and the upload modal
                // would show empty Song Name / custom song filename / Tuning.
                // Pin all of it here.
                const shouldUpload = _recArmedForTraining;
                // _liveSessionId may already be null here: _liveOnEnded
                // (bound by tuning mode, often BEFORE _recBindEvents ran)
                // clears it on this same song:ended. _liveLastSessionId
                // survives song:ended, so it's the reliable handle for
                // locating this take's live_<id>.jsonl detect-stream.
                const diagCatalog = getDiagCatalog();
                const sessionAtEnd = diagCatalog.getLiveSessionId() || diagCatalog.getLiveLastSessionId();
                const hw = getHw();
                const songInfoAtEnd = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
                // Pin the custom song filename HERE too. _ndShared.currentFilename
                // is a process-global the playSong wrapper overwrites, so
                // a splitscreen panel starting another song before this
                // take's async upload runs would otherwise leak the wrong
                // filename into this manifest. songInfo wins; the global
                // is only the fallback, and must be read now, not later.
                const cdlcFilenameAtEnd =
                    (songInfoAtEnd && songInfoAtEnd.filename)
                    || getCurrentFilename() || '';
                // Pinned at song:ended — getNotes()/getChords() return {} once the
                // user navigates away, same as getSongInfo(). Filtered + mastery —
                // see _ndTrainingChartSnapshot for why.
                const chartAtEnd = getTrainingChartSnapshot();
                // Pin the audio counters too — saveRecordingNow() resets
                // _recTotalSamples / _recCappedAt once the WAV POST
                // succeeds, and that runs before _uploadTrainingBundle
                // builds the manifest, so reading them later yields
                // duration_s 0 and a lost cap marker.
                const audioStatsAtEnd = {
                    sampleRate:    _recSampleRate,
                    totalSamples:  _recTotalSamples,
                    cappedAtS:     _recCappedAt,
                };
                // Fire-and-forget — the UI polls getRecordingState() so
                // it'll surface the lastSavePath / lastError when it lands.
                saveRecordingNow().then((data) => {
                    // Save has the bytes; release the mic now even if
                    // an upload is still pending (which uses the bytes
                    // already in _recChunks / on disk).
                    _stopParallelTrainingCapture();
                    if (data && shouldUpload) {
                        return _uploadTrainingBundle(data, sessionAtEnd, songInfoAtEnd, chartAtEnd, audioStatsAtEnd, cdlcFilenameAtEnd);
                    }
                }).catch(() => { _stopParallelTrainingCapture(); }).finally(() => {
                    // The training take is over — drop ALL arm state
                    // HERE, on every path. saveRecordingNow() unbinds the
                    // song listeners in its own finally regardless of
                    // success, so leaving _recArmed true on a failed save
                    // would strand the UI "armed" with no song:play/ended
                    // handlers. A failed WAV save also skips
                    // _uploadTrainingBundle entirely, so relying on its
                    // finally would leave training mode stuck on.
                    _recArmed = false;
                    _recArmedForTraining = false;
                    if (!getTuningMode()) getDiagCatalog().liveUnbindEvents();
                    // Surface the score summary that _endOfSongOnEnded
                    // deferred — now that the consent modal (if any) has
                    // closed. No-op when nothing was deferred.
                    getSummaryUi().runDeferredSummary();
                });
            } else if (_recArmed) {
                // Armed but never captured anything (Detect was off, or
                // song:play never fired). Disarm + release the bus
                // listeners so the next song doesn't start an unintended
                // recording and we don't keep flipping _recSongPlaying.
                _recArmed = false;
                _recArmedForTraining = false;
                _recLastSaveError = 'no audio captured before song:ended';
                _recUnbindEvents();
                // Also drop the training-only live-stream subscription
                // armRecordingForTraining() force-bound — otherwise, with
                // tuning mode off, later songs keep minting/posting live
                // sessions for a take that no longer exists.
                if (!getTuningMode()) getDiagCatalog().liveUnbindEvents();
                _stopParallelTrainingCapture();
                // No upload modal will open — release any deferred
                // summary immediately.
                getSummaryUi().runDeferredSummary();
            }
        };
        try {
            window.slopsmith.on('song:play',  _recOnPlay);
            window.slopsmith.on('song:pause', _recOnPause);
            window.slopsmith.on('song:ended', _recOnEnded);
        } catch (e) {
            // Partial registration — unwind to avoid leaking handlers.
            try { window.slopsmith.off('song:play',  _recOnPlay); }  catch (_) {}
            try { window.slopsmith.off('song:pause', _recOnPause); } catch (_) {}
            try { window.slopsmith.off('song:ended', _recOnEnded); } catch (_) {}
            _recOnPlay = _recOnPause = _recOnEnded = null;
            return;
        }
        _recSubscribed = true;
    }
    function _recUnbindEvents() {
        if (!_recSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_recOnPlay)  { try { window.slopsmith.off('song:play',  _recOnPlay); }  catch (e) {} }
            if (_recOnPause) { try { window.slopsmith.off('song:pause', _recOnPause); } catch (e) {} }
            if (_recOnEnded) { try { window.slopsmith.off('song:ended', _recOnEnded); } catch (e) {} }
        }
        _recOnPlay = _recOnPause = _recOnEnded = null;
        _recSubscribed = false;
    }

    // ── Auto-record every play ────────────────────────────────────────────────
    // Capture every play for later analysis (the teaching-tool goal),
    // not just deliberate dev/tuning takes. On song:loaded, arm the
    // upcoming play so it rides the existing capture + song:ended
    // auto-save path — no manual Arm. Gated to:
    //   • the default singleton (isDefault) — so split-screen panels
    //     don't each save their own WAV, and the test instances
    //     (always isDefault:false) never bind an extra song:ended
    //     listener that would break the listener-count assertions;
    //   • `autoRecord` being on (user opt-out) and `detectPreference`
    //     (Detect on — capture taps the detector's input graph, so an
    //     armed-without-Detect take captures nothing).
    // A song stopped mid-play doesn't emit song:ended (stopAudio), so a
    // prior take can still be armed when the next song loads. Flush it
    // first — save if it caught audio, else discard — so two songs never
    // bleed into one WAV. saveRecordingNow() encodes the WAV
    // synchronously before its await and only unbinds in its finally, so
    // we must await it before re-arming or the new take loses its
    // listeners. A deliberate training take (_recArmedForTraining) is
    // left untouched.
    let _autoRecOnLoaded = null, _autoRecOnPause = null, _autoRecOnPlay = null;
    // Minimum captured seconds before a pause auto-saves — so a brief
    // pause mid-song (tweaking a setting, then resuming) doesn't spew a
    // string of tiny fragment WAVs.
    const _AUTO_REC_MIN_PAUSE_SAVE_S = 3;
    function _bindAutoRecord() {
        if (!isDefault || _autoRecOnLoaded) return;
        if (!window.slopsmith || typeof window.slopsmith.on !== 'function') return;
        // New song loaded → flush any take stranded by a stop (no
        // song:ended) so two songs don't bleed into one WAV, then arm
        // the upcoming play.
        _autoRecOnLoaded = async () => {
            if (!getAutoRecord() || !getDetectPreference()) return;
            if (_recArmedForTraining) return;
            // A prior pause/end save that FAILED disarms but keeps _recChunks
            // (retained for a manual retry). With nothing armed we'd otherwise
            // fall through to armRecording(), which wipes that preserved take
            // and its error — bail and leave it intact for the retry.
            if (!_recArmed && _recChunks.length > 0) return;
            if (_recArmed) {
                if (_recChunks.length > 0) {
                    // saveRecordingNow() returns null and KEEPS _recChunks
                    // on upload failure so the take can be retried via the
                    // Save button. armRecording() below clears _recChunks /
                    // _recLastSaveError, so a failed save here would silently
                    // destroy the stranded take — bail and leave it intact.
                    const saved = await saveRecordingNow().catch(() => null);
                    if (!saved && _recChunks.length > 0) return;
                } else {
                    discardRecording();
                }
            }
            armRecording();
        };
        // Pause = "done with this take" for the short-take workflow
        // (play a bit, stop, harness it). Save it — saveRecordingNow()
        // disarms; the next song:play re-arms a fresh take. Gated on a
        // minimum length so a resume-after-a-blip doesn't spam fragments.
        _autoRecOnPause = () => {
            if (!getAutoRecord() || _recArmedForTraining || !_recArmed) return;
            const secs = _recTotalSamples / Math.max(1, _recSampleRate);
            if (_recChunks.length > 0 && secs >= _AUTO_REC_MIN_PAUSE_SAVE_S) {
                saveRecordingNow().catch(() => {});
            }
        };
        // Re-arm on play when nothing's armed — covers resume after a
        // pause-save, and a play not preceded by a fresh song:loaded.
        // armRecording() binds its own _recOnPlay AFTER this play event
        // already fired, so set _recSongPlaying here or the first frames
        // of the resumed take wouldn't be captured.
        _autoRecOnPlay = () => {
            // _recChunks.length > 0 with nothing armed means a save failed and
            // the take is preserved for retry; don't re-arm over it (armRecording
            // would wipe the buffer and the error).
            if (!getAutoRecord() || !getDetectPreference() || _recArmedForTraining || _recArmed || _recChunks.length > 0) return;
            armRecording();
            _recSongPlaying = true;
        };
        try {
            window.slopsmith.on('song:loaded', _autoRecOnLoaded);
            window.slopsmith.on('song:pause',  _autoRecOnPause);
            window.slopsmith.on('song:play',   _autoRecOnPlay);
        } catch (_) { _unbindAutoRecord(); }
    }
    function _unbindAutoRecord() {
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_autoRecOnLoaded) { try { window.slopsmith.off('song:loaded', _autoRecOnLoaded); } catch (_) {} }
            if (_autoRecOnPause)  { try { window.slopsmith.off('song:pause',  _autoRecOnPause); } catch (_) {} }
            if (_autoRecOnPlay)   { try { window.slopsmith.off('song:play',   _autoRecOnPlay); } catch (_) {} }
        }
        _autoRecOnLoaded = _autoRecOnPause = _autoRecOnPlay = null;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    function _destroy() {
        _recUnbindEvents();
        _unbindAutoRecord();
        // Discard any unsaved recording state — destroying the instance
        // shouldn't write a half-captured WAV (or fire off an upload).
        _recArmed = false;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recTrainingUploadResult = null;
        _stopParallelTrainingCapture();
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        // processFrame tap — called each audio frame when armed
        isArmed:              () => _recArmed,
        isArmedOrTraining:    () => !!(_recArmed || _recArmedForTraining),
        hasPendingBuffer:     () => _recChunks.length > 0,
        getRecArmedForTraining: () => _recArmedForTraining,
        pushFrame,
        // commands
        armRecording,
        armRecordingForTraining,
        disarmRecording,
        discardRecording,
        saveRecordingNow,
        getRecordingState,
        // lifecycle
        bindAutoRecord:   _bindAutoRecord,
        unbindAutoRecord: _unbindAutoRecord,
        destroy:          _destroy,
        // test hook — injects a synthetic audio frame so saved-buffer-preservation
        // paths are testable without a live AudioContext. Production never calls this.
        injectChunkForTest: (n = 128) => {
            const f = new Float32Array(n);
            _recChunks.push(f);
            _recTotalSamples += f.length;
        },
    };
}
