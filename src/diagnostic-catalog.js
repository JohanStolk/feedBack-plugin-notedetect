// Diagnostic-catalog subsystem (nd-carve cut 6).
//
// Owns all diagnostic state, live-judgment streaming, miss-breakdown
// counters, downloadable-JSON payload, the diagnostic track catalog,
// and the post-play structured report. Extracted from main.js under
// the LIVE-ACCESSOR RULE: every mutable factory dep is passed as an
// accessor function so this module never captures a stale reference.
//
// Summary-ui (cut 2) still pulls diagPercentile, downloadDiagnostic,
// getDiagnosticTrack, buildDiagnosticPlayReport, renderDiagnosticPlayHtml,
// and ndReturnToPreviousSong via its own DI — those are wired into
// createSummaryUi(...) in main.js pointing at diagCatalog.xxx.

/* global window */

export function createDiagnosticCatalog({
    // ── Mutable factory deps (LIVE-ACCESSOR RULE) ────────────────────
    getHw,                      // () => resolveHw()
    getHits,                    // () => hits
    getMisses,                  // () => misses
    getBestStreak,              // () => bestStreak
    getSectionStats,            // () => sectionStats
    getRescueCalls,             // () => _rescueCalls
    getRescueWindows,           // () => _rescueWindows
    getRescueHits,              // () => _rescueHits
    getRescueSkippedSilent,     // () => _rescueSkippedSilent
    getNdUsingEngineVerifier,   // () => _ndUsingEngineVerifier
    getNdDrainStats,            // () => _ndDrainStats (the stats object)
    getDetectionMethod,         // () => detectionMethod
    getTimingTolerance,         // () => timingTolerance
    getTimingHitThreshold,      // () => timingHitThreshold
    getChordTimingHitThreshold, // () => chordTimingHitThreshold
    getPitchTolerance,          // () => pitchTolerance
    getPitchHitThreshold,       // () => pitchHitThreshold
    getChordHitRatio,           // () => chordHitRatio
    getDetectionConfidenceMin,  // () => detectionConfidenceMin
    getLatencyOffset,           // () => latencyOffset
    getInputGain,               // () => inputGain
    getSelectedChannel,         // () => selectedChannel
    getTuningMode,              // () => tuningMode
    getRecArmedForTraining,     // () => _recArmedForTraining
    // ── _ndShared readers (LIVE-ACCESSOR RULE) ────────────────────────
    getCurrentFilename,         // () => _ndShared.currentFilename
    getDiagnosticReturn,        // () => _ndShared.diagnosticReturn
    clearDiagnosticReturnState, // () => _ndClearDiagnosticReturnState()
    // ── Constants (value, not accessor — never mutated) ───────────────
    ndVersion,                  // _ND_VERSION string
}) {
    // ── Miss-category diagnostic (#254 follow-up) ─────────────────────
    const _diagBreakdown = {
        pure: 0, chordPartial: 0, early: 0, late: 0, sharp: 0, flat: 0,
    };
    const _diagSingles = { hits: 0, misses: 0 };
    const _diagChords  = { hits: 0, misses: 0 };
    const _diagClean   = { clean: 0, loose: 0 };
    const _diagPerString = Array.from({ length: 8 }, () => ({ hits: 0, misses: 0 }));

    const _DIAG_ERROR_CAP = 2000;
    const _diagTimingErrors     = [];
    const _diagTimingErrorsHits = [];
    const _diagPitchErrors      = [];
    const _DIAG_EVENT_CAP = 2000;
    const _diagEvents = [];

    // Live-streaming state. Minted per song:play when tuning mode is on.
    // _liveLastSessionId is NOT cleared on song:ended so the training-
    // bundle upload can still locate this take's JSONL.
    let _liveSessionId     = null;
    let _liveLastSessionId = null;
    const _livePending     = new Set();

    // Detector identity captured by the detection tick. null until
    // detection first runs this session.
    let _diagDetector = null;

    // Live-event subscription handles.
    let _liveOnPlay = null, _liveOnEnded = null;
    let _liveSubscribed = false;

    // ── Pure helpers ──────────────────────────────────────────────────

    function diagTechFlags(n) {
        if (!n) return null;
        const flags = [];
        if (n.bn)               flags.push('B');
        if (n.sl != null && n.sl >= 0) flags.push('S');
        if (n.hm || n.hp)       flags.push('H');
        if (n.ho)               flags.push('h');
        if (n.po)               flags.push('p');
        if (n.tp)               flags.push('t');
        if (n.pm)               flags.push('PM');
        if (n.mt)               flags.push('M');
        if (n.tr)               flags.push('TR');
        if (n.ac)               flags.push('A');
        if ((+n.sus || 0) > 0)  flags.push('SUS');
        return flags.length ? flags.join(',') : null;
    }

    function diagPercentileFromSorted(sorted, p) {
        if (!sorted || !sorted.length) return null;
        const rank = (p / 100) * (sorted.length - 1);
        const idx = Math.max(0, Math.min(sorted.length - 1, Math.round(rank)));
        return sorted[idx];
    }

    function diagPercentile(arr, p) {
        if (!arr || !arr.length) return null;
        const sorted = arr.slice().sort((a, b) => a - b);
        return diagPercentileFromSorted(sorted, p);
    }

    // Sort once, compute count + p10/median/p90. Settings-page A/V panel
    // polls every 1.5 s while open so avoid repeated sorts per payload.
    function diagDistribution(arr) {
        if (!arr || !arr.length) return { count: 0, p10: null, median: null, p90: null };
        const sorted = arr.slice().sort((a, b) => a - b);
        return {
            count: sorted.length,
            p10:    diagPercentileFromSorted(sorted, 10),
            median: diagPercentileFromSorted(sorted, 50),
            p90:    diagPercentileFromSorted(sorted, 90),
        };
    }

    // ── Live-streaming ────────────────────────────────────────────────

    function buildSessionHeader() {
        const hw = getHw();
        const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
        const avOffsetMs = (hw && hw.getAvOffset) ? hw.getAvOffset() : 0;
        return {
            type: 'session_start',
            schema: 'note_detect.live.session_start.v1',
            ts: new Date().toISOString(),
            plugin_version: ndVersion,
            song: {
                title: info.title || null,
                artist: info.artist || null,
                arrangement: info.arrangement || null,
                arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
                tuning: info.tuning || null,
                capo: info.capo != null ? info.capo : 0,
                duration: info.duration != null ? info.duration : null,
            },
            settings: {
                method: getDetectionMethod(),
                timing_tolerance_s: getTimingTolerance(),
                timing_hit_threshold_s: getTimingHitThreshold(),
                chord_timing_hit_threshold_s: getChordTimingHitThreshold(),
                pitch_tolerance_cents: getPitchTolerance(),
                pitch_hit_threshold_cents: getPitchHitThreshold(),
                chord_hit_ratio: getChordHitRatio(),
                detection_confidence_min: getDetectionConfidenceMin(),
                latency_offset_s: getLatencyOffset(),
                input_gain: getInputGain(),
                channel: getSelectedChannel(),
                av_offset_ms: avOffsetMs,
            },
        };
    }

    function streamLiveJudgment(eventObj) {
        // Fire-and-forget — never block the detection hot path.
        // Tracked in _livePending so flushLiveJudgments() can drain
        // before a training bundle is zipped server-side.
        try {
            const p = fetch(
                '/api/plugins/note_detect/live-judgment?session='
                    + encodeURIComponent(_liveSessionId),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(eventObj),
                    keepalive: true,
                },
            ).catch(() => {});
            _livePending.add(p);
            p.finally(() => _livePending.delete(p));
        } catch (_) { /* swallow */ }
    }

    async function flushLiveJudgments() {
        try { await Promise.allSettled([..._livePending]); } catch (_) {}
    }

    function _startLiveSession() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = now.getFullYear()
            + pad(now.getMonth() + 1) + pad(now.getDate()) + '_'
            + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
        const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
        _liveSessionId = `${ts}_${rand}`;
        _liveLastSessionId = _liveSessionId;
        streamLiveJudgment(buildSessionHeader());
    }

    function liveBindEvents() {
        if (_liveSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        _liveOnPlay  = () => { _startLiveSession(); };
        _liveOnEnded = () => { _liveSessionId = null; };
        try {
            window.slopsmith.on('song:play',  _liveOnPlay);
            window.slopsmith.on('song:ended', _liveOnEnded);
        } catch (_) {
            try { window.slopsmith.off('song:play',  _liveOnPlay); }  catch (__) {}
            try { window.slopsmith.off('song:ended', _liveOnEnded); } catch (__) {}
            _liveOnPlay = _liveOnEnded = null;
            return;
        }
        _liveSubscribed = true;
    }

    function liveUnbindEvents() {
        if (!_liveSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_liveOnPlay)  { try { window.slopsmith.off('song:play',  _liveOnPlay); }  catch (_) {} }
            if (_liveOnEnded) { try { window.slopsmith.off('song:ended', _liveOnEnded); } catch (_) {} }
        }
        _liveOnPlay = _liveOnEnded = null;
        _liveSubscribed = false;
        _liveSessionId  = null;
    }

    // ── Recording counters ────────────────────────────────────────────

    function recordPerStringForChord(judgment) {
        const n = judgment.chartNote || judgment.note;
        if (n && Number.isInteger(n.s) && n.s >= 0 && n.s < _diagPerString.length) {
            const slot = _diagPerString[n.s];
            if (judgment.hit) slot.hits++; else slot.misses++;
        }
    }

    function recordDiagnostic(judgment) {
        const isChord = !!judgment.chord;
        if (judgment.hit) {
            (isChord ? _diagChords : _diagSingles).hits++;
            if (judgment.clean === false) _diagClean.loose++; else _diagClean.clean++;
        } else {
            (isChord ? _diagChords : _diagSingles).misses++;
            if (isChord) {
                _diagBreakdown.chordPartial++;
            } else if (judgment.detectedMidi == null) {
                _diagBreakdown.pure++;
            } else if (judgment.timingState === 'EARLY') {
                _diagBreakdown.early++;
            } else if (judgment.timingState === 'LATE') {
                _diagBreakdown.late++;
            } else if (judgment.pitchState === 'SHARP') {
                _diagBreakdown.sharp++;
            } else if (judgment.pitchState === 'FLAT') {
                _diagBreakdown.flat++;
            } else {
                // Defensive fallback — keep totals balanced.
                _diagBreakdown.pure++;
            }
        }
        if (!isChord) {
            const n = judgment.chartNote || judgment.note;
            if (n && Number.isInteger(n.s) && n.s >= 0 && n.s < _diagPerString.length) {
                const slot = _diagPerString[n.s];
                if (judgment.hit) slot.hits++; else slot.misses++;
            }
        }
        if (Number.isFinite(judgment.timingError) && _diagTimingErrors.length < _DIAG_ERROR_CAP) {
            _diagTimingErrors.push(judgment.timingError);
            if (judgment.hit && _diagTimingErrorsHits.length < _DIAG_ERROR_CAP) {
                _diagTimingErrorsHits.push(judgment.timingError);
            }
        }
        if (Number.isFinite(judgment.pitchError) && _diagPitchErrors.length < _DIAG_ERROR_CAP) {
            _diagPitchErrors.push(judgment.pitchError);
        }
        const nn = judgment.chartNote || judgment.note || {};
        const eventObj = {
            t:   Number.isFinite(judgment.noteTime) ? +judgment.noteTime.toFixed(3) : null,
            at:  Number.isFinite(judgment.time)     ? +judgment.time.toFixed(3)     : null,
            s:   Number.isInteger(nn.s) ? nn.s : null,
            f:   Number.isInteger(nn.f) ? nn.f : null,
            sus: Number.isFinite(nn.sus) ? +(+nn.sus).toFixed(3) : 0,
            hit:   !!judgment.hit,
            clean: !!judgment.clean,
            lr:  judgment.looseReason || undefined,
            chord: !!judgment.chord,
            ts:  judgment.timingState || null,
            ps:  judgment.pitchState  || null,
            te:  Number.isFinite(judgment.timingError) ? judgment.timingError : null,
            pe:  Number.isFinite(judgment.pitchError)  ? judgment.pitchError  : null,
            ex:  Number.isFinite(judgment.expectedMidi) ? judgment.expectedMidi : null,
            dx:  Number.isFinite(judgment.detectedMidi) ? judgment.detectedMidi : null,
            cnf: Number.isFinite(judgment.confidence) ? +judgment.confidence.toFixed(3) : 0,
            hs:  Number.isFinite(judgment.hitStrings)   ? judgment.hitStrings   : undefined,
            tt:  Number.isFinite(judgment.totalStrings) ? judgment.totalStrings : undefined,
            sc:  Number.isFinite(judgment.score) ? +judgment.score.toFixed(3) : undefined,
            tf:  diagTechFlags(nn),
            mf:  judgment.muteFail ? true : undefined,
            np:  judgment.notePresent ? true : undefined,
            nc:  Number.isFinite(judgment.presenceComb) ? judgment.presenceComb : undefined,
            sil: judgment.silent ? true : undefined,
        };
        if (_diagEvents.length < _DIAG_EVENT_CAP) {
            _diagEvents.push(eventObj);
        }
        if ((getTuningMode() || getRecArmedForTraining()) && _liveSessionId) {
            streamLiveJudgment(eventObj);
        }
    }

    function diagResetCounters(ndDrainStatsObj) {
        // ponytail: ndDrainStatsObj is the live _ndDrainStats object passed in;
        // resetScoring() calls diagResetCounters(getNdDrainStats()) so the same
        // reset sweep that clears diag state also zeros drain stats atomically.
        for (const k of Object.keys(_diagBreakdown)) _diagBreakdown[k] = 0;
        _diagSingles.hits = 0; _diagSingles.misses = 0;
        _diagChords.hits  = 0; _diagChords.misses  = 0;
        _diagClean.clean  = 0; _diagClean.loose    = 0;
        for (const slot of _diagPerString) { slot.hits = 0; slot.misses = 0; }
        _diagTimingErrors.length     = 0;
        _diagTimingErrorsHits.length = 0;
        _diagPitchErrors.length      = 0;
        _diagEvents.length           = 0;
        if (ndDrainStatsObj) {
            ndDrainStatsObj.dropUnknownId        = 0;
            ndDrainStatsObj.suppressedRedelivery = 0;
            ndDrainStatsObj.maxBatch             = 0;
        }
    }

    // ── Diagnostic payload + download ─────────────────────────────────

    function buildDiagnosticPayload() {
        const currentHw = getHw();
        const info = (currentHw && currentHw.getSongInfo) ? currentHw.getSongInfo() : {};
        const hits    = getHits();
        const misses  = getMisses();
        const total   = hits + misses;
        const sumAcc  = total > 0 ? +(hits / total).toFixed(3) : 0;
        const sAcc    = (_diagSingles.hits + _diagSingles.misses) > 0
            ? +(_diagSingles.hits / (_diagSingles.hits + _diagSingles.misses)).toFixed(3) : 0;
        const cAcc    = (_diagChords.hits + _diagChords.misses) > 0
            ? +(_diagChords.hits / (_diagChords.hits + _diagChords.misses)).toFixed(3) : 0;
        const drainStats = getNdDrainStats();
        return {
            schema: 'note_detect.diagnostic.v1',
            timestamp: new Date().toISOString(),
            plugin_version: ndVersion,
            detector: _diagDetector || { desktop_bridge: false, ml: false, path: 'none' },
            benchmark_hint: {
                title: info.title || null,
                artist: info.artist || null,
                arrangement: info.arrangement || null,
                arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
            },
            song: {
                tuning: info.tuning || null,
                capo: (info.capo != null) ? info.capo : 0,
                duration: (info.duration != null) ? info.duration : null,
                format: info.format || null,
            },
            settings: {
                method: getDetectionMethod(),
                timing_tolerance_s: getTimingTolerance(),
                timing_hit_threshold_s: getTimingHitThreshold(),
                chord_timing_hit_threshold_s: getChordTimingHitThreshold(),
                pitch_tolerance_cents: getPitchTolerance(),
                pitch_hit_threshold_cents: getPitchHitThreshold(),
                chord_hit_ratio: getChordHitRatio(),
                detection_confidence_min: getDetectionConfidenceMin(),
                latency_offset_s: getLatencyOffset(),
                input_gain: getInputGain(),
                channel: getSelectedChannel(),
            },
            summary: {
                hits, misses, total,
                accuracy: sumAcc,
                best_streak: getBestStreak(),
                singles: { hits: _diagSingles.hits, misses: _diagSingles.misses, accuracy: sAcc },
                chords:  { hits: _diagChords.hits,  misses: _diagChords.misses,  accuracy: cAcc },
                rescue: {
                    calls:          getRescueCalls(),
                    windows:        getRescueWindows(),
                    hits:           getRescueHits(),
                    skipped_silent: getRescueSkippedSilent(),
                },
                clean_hits: _diagClean.clean,
                loose_hits: _diagClean.loose,
                clean_rate: hits > 0 ? +(_diagClean.clean / hits).toFixed(3) : null,
            },
            engine_drain: {
                active:                 getNdUsingEngineVerifier(),
                drop_unknown_id:        drainStats ? drainStats.dropUnknownId        : 0,
                suppressed_redelivery:  drainStats ? drainStats.suppressedRedelivery : 0,
                max_batch:              drainStats ? drainStats.maxBatch             : 0,
            },
            miss_breakdown: { ..._diagBreakdown },
            per_string: _diagPerString.map((slot, s) => ({
                s,
                hits:     slot.hits,
                misses:   slot.misses,
                total:    slot.hits + slot.misses,
                accuracy: (slot.hits + slot.misses) > 0
                    ? +(slot.hits / (slot.hits + slot.misses)).toFixed(3) : null,
            })),
            timing_error_ms:      diagDistribution(_diagTimingErrors),
            timing_error_ms_hits: diagDistribution(_diagTimingErrorsHits),
            pitch_error_cents:    diagDistribution(_diagPitchErrors),
            sections: getSectionStats().map((s) => ({
                name: s.name,
                hits: s.hits,
                misses: s.misses,
                accuracy: (s.hits + s.misses) > 0
                    ? +(s.hits / (s.hits + s.misses)).toFixed(3) : 0,
            })),
            events: _diagEvents,
        };
    }

    function downloadDiagnostic() {
        try {
            const payload = buildDiagnosticPayload();
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const slug = (payload.benchmark_hint.title || 'song')
                .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
            const ts = payload.timestamp.replace(/[:.]/g, '-').slice(0, 19);
            const a = document.createElement('a');
            a.href = url;
            a.download = `note_detect_diag_${slug}_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 500);
            return true;
        } catch (e) {
            console.warn('[note_detect] diagnostic download failed:', e);
            return false;
        }
    }

    // ── Diagnostic track catalog ──────────────────────────────────────

    const _DIAGNOSTIC_TRACK_CATALOG = [
        {
            id: 'basic-guitar-6',
            title: 'Slopsmith Diagnostic — Basic Guitar',
            artist: 'Slopsmith',
            arrangement: 'Diagnostic Guitar',
            filenameIncludes: 'slopsmith-diagnostic-basic-guitar.sloppak',
            dlcRelativePath: 'diagnostics-builtin/slopsmith-diagnostic-basic-guitar.sloppak',
            instrument: 'guitar',
            stringCount: 6,
            reportProfile: 'basic-guitar-v1',
            description: 'Checks timing, open strings, fretted notes, and power chords.',
        },
    ];

    const _DIAGNOSTIC_REPORT_PROFILES = {
        'basic-guitar-v1': {
            matchTolS: 0.075,
            powerChordCategoryId: 'powerChords',
            expectedChordStrings: 2,
            displayOrder: ['openLow', 'openNext', 'fretted', 'powerChords', 'repeatCheck'],
            singleHitMissCategories: ['openLow', 'openNext', 'fretted'],
            events: [
                { t: 4,  category: 'openLow',      label: 'Open low string',    chord: false, s: 0, f: 0 },
                { t: 8,  category: 'openNext',     label: 'Open next string',   chord: false, s: 1, f: 0 },
                { t: 12, category: 'fretted',      label: 'Fretted note',       chord: false, s: 0, f: 5 },
                { t: 16, category: 'powerChords',  label: 'Power chord',        chord: true },
                { t: 20, category: 'powerChords',  label: 'Power chord',        chord: true },
                { t: 24, category: 'powerChords',  label: 'Power chord',        chord: true },
                { t: 28, category: 'powerChords',  label: 'Power chord',        chord: true },
                { t: 32, category: 'repeatCheck',  label: 'Repeat open low',   chord: false, s: 0, f: 0 },
                { t: 36, category: 'repeatCheck',  label: 'Repeat fretted',    chord: false, s: 0, f: 5 },
                { t: 40, category: 'repeatCheck',  label: 'Repeat power chord',chord: true },
                { t: 44, category: 'repeatCheck',  label: 'Repeat power chord',chord: true },
                { t: 48, category: 'repeatCheck',  label: 'Repeat power chord',chord: true },
            ],
            categories: {
                openLow:     { label: 'Open low string' },
                openNext:    { label: 'Open next string' },
                fretted:     { label: 'Fretted note' },
                powerChords: { label: 'Power chords' },
                repeatCheck: { label: 'Repeat check' },
            },
        },
    };

    // ── DOM helpers (UI-thread only) ──────────────────────────────────

    function _ndSetDiagnosticLaunchStatus(panel, message) {
        if (!panel) return;
        const el = panel.querySelector('.nd-health-diag-launch-status');
        if (el) el.textContent = message || '';
    }

    function _ndSetDiagnosticLaunchStatusAny(message) {
        const el = document.querySelector('.nd-health-diag-launch-status');
        if (el) el.textContent = message || '';
    }

    function _ndWaitForSongReadyEvent(timeoutMs) {
        const ms = timeoutMs != null ? timeoutMs : 15000;
        return new Promise((resolve) => {
            if (!window.slopsmith || typeof window.slopsmith.on !== 'function') {
                resolve(false);
                return;
            }
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { window.slopsmith.off('song:ready', onReady); } catch (_) {}
                resolve(ok);
            };
            const onReady = () => finish(true);
            const timer = setTimeout(() => finish(false), ms);
            try {
                window.slopsmith.on('song:ready', onReady);
            } catch (_) {
                finish(false);
            }
        });
    }

    // ── Diagnostic-track launch / return ─────────────────────────────

    function getDiagnosticTrackForSession() {
        const fn = (getCurrentFilename() || '').toLowerCase();
        const currentHw = getHw();
        const info = (currentHw && currentHw.getSongInfo) ? currentHw.getSongInfo() : {};
        for (const track of _DIAGNOSTIC_TRACK_CATALOG) {
            if (track.filenameIncludes
                && fn.includes(String(track.filenameIncludes).toLowerCase())) {
                return track;
            }
        }
        for (const track of _DIAGNOSTIC_TRACK_CATALOG) {
            if (info.title === track.title
                && info.artist === track.artist
                && info.arrangement === track.arrangement) {
                return track;
            }
        }
        return null;
    }

    function ndCaptureDiagnosticReturnBeforeLaunch(track) {
        clearDiagnosticReturnState();
        const prevFn = String(getCurrentFilename() || '').trim();
        if (!prevFn) return;
        if (getDiagnosticTrackForSession()) return;
        const diagFn = String(track.dlcRelativePath || '').trim();
        if (!diagFn) return;
        const prevLower = prevFn.toLowerCase();
        if (prevLower === diagFn.toLowerCase()) return;
        if (track.filenameIncludes
            && prevLower.includes(String(track.filenameIncludes).toLowerCase())) {
            return;
        }
        const currentHw = getHw();
        let info = {};
        try {
            info = (currentHw && currentHw.getSongInfo) ? (currentHw.getSongInfo() || {}) : {};
        } catch (_) { /* read-only snapshot */ }
        const arrIdx = info.arrangement_index;
        const dr = getDiagnosticReturn();
        dr.active = true;
        dr.previousFilename = prevFn;
        dr.previousArrangementIndex = Number.isFinite(arrIdx) ? arrIdx : null;
        dr.previousTitle  = info.title  || null;
        dr.previousArtist = info.artist || null;
        dr.launchedTrackId = track.id;
        dr.diagnosticFilename = diagFn;
    }

    async function ndReturnToPreviousSong() {
        const r = getDiagnosticReturn();
        if (!r || !r.active || !r.previousFilename) return false;
        if (typeof window.playSong !== 'function') {
            _ndSetDiagnosticLaunchStatusAny(
                'Could not return to the previous song. Load it from your library.',
            );
            clearDiagnosticReturnState();
            return false;
        }
        const prevFn  = r.previousFilename;
        const arrIdx  = r.previousArrangementIndex;
        const readyPromise = _ndWaitForSongReadyEvent();
        try {
            const loadPromise = window.playSong(
                encodeURIComponent(prevFn),
                Number.isFinite(arrIdx) ? arrIdx : undefined,
                { bridge: false },
            );
            if (loadPromise && typeof loadPromise.then === 'function') await loadPromise;
        } catch (e) {
            console.warn('[note_detect] return to previous song failed:', e);
            _ndSetDiagnosticLaunchStatusAny(
                'Could not return to the previous song. Load it from your library.',
            );
            clearDiagnosticReturnState();
            return false;
        }
        const ready    = await readyPromise;
        const prevTitle = r.previousTitle;
        clearDiagnosticReturnState();
        if (ready) {
            const label = prevTitle
                ? `Returned to ${prevTitle}. Press Play when ready.`
                : 'Returned to previous song. Press Play when ready.';
            _ndSetDiagnosticLaunchStatusAny(label);
            return true;
        }
        _ndSetDiagnosticLaunchStatusAny(
            'Could not return to the previous song. Load it from your library.',
        );
        return false;
    }

    async function ndLaunchDiagnosticTrack(trackId, panel) {
        const track = _DIAGNOSTIC_TRACK_CATALOG.find((t) => t.id === trackId);
        if (!track || !track.dlcRelativePath) {
            _ndSetDiagnosticLaunchStatus(panel, 'Diagnostic track is not configured.');
            return;
        }
        if (typeof window.playSong !== 'function') {
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Diagnostic track could not be loaded. Restart Slopsmith or rescan your library.',
            );
            return;
        }
        ndCaptureDiagnosticReturnBeforeLaunch(track);
        _ndSetDiagnosticLaunchStatus(panel, 'Loading diagnostic track…');
        const readyPromise = _ndWaitForSongReadyEvent();
        try {
            const loadPromise = window.playSong(
                encodeURIComponent(track.dlcRelativePath),
                undefined,
                { bridge: false },
            );
            if (loadPromise && typeof loadPromise.then === 'function') await loadPromise;
        } catch (e) {
            console.warn('[note_detect] diagnostic launch failed:', e);
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Diagnostic track could not be loaded. Restart Slopsmith or rescan your library.',
            );
            return;
        }
        const ready = await readyPromise;
        if (ready) {
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Loaded Basic Guitar Diagnostic. Press Play or Spacebar to begin.',
            );
            return;
        }
        _ndSetDiagnosticLaunchStatus(
            panel,
            'Diagnostic track is not available yet. Restart Slopsmith or rescan the library. '
            + 'If it still does not appear, the built-in diagnostic pack may not be installed.',
        );
    }

    // ── Post-play structured report ───────────────────────────────────

    function _diagMatchProfileEvent(events, spec, matchTolS) {
        for (const ev of events) {
            if (!ev || !Number.isFinite(ev.t)) continue;
            if (Math.abs(ev.t - spec.t) > matchTolS) continue;
            if (!!ev.chord !== !!spec.chord) continue;
            if (!spec.chord) {
                if (ev.s !== spec.s || ev.f !== spec.f) continue;
            }
            return ev;
        }
        return null;
    }

    function _buildDiagnosticPlayReportFromProfile(profile, reportProfileId) {
        const events = _diagEvents.slice();
        const chartEvents  = profile.events || [];
        const matchTolS    = profile.matchTolS != null ? profile.matchTolS : 0.075;
        let matchedCount   = 0;
        for (const spec of chartEvents) {
            if (_diagMatchProfileEvent(events, spec, matchTolS)) matchedCount++;
        }
        if (matchedCount === 0) return null;

        const hits        = getHits();
        const misses      = getMisses();
        const playTotal   = hits + misses;
        const overall     = {
            hits, misses,
            accuracy: playTotal > 0 ? Math.round((hits / playTotal) * 100) : 0,
            bestStreak: getBestStreak(),
        };

        const categoryMeta          = profile.categories || {};
        const categories            = {};
        let hasPartialPowerChords   = false;
        const powerChordCategoryId  = profile.powerChordCategoryId || 'powerChords';
        const expectedChordStrings  = profile.expectedChordStrings != null
            ? profile.expectedChordStrings : 2;

        for (const catId of Object.keys(categoryMeta)) {
            const specs        = chartEvents.filter((s) => s.category === catId);
            let attempts       = 0;
            let catHits        = 0;
            let catMisses      = 0;
            const timingErrors = [];
            const chordAttempts = [];

            for (const spec of specs) {
                const ev = _diagMatchProfileEvent(events, spec, matchTolS);
                if (!ev) continue;
                attempts++;
                if (ev.hit) catHits++; else catMisses++;
                if (Number.isFinite(ev.te)) timingErrors.push(ev.te);
                if (spec.chord) {
                    const hs = Number.isFinite(ev.hs) ? ev.hs : null;
                    const tt = Number.isFinite(ev.tt) ? ev.tt : expectedChordStrings;
                    chordAttempts.push({ t: ev.t, hit: !!ev.hit, hs, tt });
                    if (hs != null && hs < tt) hasPartialPowerChords = true;
                }
            }

            if (attempts === 0) continue;

            const cat = {
                id:      catId,
                label:   categoryMeta[catId].label,
                attempts,
                hits:    catHits,
                misses:  catMisses,
                accuracy: Math.round((catHits / attempts) * 100),
                timingMedianMs: timingErrors.length ? diagPercentile(timingErrors, 50) : null,
            };

            if (catId === powerChordCategoryId && chordAttempts.length) {
                const heard    = chordAttempts.filter((c) => c.hs != null);
                const avgHeard = heard.length
                    ? heard.reduce((sum, c) => sum + c.hs, 0) / heard.length : null;
                cat.chordHits         = catHits;
                cat.chordMisses       = catMisses;
                cat.avgStringsHeard   = avgHeard;
                cat.expectedStrings   = expectedChordStrings;
                cat.perAttempt        = chordAttempts.map((c) => {
                    const heardTxt = c.hs != null
                        ? `heard ${c.hs} of ${c.tt} strings` : 'strings heard unknown';
                    return { t: c.t, hit: c.hit, heardTxt };
                });
            }

            categories[catId] = cat;
        }

        if (!Object.keys(categories).length) return null;

        return {
            reportProfile: reportProfileId,
            overall,
            categories,
            matchedCount,
            hasPartialPowerChords,
            sections: getSectionStats().map((s) => ({
                name:   s.name,
                hits:   s.hits,
                misses: s.misses,
                accuracy: (s.hits + s.misses) > 0
                    ? Math.round((s.hits / (s.hits + s.misses)) * 100) : 0,
            })),
        };
    }

    function buildDiagnosticPlayReport(track) {
        if (!track || !track.reportProfile) return null;
        const profile = _DIAGNOSTIC_REPORT_PROFILES[track.reportProfile];
        if (!profile) return null;
        if (track.reportProfile === 'basic-guitar-v1') {
            return _buildDiagnosticPlayReportFromProfile(profile, track.reportProfile);
        }
        return null;
    }

    function _diagPlayReportHitMissHtml(hit) {
        return hit
            ? '<span class="text-green-400">Hit</span>'
            : '<span class="text-red-400">Miss</span>';
    }

    function renderDiagnosticPlayHtml(report, reportProfileId) {
        if (!report || !report.categories) return '';
        if (reportProfileId === 'basic-guitar-v1') {
            return _renderDiagnosticBasicGuitarPlayHtml(report);
        }
        return '';
    }

    function _renderDiagnosticBasicGuitarPlayHtml(report) {
        const profile = _DIAGNOSTIC_REPORT_PROFILES['basic-guitar-v1'];
        if (!report || !report.categories || !profile) return '';
        const cats = report.categories;
        let rows = '';

        for (const id of (profile.singleHitMissCategories || [])) {
            const c = cats[id];
            if (!c || !c.attempts) continue;
            rows += `<div class="flex justify-between gap-2 mb-1">`
                + `<span class="text-gray-300">${c.label}</span>`
                + _diagPlayReportHitMissHtml(c.hits > 0)
                + `</div>`;
        }

        const pwr = cats[profile.powerChordCategoryId || 'powerChords'];
        if (pwr && pwr.attempts) {
            let pwrDetail = '';
            if (pwr.avgStringsHeard != null) {
                pwrDetail += `<div class="text-[10px] text-gray-500">`
                    + `${pwr.chordHits}/${pwr.attempts} hit`
                    + ` · avg heard ${pwr.avgStringsHeard.toFixed(1)} of ${pwr.expectedStrings} strings`
                    + `</div>`;
            } else {
                pwrDetail += `<div class="text-[10px] text-gray-500">${pwr.hits}/${pwr.attempts} hit</div>`;
            }
            const partialLines = (pwr.perAttempt || [])
                .filter((a) => a.heardTxt && (!a.hit || a.heardTxt.indexOf('heard 2 of 2') === -1))
                .map((a) => {
                    const prefix = Number.isFinite(a.t) ? `${a.t}s: ` : '';
                    return `${prefix}${a.heardTxt}`;
                });
            if (partialLines.length) {
                pwrDetail += `<div class="text-[10px] text-gray-500 mt-0.5">`
                    + partialLines.join('<br>') + `</div>`;
            }
            rows += `<div class="mb-1">`
                + `<div class="flex justify-between gap-2">`
                + `<span class="text-gray-300">${pwr.label}</span>`
                + `<span class="text-gray-400">${pwr.hits}/${pwr.attempts} hit</span>`
                + `</div>${pwrDetail}</div>`;
        }

        const rep = cats.repeatCheck;
        if (rep && rep.attempts) {
            rows += `<div class="flex justify-between gap-2 mb-1">`
                + `<span class="text-gray-300">${rep.label}</span>`
                + `<span class="text-gray-400">${rep.hits}/${rep.attempts} hit</span>`
                + `</div>`;
        }

        if (!rows) return '';

        let notes = '<p class="text-[10px] text-gray-500 mt-2">'
            + 'This diagnostic report did not change gameplay settings.</p>';
        if (report.hasPartialPowerChords) {
            notes += '<p class="text-[10px] text-gray-500 mt-1">'
                + 'Power chords were partly heard. Try a cleaner/drier channel or run '
                + 'Technique Assessment for root/fifth detail.</p>';
        }

        return `<div class="mt-3 text-xs border-t border-gray-600 pt-3">`
            + `<div class="text-gray-200 text-xs font-semibold mb-2">Diagnostic Results</div>`
            + rows + notes + `</div>`;
    }

    // ── Public API ────────────────────────────────────────────────────

    return {
        // counters
        recordDiagnostic,
        recordPerStringForChord,
        diagResetCounters,
        // live stream
        streamLiveJudgment,
        flushLiveJudgments,
        liveBindEvents,
        liveUnbindEvents,
        startLiveSession: _startLiveSession,
        // payload + download
        buildSessionHeader,
        buildDiagnosticPayload,
        downloadDiagnostic,
        // pure / exported helpers
        diagTechFlags,
        diagPercentile,
        diagDistribution,
        // catalog + report
        getDiagnosticTrackForSession,
        buildDiagnosticPlayReport,
        renderDiagnosticPlayHtml,
        ndReturnToPreviousSong,
        ndLaunchDiagnosticTrack,
        ndCaptureDiagnosticReturnBeforeLaunch,
        // setters for state owned here but assigned from main
        setDiagDetector: (v) => { _diagDetector = v; },
        setLiveLastSessionId: (v) => { _liveLastSessionId = v; },
        // getters for _factoryState() + external readers
        getDiagBreakdown:       () => _diagBreakdown,
        getDiagTimingErrors:    () => _diagTimingErrors,
        getDiagPitchErrors:     () => _diagPitchErrors,
        getDiagEvents:          () => _diagEvents,
        getLiveLastSessionId:   () => _liveLastSessionId,
        getLiveSessionId:       () => _liveSessionId,
        getDiagDetector:        () => _diagDetector,
        // targeted clear used by _resetCalibrationSamples — only timing
        // error arrays, NOT the full counters (accuracy/breakdown stay intact)
        resetTimingErrors: () => {
            _diagTimingErrors.length = 0;
            _diagTimingErrorsHits.length = 0;
        },
    };
}
