/**
 * audio-pipeline.js — nd-carve-10
 *
 * Audio acquisition and per-frame processing subsystem.
 * Manages startAudio (bridge or getUserMedia/AudioContext), stopAudio,
 * level meters, and processFrame (YIN/HPS/CREPE → matchNotes).
 *
 * All mutable factory state lives in main.js. This module reads it via
 * live-accessor functions (getX) and writes back via callback functions
 * (setX / incrX). Static construction-time values are captured at
 * construction. See the LIVE-ACCESSOR RULE (nd-carve contract).
 *
 * Public API:
 *   startAudio()                async → bool
 *   stopAudio()                 sync
 *   applyInputGain(v)           sync — seam for applySettings gainNode write
 *   startLevelMeter()
 *   stopLevelMeter()
 *   startBridgeLevelMeter(desktop)
 *   stopBridgeLevelMeter()
 *   processFrame(buffer)        async
 *   getCbAge()                  ms since last onaudioprocess — scoring watchdog
 *   getMaxCbGapMs()             worst inter-callback gap — scoring watchdog
 *   resetMaxCbGap()             reset starvation gauge on play-start
 */
export function createAudioPipeline({
    // ── Live accessors (read at call time — never captured) ─────────────
    getEnabled,
    getCurrentArrangement,
    getDetectionConfidenceMin,
    getNativeDetection,
    getFrameSize,
    getAutoEnableTrial,
    getInputGain,
    getSelectedChannel,
    getSelectedDeviceId,
    getSessionGen,
    getSourceId,
    getNdUsingEngineVerifier,
    getNdHostChartSuspended,
    getNdOtherOwnsOurSlot,
    getNdVerifierChartSig,
    getNdVerifyTarget,      // () => _verifyTarget (may be null)
    getInputLost,           // () => _inputLost — idempotency guard in markLost

    // ── Write-back callbacks ─────────────────────────────────────────────
    setUsingDesktopBridge,
    setBridgeDesktop,
    setAudioCtx,
    setStream,
    setInputLevel,
    // (incrSessionGen not needed — sessionGen++ stays in restartAudio/disable in main.js)
    setInputPeak,
    setBridgeSampleRate,
    setNdUsingEngineVerifier,
    setUsingNativeFrames,
    setDetectedMidi,
    setDetectedConfidence,
    setDetectedString,
    setDetectedFret,
    setDetectedDisplayMidi,
    setBridgeLevelsUnavailable,
    setInputLost,
    setHealthTrack,
    setSourceId,
    setNdOwnsSource,
    resetVerifierState,         // () — clears _ndVerifier* Maps in main.js
    onCbHeartbeat,              // (now, gap) — updates _lastAudioCbT/_maxCbGapMs in main.js
    pushRescueBuf,              // (newBuf, newEndT) — bass rescue buffer write-back
    resetLevelSamples,          // () — ndLevelSamples.length = 0

    // ── Shared mutable array (main.js owns; matchNotes reads directly) ───
    ndLevelSamples,

    // ── Stable refs (never reassigned after construction) ────────────────
    matchNotes,
    diagCatalog,
    recCapture,
    avCal,
    settingsPanel,
    openInstrumentStream,
    ndOpenSelectedInputSource,
    ndSyncMlGate, ndGateToken,
    ndDesktopSourceApiReady, ndFlushOrphanSources, ndOrphanSourceIds,
    ndPushChartToBridge, ndDrainEngineVerdicts,
    ndBridgeRawAudioFrame, ndBridgeRawPitch, ndBridgeRawFramesAvailable,
    ndBridgePitch, ndBridgeAudio, ndApplyVerifierOffset,
    ndWantOwnSource, ndChannelIndex, ndDeviceKey, ndTryFreeSource,
    ndMinAnalysisSamples, ndEffectiveDetectionMethod, ndFreqToMidi,
    ndYinDetect, ndHpsDetect, ndCrepeDetect, ndShared, ndUpdateMlGate,
    ndChartSignature, setNdVerifierChartSig,
    runVerifyTarget,
    hw,
    externalStream,
    externalAudioCtx,
    optsSourceId,               // opts.sourceId at construction (number|undefined)
    ND_AUDIO_REQUESTER,
    ND_LEVEL_HISTORY_S,
    RESCUE_BUF_MAX,
    updateButton,
    onStreamHealthRestart,      // () — calls restartAudio() in main.js
}) {
    const ownsStream   = !externalStream;
    const ownsAudioCtx = !externalAudioCtx;

    // ── Module-internal state ────────────────────────────────────────────
    let gainNode      = null;
    let sourceNode    = null;
    let splitterNode  = null;
    let mergerNode    = null;
    let levelAnalyser = null;
    let worklet       = null;

    let accumBuffer  = new Float32Array(0);
    let pendingBuffer = null;

    let detectInterval   = null;
    let bridgeLevelTimer = null;
    let levelRaf         = null;
    let processingFrame  = false;

    // bridge onset tracking (reset on stopAudio)
    let bridgeMlActive      = false;
    let bridgeNewOnsets     = new Map();
    let bridgeOnsetSeqSeen  = new Map();
    let bridgeOnsetPrimed   = false;

    // stream health
    let _healthHandlers   = null;
    let _lastInputRecover = 0;

    // cb timing stats (exposed to scoring watchdog via getCbAge/getMaxCbGapMs)
    let _lastAudioCbT = 0;
    let _maxCbGapMs   = 0;

    // local inputPeak mirror — needed to compute decay without a read-back accessor
    let _localInputPeak = 0;
    let _peakDecay      = 0;

    // local bridge flags mirrored for in-module use in processFrame
    let _usingBridge_      = false;
    let _usingNativeFrames = false;

    // local audioCtx and bridgeSampleRate refs (stable within a session)
    let _audioCtxRef        = null;
    let _bridgeSampleRateRef = 48000;

    // local stream ref for teardown in stopAudio
    let _streamRef = null;

    // mirror of _ndOwnsSource for the bridge source-management re-bind logic
    let _localOwnsSource = false;

    // under-buffer warning latch (reset per session)
    let _underBufferWarned = false;

    // ── Stream health ─────────────────────────────────────────────────────
    function _unbindStreamHealth() {
        if (!_healthHandlers) return;
        const { track, ended, mute, unmute } = _healthHandlers;
        try {
            track.removeEventListener('ended', ended);
            track.removeEventListener('mute', mute);
            track.removeEventListener('unmute', unmute);
        } catch (_) {}
        _healthHandlers = null;
    }

    function _bindStreamHealth(s) {
        if (!s || typeof s.getAudioTracks !== 'function') return;
        const track = s.getAudioTracks()[0];
        if (!track) return;
        _unbindStreamHealth();
        setHealthTrack(track);
        const markLost = (why) => {
            if (getInputLost() || !getEnabled()) return;
            setInputLost(true);
            console.warn(`[note_detect] input ${why} — the audio interface dropped the input stream`);
            try { updateButton(); } catch (_) {}
            setTimeout(() => {
                if (!getEnabled() || !getInputLost()) return;
                const now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
                if (now - _lastInputRecover < 4000) return;
                _lastInputRecover = now;
                console.warn('[note_detect] re-acquiring input after drop');
                try { onStreamHealthRestart(); } catch (_) {}
            }, 1500);
        };
        const onEnded  = () => markLost('ended');
        const onMute   = () => markLost('muted');
        const onUnmute = () => {
            if (!getInputLost()) return;
            setInputLost(false);
            try { updateButton(); } catch (_) {}
        };
        try {
            track.addEventListener('ended', onEnded);
            track.addEventListener('mute', onMute);
            track.addEventListener('unmute', onUnmute);
            _healthHandlers = { track, ended: onEnded, mute: onMute, unmute: onUnmute };
        } catch (_) {}
    }

    // ── Shared peak update ────────────────────────────────────────────────
    function _applyPeak(newLevel) {
        if (newLevel > _localInputPeak) {
            _localInputPeak = newLevel;
            _peakDecay = 30;
        } else if (_peakDecay > 0) {
            _peakDecay--;
        } else {
            _localInputPeak *= 0.95;
        }
        setInputPeak(_localInputPeak);
    }

    // ── Level meters ──────────────────────────────────────────────────────
    function stopBridgeLevelMeter() {
        if (bridgeLevelTimer) { clearInterval(bridgeLevelTimer); bridgeLevelTimer = null; }
    }

    function startBridgeLevelMeter(desktop) {
        stopBridgeLevelMeter();
        if (!desktop || !desktop.audio) return;
        if (typeof desktop.audio.getLevels !== 'function') {
            setBridgeLevelsUnavailable(true);
            return;
        }
        setBridgeLevelsUnavailable(false);
        let levelsInFlight = false;
        bridgeLevelTimer = setInterval(async () => {
            if (!getEnabled() || !_usingBridge_ || levelsInFlight) return;
            levelsInFlight = true;
            try {
                const sourceId = getSourceId();
                let levels;
                if (sourceId != null && sourceId !== 0) {
                    if (typeof desktop.audio.getSourceLevels !== 'function') {
                        setBridgeLevelsUnavailable(true);
                        resetLevelSamples();
                        return;
                    }
                    levels = await desktop.audio.getSourceLevels(sourceId);
                } else {
                    levels = await desktop.audio.getLevels();
                }
                if (!getEnabled() || !_usingBridge_) return;
                if (!levels) return;
                const rawLevel = Number.isFinite(levels.inputLevel) ? levels.inputLevel : 0;
                const lvl = Math.min(1, Math.max(0, rawLevel));
                setInputLevel(lvl);
                if (hw && typeof hw.getTime === 'function') {
                    const avO = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
                    const songT = hw.getTime() + avO;
                    const last = ndLevelSamples.length
                        ? ndLevelSamples[ndLevelSamples.length - 1].songT
                        : -Infinity;
                    if (songT < last - 0.05) resetLevelSamples();
                    ndLevelSamples.push({ songT, level: lvl });
                    const cutoff = songT - ND_LEVEL_HISTORY_S;
                    while (ndLevelSamples.length > 0 && ndLevelSamples[0].songT < cutoff) ndLevelSamples.shift();
                    while (ndLevelSamples.length > 240) ndLevelSamples.shift();
                }
                const rawPeak = Number.isFinite(levels.inputPeak) ? levels.inputPeak : lvl;
                _applyPeak(Math.min(1, Math.max(0, rawPeak)));
                settingsPanel.drawSettingsVU();
            } catch (_) {}
            finally { levelsInFlight = false; }
        }, 50);
    }

    function stopLevelMeter() {
        if (levelRaf) { cancelAnimationFrame(levelRaf); levelRaf = null; }
    }

    function startLevelMeter() {
        stopLevelMeter();
        let levelBuf     = null;
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
            const lvl = Math.min(1, Math.sqrt(sum / levelBuf.length) * 5);
            setInputLevel(lvl);
            _applyPeak(lvl);
            settingsPanel.drawSettingsVU();
            levelRaf = requestAnimationFrame(tick);
        };
        levelRaf = requestAnimationFrame(tick);
    }

    // ── processFrame ──────────────────────────────────────────────────────
    async function processFrame(buffer) {
        // Bass rescue buffer — write-back so checkMisses (main.js) can access it
        if (getCurrentArrangement() === 'bass' && buffer && buffer.length) {
            const keep = Math.min(RESCUE_BUF_MAX, _rescueBuf.length + buffer.length);
            const nb = new Float32Array(keep);
            const fromBuf = Math.min(buffer.length, keep);
            nb.set(buffer.subarray(buffer.length - fromBuf), keep - fromBuf);
            const remain = keep - fromBuf;
            if (remain > 0) nb.set(_rescueBuf.subarray(_rescueBuf.length - remain), 0);
            _rescueBuf = nb;
            const hwTime = (hw && hw.getTime) ? hw.getTime() : 0;
            pushRescueBuf(_rescueBuf, hwTime);
        }

        // Browser-path level samples (bridge path uses startBridgeLevelMeter)
        if (!_usingBridge_ && buffer && buffer.length && hw && typeof hw.getTime === 'function') {
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
            const lvl = Math.min(1, Math.max(0, Math.sqrt(sum / buffer.length) * 5));
            const avO = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
            const songT = hw.getTime() + avO;
            const last = ndLevelSamples.length ? ndLevelSamples[ndLevelSamples.length - 1].songT : -Infinity;
            if (songT < last - 0.05) resetLevelSamples();
            ndLevelSamples.push({ songT, level: lvl });
            const cutoff = songT - ND_LEVEL_HISTORY_S;
            while (ndLevelSamples.length > 0 && ndLevelSamples[0].songT < cutoff) ndLevelSamples.shift();
            while (ndLevelSamples.length > 240) ndLevelSamples.shift();
        }

        let result;
        let detectorUsed;
        const gen = getSessionGen();
        const sr = _audioCtxRef ? _audioCtxRef.sampleRate : _bridgeSampleRateRef;
        const activeMethod = ndEffectiveDetectionMethod();
        const confMin = getDetectionConfidenceMin();

        switch (activeMethod) {
            case 'crepe':
                if (ndShared.model) {
                    result = await ndCrepeDetect(buffer);
                    detectorUsed = 'crepe';
                    if (result.freq <= 0 || result.confidence < confMin) {
                        result = ndYinDetect(buffer, sr);
                        detectorUsed = 'yin';
                    }
                    break;
                }
                result = ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
                break;
            case 'hps':
                result = ndHpsDetect(buffer, sr);
                detectorUsed = 'hps';
                break;
            case 'yin':
            default:
                result = ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
        }

        if (!getEnabled() || gen !== getSessionGen()) return;

        if (result.freq <= 0 || result.confidence < confMin) {
            if (result.underBuffered && !_underBufferWarned) {
                console.warn(`[note_detect] ${detectorUsed} received an undersized buffer — low-frequency (bass) notes will drop silently. Check the frame accumulation path.`);
                _underBufferWarned = true;
            }
            setDetectedMidi(-1);
            setDetectedConfidence(0);
            setDetectedString(-1);
            setDetectedFret(-1);
            setDetectedDisplayMidi(-1);
        } else {
            setDetectedMidi(ndFreqToMidi(result.freq));
            setDetectedConfidence(result.confidence);
        }

        diagCatalog.setDiagDetector(_usingNativeFrames
            ? { desktop_bridge: true,  ml: false, path: 'desktop-native-' + (detectorUsed || activeMethod) }
            : { desktop_bridge: false, ml: false, path: 'web-' + (detectorUsed || activeMethod) });

        await matchNotes(buffer);

        if (recCapture.isArmed()) {
            recCapture.pushFrame(buffer, _audioCtxRef ? _audioCtxRef.sampleRate : (_bridgeSampleRateRef || 44100));
        }
    }

    // Internal bass rescue buf (module-local accumulation; pushed to main.js via write-back)
    let _rescueBuf = new Float32Array(0);

    // ── startAudio ────────────────────────────────────────────────────────
    async function startAudio() {
        try {
            const desktop = (typeof window !== 'undefined') ? window.feedBackDesktop : null;
            const canUseDesktopBridge = !externalStream && !externalAudioCtx
                && desktop && desktop.isDesktop
                && desktop.audio
                && typeof desktop.audio.getPitchDetection === 'function'
                && typeof desktop.audio.isAvailable === 'function';

            if (canUseDesktopBridge) {
                let bridgeReady = false;
                try { bridgeReady = await desktop.audio.isAvailable(); } catch (_) {}

                if (bridgeReady) {
                    await ndOpenSelectedInputSource(ND_AUDIO_REQUESTER, 'note-detection');

                    try {
                        const running = typeof desktop.audio.isAudioRunning === 'function'
                            ? await desktop.audio.isAudioRunning() : false;
                        if (!running && typeof desktop.audio.startAudio === 'function') {
                            await desktop.audio.startAudio();
                        }
                    } catch (_) {}

                    _usingBridge_ = true;
                    setUsingDesktopBridge(true);
                    setBridgeDesktop(desktop);
                    accumBuffer = new Float32Array(0);

                    if (ndDesktopSourceApiReady(desktop.audio)) {
                        ndFlushOrphanSources();
                        // Re-bind a caller-managed sourceId cleared during a prior degraded enable
                        if (getSourceId() == null && !_localOwnsSource
                            && typeof optsSourceId === 'number' && optsSourceId >= 0) {
                            setSourceId(optsSourceId);
                        }
                        if (ndWantOwnSource && getSourceId() == null
                            && typeof desktop.audio.addSource === 'function') {
                            try {
                                const id = await desktop.audio.addSource(ndChannelIndex, ndDeviceKey);
                                if (typeof id === 'number' && id >= 0) {
                                    setSourceId(id);
                                    _localOwnsSource = true;
                                    setNdOwnsSource(true);
                                }
                            } catch (_) {}
                        }
                        const sid = getSourceId();
                        if (sid != null && sid !== 0 && typeof desktop.audio.setSourceInputChannel === 'function') {
                            try { desktop.audio.setSourceInputChannel(sid, ndChannelIndex); } catch (_) {}
                        }
                        if (getSourceId() != null) ndApplyVerifierOffset();
                    } else if (getSourceId() != null) {
                        if (!_localOwnsSource) {
                            console.warn('[note_detect] desktop addon lacks the source-indexed '
                                + 'scoring API; ignoring opts.sourceId and using the default input');
                        } else if (!ndTryFreeSource(getSourceId())) {
                            ndOrphanSourceIds.push(getSourceId());
                        }
                        setSourceId(null);
                        _localOwnsSource = false;
                        setNdOwnsSource(false);
                    }

                    bridgeMlActive = false;
                    if (typeof desktop.audio.isMlNoteDetection === 'function') {
                        try { bridgeMlActive = (await desktop.audio.isMlNoteDetection()) === true; } catch (_) {}
                    }
                    console.log(`[note_detect] desktop bridge active — ML detection: ${bridgeMlActive ? 'ON' : 'OFF (YIN fallback)'}`);

                    _bridgeSampleRateRef = 48000;
                    setBridgeSampleRate(48000);
                    if (typeof desktop.audio.getSampleRate === 'function') {
                        try {
                            const sr = await desktop.audio.getSampleRate();
                            if (Number.isFinite(sr) && sr > 0) {
                                _bridgeSampleRateRef = sr;
                                setBridgeSampleRate(sr);
                            }
                        } catch (_) {}
                    }

                    const hasDetectNotes = typeof desktop.audio.detectNotes === 'function';
                    _usingNativeFrames = getNativeDetection() && ndBridgeRawFramesAvailable();
                    setUsingNativeFrames(_usingNativeFrames);
                    if (_usingNativeFrames) {
                        console.log('[note_detect] native-frame detection active — local detector on engine audio; chords via engine scoreChord');
                    }

                    detectInterval = setInterval(async () => {
                        ndUpdateMlGate();
                        if (!getEnabled() || processingFrame) return;
                        processingFrame = true;
                        const gen = getSessionGen();
                        try {
                            if (getNdHostChartSuspended() || getNdOtherOwnsOurSlot()) return;

                            // Path B — native-frame
                            if (_usingNativeFrames) {
                                const want = ndMinAnalysisSamples(getCurrentArrangement(), _bridgeSampleRateRef);
                                let frame = null;
                                try { frame = await ndBridgeRawAudioFrame(want); } catch (_) { frame = null; }
                                if (!getEnabled() || gen !== getSessionGen()) return;
                                if (frame && frame.length >= want) await processFrame(frame);
                                return;
                            }

                            // Path A — engine verifier
                            if (getNdUsingEngineVerifier()) {
                                if (ndChartSignature() !== getNdVerifierChartSig()) {
                                    await ndPushChartToBridge();
                                    if (!getEnabled() || gen !== getSessionGen()) return;
                                }
                                await ndDrainEngineVerdicts();
                                if (!getEnabled() || gen !== getSessionGen()) return;
                                try {
                                    const lp = await ndBridgeRawPitch();
                                    if (!getEnabled() || gen !== getSessionGen()) return;
                                    const confMin = getDetectionConfidenceMin();
                                    if (lp && typeof lp.midiNote === 'number' && lp.midiNote >= 0
                                        && typeof lp.confidence === 'number'
                                        && lp.confidence > confMin) {
                                        setDetectedMidi(lp.midiNote);
                                        setDetectedConfidence(lp.confidence);
                                        avCal.logDetection();
                                    } else {
                                        setDetectedMidi(-1);
                                        setDetectedConfidence(0);
                                    }
                                } catch (_) {
                                    setDetectedMidi(-1);
                                    setDetectedConfidence(0);
                                }
                                diagCatalog.setDiagDetector({ desktop_bridge: true, ml: bridgeMlActive, path: 'desktop-engine-verifier' });
                                const vt = getNdVerifyTarget();
                                if (vt) await runVerifyTarget(null);
                                return;
                            }

                            // Path A default — detectNotes / getPitchDetection
                            let detection = null;
                            if (hasDetectNotes) {
                                try { detection = await desktop.audio.detectNotes(); } catch (_) { detection = null; }
                                if (!getEnabled() || gen !== getSessionGen()) return;
                            }

                            const confMin = getDetectionConfidenceMin();
                            if (detection && Array.isArray(detection.notes)) {
                                bridgeNewOnsets.clear();
                                for (const n of detection.notes) {
                                    if (!n || typeof n.midi !== 'number'
                                        || typeof n.onsetSeq !== 'number') continue;
                                    const prev = bridgeOnsetSeqSeen.get(n.midi);
                                    if (prev !== undefined && n.onsetSeq <= prev) continue;
                                    bridgeOnsetSeqSeen.set(n.midi, n.onsetSeq);
                                    if (bridgeOnsetPrimed
                                        && typeof n.confidence === 'number'
                                        && n.confidence >= confMin) {
                                        bridgeNewOnsets.set(n.midi, {
                                            ageMs: Number.isFinite(n.onsetMs) ? n.onsetMs : 0,
                                            conf: n.confidence,
                                        });
                                    }
                                }
                                bridgeOnsetPrimed = true;
                                let best = null;
                                for (const n of detection.notes) {
                                    if (n && typeof n.midi === 'number'
                                        && (best === null || n.confidence > best.confidence)) best = n;
                                }
                                if (best && best.confidence >= confMin) {
                                    setDetectedMidi(best.midi);
                                    setDetectedConfidence(best.confidence);
                                } else {
                                    setDetectedMidi(-1); setDetectedConfidence(0);
                                    setDetectedString(-1); setDetectedFret(-1);
                                }
                            } else {
                                bridgeNewOnsets.clear();
                                const p = await ndBridgePitch();
                                if (!getEnabled() || gen !== getSessionGen()) return;
                                if (p && typeof p.midiNote === 'number' && p.midiNote >= 0
                                    && typeof p.confidence === 'number' && p.confidence >= confMin) {
                                    setDetectedMidi(p.midiNote);
                                    setDetectedConfidence(p.confidence);
                                } else {
                                    setDetectedMidi(-1); setDetectedConfidence(0);
                                    setDetectedString(-1); setDetectedFret(-1);
                                }
                            }
                            diagCatalog.setDiagDetector({
                                desktop_bridge: true, ml: bridgeMlActive,
                                path: bridgeMlActive ? 'desktop-ml-basicpitch' : 'desktop-yin',
                            });
                            await matchNotes(null);
                        } catch (e) {
                            console.warn('[note_detect] bridge poll failed:', e && e.message ? e.message : e);
                        } finally {
                            processingFrame = false;
                        }
                    }, 50);

                    startBridgeLevelMeter(desktop);
                    settingsPanel.populateDevices();
                    return true;
                }
                // bridge present but engine unavailable — fall through to browser path
            }

            // ── Path C — getUserMedia / AudioContext ──────────────────────
            let stream;
            if (externalStream) {
                stream = externalStream;
            } else {
                const selectedDeviceId = getSelectedDeviceId();
                const constraints = {
                    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
                };
                if (selectedDeviceId) constraints.audio.deviceId = { exact: selectedDeviceId };

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    const isHttp = location.protocol === 'http:'
                        && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
                    throw new Error(isHttp
                        ? 'Microphone access requires HTTPS. You are accessing Slopsmith over HTTP from a non-localhost address. Either:\n\n1. Use a reverse proxy with HTTPS (recommended)\n2. Access via localhost\n3. Add a self-signed certificate to the server'
                        : 'Microphone access is not available in this browser. Use Chrome or Edge.');
                }
                stream = await openInstrumentStream(constraints, { allowDeviceFallback: !getAutoEnableTrial() });
            }
            _streamRef = stream;
            setStream(stream);

            const audioCtx = externalAudioCtx
                || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            _audioCtxRef = audioCtx;
            setAudioCtx(audioCtx);

            sourceNode = audioCtx.createMediaStreamSource(stream);
            const streamChannels = sourceNode.channelCount;
            try { _bindStreamHealth(stream); } catch (_) {}

            gainNode = audioCtx.createGain();
            gainNode.gain.value = getInputGain();

            const selectedChannel = getSelectedChannel();
            if (streamChannels >= 2 && selectedChannel !== 'mono') {
                splitterNode = audioCtx.createChannelSplitter(2);
                sourceNode.connect(splitterNode);
                mergerNode = audioCtx.createChannelMerger(1);
                splitterNode.connect(mergerNode, selectedChannel === 'left' ? 0 : 1, 0);
                mergerNode.connect(gainNode);
            } else {
                sourceNode.connect(gainNode);
            }

            levelAnalyser = audioCtx.createAnalyser();
            levelAnalyser.fftSize = 512;
            levelAnalyser.smoothingTimeConstant = 0.8;
            gainNode.connect(levelAnalyser);

            const processor = audioCtx.createScriptProcessor(getFrameSize(), 1, 1);
            worklet = processor;
            accumBuffer = new Float32Array(0);
            pendingBuffer = null;

            processor.onaudioprocess = (e) => {
                const cbNow = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
                if (_lastAudioCbT) {
                    const gap = cbNow - _lastAudioCbT;
                    if (gap > _maxCbGapMs) _maxCbGapMs = gap;
                    onCbHeartbeat(cbNow, _maxCbGapMs);
                }
                _lastAudioCbT = cbNow;
                if (!getEnabled()) return;
                const input = e.inputBuffer.getChannelData(0);
                const prev = accumBuffer;
                const combined = new Float32Array(prev.length + input.length);
                combined.set(prev);
                combined.set(input, prev.length);
                const minSamples = ndMinAnalysisSamples(getCurrentArrangement(), audioCtx.sampleRate);
                if (combined.length >= minSamples) {
                    const start = combined.length - minSamples;
                    pendingBuffer = combined.slice(start, start + minSamples);
                    accumBuffer = new Float32Array(0);
                } else {
                    accumBuffer = combined;
                }
            };

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
            settingsPanel.populateDevices();
            return true;

        } catch (e) {
            console.error('Note detect: mic access denied or failed:', e);
            if (getEnabled() && !getAutoEnableTrial()) {
                alert('Note Detection: Could not access audio input.\n\n' + e.message);
            }
            stopAudio();
            return false;
        }
    }

    // ── stopAudio ─────────────────────────────────────────────────────────
    function stopAudio() {
        // Drop ML-gate claim while bridgeDesktop is still resolvable
        ndSyncMlGate(ndGateToken, false, ndBridgeAudio());

        setInputLost(false);
        _unbindStreamHealth();
        setHealthTrack(null);
        stopLevelMeter();
        stopBridgeLevelMeter();
        if (detectInterval) { clearInterval(detectInterval); detectInterval = null; }
        pendingBuffer = null;

        _usingBridge_      = false;
        _usingNativeFrames = false;
        setUsingDesktopBridge(false);
        setUsingNativeFrames(false);
        setBridgeDesktop(null);

        setNdUsingEngineVerifier(false);
        resetVerifierState();

        bridgeMlActive     = false;
        bridgeOnsetSeqSeen = new Map();
        bridgeNewOnsets    = new Map();
        bridgeOnsetPrimed  = false;

        if (worklet) {
            worklet.onaudioprocess = null;
            try { worklet.disconnect(); } catch (_) {}
            worklet = null;
        }
        if (levelAnalyser) { try { levelAnalyser.disconnect(); } catch (_) {} levelAnalyser = null; }
        if (gainNode)      { try { gainNode.disconnect(); }      catch (_) {} gainNode = null; }
        if (mergerNode)    { try { mergerNode.disconnect(); }    catch (_) {} mergerNode = null; }
        if (splitterNode)  { try { splitterNode.disconnect(); }  catch (_) {} splitterNode = null; }
        if (sourceNode)    { try { sourceNode.disconnect(); }    catch (_) {} sourceNode = null; }

        if (_streamRef && ownsStream) {
            _streamRef.getTracks().forEach(t => t.stop());
        }
        _streamRef = null;
        setStream(null);

        if (_audioCtxRef && ownsAudioCtx) {
            try { _audioCtxRef.close(); } catch (_) {}
        }
        _audioCtxRef = null;
        setAudioCtx(null);

        _localInputPeak = 0;
        _peakDecay      = 0;
        setInputLevel(0);
        setInputPeak(0);

        accumBuffer = new Float32Array(0);
        _underBufferWarned = false;
    }

    // ── applyInputGain — seam for applySettings ────────────────────────────
    function applyInputGain(v) {
        if (gainNode) gainNode.gain.value = v;
    }

    // ── Scoring-watchdog hooks ─────────────────────────────────────────────
    function getCbAge() {
        const now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
        return now - _lastAudioCbT;
    }
    function getMaxCbGapMs() { return _maxCbGapMs; }
    function resetMaxCbGap() { _maxCbGapMs = 0; }

    return {
        startAudio,
        stopAudio,
        applyInputGain,
        startLevelMeter,
        stopLevelMeter,
        startBridgeLevelMeter,
        stopBridgeLevelMeter,
        processFrame,
        getCbAge,
        getMaxCbGapMs,
        resetMaxCbGap,
    };
}
