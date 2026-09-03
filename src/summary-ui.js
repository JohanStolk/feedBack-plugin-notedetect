// End-of-song summary UI subsystem.
//
// Extracted from main.js (nd-carve-5 cut 2 — subsystem B).
// Verbatim move with DI substitutions documented below; no logic changes.
//
// Non-verbatim deltas vs. the original main.js source:
//   1. resolveHw()                       → getHw()
//   2. _ndSetLog (module-let reads)      → getSetLog()
//   3. _ndSetLog (module-let writes)     → setSetLog(v)
//   4. _ndShared.currentFilename         → getCurrentFilename()
//   5. _ndShared.diagnosticReturn        → getDiagnosticReturn()
//   6. tuningMode, _diagBreakdown,       → getState() snapshot
//      _diagTimingErrors, _diagPitchErrors
//   7. _diagPercentile                   → diagPercentile (DI param)
//   8. _getDiagnosticTrackForSession()   → getDiagnosticTrack()
//   9. _buildDiagnosticPlayReport(...)   → buildDiagnosticPlayReport(...)
//  10. _renderDiagnosticPlayHtml(...)    → renderDiagnosticPlayHtml(...)
//  11. _ndReturnToPreviousSong...()      → ndReturnToPreviousSong()
//  12. _downloadDiagnostic()             → downloadDiagnostic()
//  13. _ndLoad/ResultsGlow/AutoSave/...  → ndLoadSkin / ndResultsGlowOn / … (DI)
//  14. Private state vars moved into     → closure vars below
//      this closure (see resetState())
//  15. hits/misses/score/sectionStats/…  → getState() snapshot at call time

import { _ndSetLogAppend, _ndSetLogAverage } from './set-math.js';
import { _ndGradeFor, _ndComputeBestDelta, _ndPickHeroAction } from './classify.js';
import { _ndEscapeHtml, _ndInstrumentLabel, _ndSongArtUrl } from './format.js';

export function createSummaryUi({
    getHw,
    getState,
    instanceRoot,
    isDefault,
    disable,
    dispatchInstanceEvent,
    getCurrentFilename,
    getDiagnosticReturn,
    getSetLog,
    setSetLog,
    ndLoadSkin,
    ndResultsGlowOn,
    ndAutoSaveEnabled,
    ndQueueShowScores,
    ndQueueSetSummaryEnabled,
    ndQueueDelaySeconds,
    ndSongBestId,
    ndReadSongBest,
    ndWriteSongBest,
    ndSaveCard,
    ndShareCardClick,
    ndReturnToPreviousSong,
    downloadDiagnostic,
    getDiagnosticTrack,
    buildDiagnosticPlayReport,
    renderDiagnosticPlayHtml,
    diagPercentile,
}) {
    // ── Private state (verbatim move from main.js closure) ─────────────────────
    // When a training take is armed, the consent modal opens on
    // song:ended — the same event that fires the score summary. Defer
    // the summary so the two modals don't stack; _runDeferredSummary()
    // shows it once the consent flow closes.
    let _summaryDeferred = false;
    // When the host's global "Autoplay & auto-exit" option is on, a natural
    // song end would otherwise bounce the user back to the menu after a short
    // grace timer — clobbering this results panel. On song end we claim that
    // exit via window.slopsmith.holdAutoExit() and stash the returned release
    // here; dismissing the summary calls it to perform the deferred return
    // (or drops it, without navigating, when leaving via another path). Null
    // when the option is off / unavailable, so the legacy "close just hides
    // the panel, stay on the player" behaviour is preserved.
    let _ndAutoExitRelease = null;
    // One XP submission per take: set when _endOfSongOnEnded successfully
    // hands the session score to the minigames profile, cleared by
    // resetState() (which the playSong wrapper runs on every song switch
    // / retry). Guards against a duplicate award if song:ended ever fires
    // twice for one take.
    let _xpSubmittedTake = false;
    // End-of-song summary subscription. Bound from enableImpl() so the
    // drill-mode listener count test (which calls _bindDrillEvents()
    // directly without going through enable) keeps seeing exactly the
    // drill listener it expects. The handler runs only when `enabled`
    // is still true at song:ended, gated to the default singleton so a
    // splitscreen with N detecting panels doesn't pop N modals.
    let endOfSongSubscribed = false;
    let endOfSongOnEndedFn = null;

    const _SUMMARY_MIN_JUDGMENTS = 5;

    // A take is only worth a summary (and the XP that rides with it) once the
    // player has actually played something. Was inline in showSummary; the gig
    // path below needs the same answer without building an overlay.
    function _summaryWorthy() {
        const { hits, misses } = getState();
        return (hits + misses) >= _SUMMARY_MIN_JUDGMENTS;
    }

    // A gig is a SET: the career plugin shows ONE card at the end of it, scoring
    // every song played. A per-song summary on top of that is wrong twice over —
    // it interrupts the set with a popup after each song, and (worse) it
    // claimAutoExit's, so the host's play queue would not advance to the next
    // song until the player dismissed it. The set stalled on a popup every time.
    //
    // Narrow on purpose: only the 'gig' queue source. A playlist or album keeps
    // its per-song summary, which is what people already expect there.
    function _inGigSet() {
        // Same lookup showSummary's Up-Next wiring uses, including the legacy
        // `slopsmith` alias: a host that exposes only that one would otherwise
        // look queue-less here, and the popup would come back in gigs on exactly
        // the builds least likely to be tested.
        const q = (window.feedBack && window.feedBack.playQueue)
            || (window.slopsmith && window.slopsmith.playQueue)
            || null;
        if (!q || typeof q.active !== 'function' || typeof q.source !== 'function') return false;
        try { return q.active() && q.source() === 'gig'; } catch (_) { return false; }
    }

    function _endOfSongOnEnded() {
        if (!isDefault) return;
        const { enabled, _recArmedForTraining } = getState();
        if (!enabled) return;

        // In a gig, skip the overlay — but still credit the take, exactly as a
        // built summary would have (same _summaryWorthy() gate showSummary
        // applies), and still tear the detector down between songs.
        if (_inGigSet()) {
            try {
                if (_summaryWorthy()) _submitSongXp();
            } catch (e) {
                console.warn('[note_detect] gig-song XP failed:', e && e.message ? e.message : e);
            }
            try { disable({ silent: true }); } catch (e) { /* teardown is best-effort */ }
            return;
        }

        // showSummary() has its own `total < 5` guard, so a song that
        // ended before the user played anything meaningful is silently
        // skipped. When a training take is armed, _recOnEnded opens the
        // consent modal on this same event — so BUILD the summary now
        // (capturing this song's stats into the overlay DOM) but start
        // it hidden, and reveal it once the consent flow closes. Build-
        // now matters: a new song's playSong hook resets hits/misses, so
        // a deferred *re-render* would describe the wrong song.
        try {
            // claimAutoExit: this is the natural song-end summary, so it owns
            // the host's post-song return (see showSummary / _ndDismissSummary).
            const built = showSummary({ startHidden: _recArmedForTraining, claimAutoExit: true, autoSave: ndAutoSaveEnabled() });
            // Only mark deferred when an overlay was actually built and
            // hidden — a <5-judgment take builds nothing, so there'd be
            // nothing for _runDeferredSummary() to reveal.
            if (_recArmedForTraining && built) _summaryDeferred = true;
            // Award XP for the take through the minigames profile. Natural
            // song end only — the disable()-triggered summary and manual
            // api.showSummary() calls deliberately don't award (they can
            // fire repeatedly for one take). Gated on `built` so the same
            // <5-judgment takes that skip the summary also skip XP.
            // Idempotency lives inside _submitSongXp().
            if (built) _submitSongXp();
        } catch (e) {
            console.warn('[note_detect] end-of-song summary failed:', e && e.message ? e.message : e);
        }
        try { disable({ silent: true }); } catch (e) {}
    }

    // Submit the finished take to the minigames XP/profile backend via its
    // frontend SDK. minigames is an optional plugin — when it's absent (or
    // the request fails) this is a silent no-op: XP is a bonus layered on
    // top of the summary, never something that can break it. On success,
    // fill the summary's XP row (.nd-sum-xp) if the overlay carries one.
    // Once-per-take guard lives HERE (not just at the call site) so any
    // other caller of the exposed hook can't double-award a take;
    // resetState() re-arms it on every song switch / retry.
    async function _submitSongXp() {
        if (_xpSubmittedTake) return;
        // Claim the take up-front (dedupes a concurrent duplicate
        // song:ended while the request is in flight). The claim is
        // RELEASED only on the deterministic no-op below (SDK absent —
        // provably nothing was submitted) and HELD on a caught rejection:
        // an error from submitRun is ambiguous (a timeout can land after
        // the backend already persisted the award), and double-crediting
        // the profile is worse than occasionally losing one transient
        // take. resetState() re-arms per take as always.
        _xpSubmittedTake = true;
        const mg = window.slopsmithMinigames;
        if (!mg || typeof mg.submitRun !== 'function') {
            _xpSubmittedTake = false;
            return;
        }
        const currentHw = getHw();
        const info = currentHw && currentHw.getSongInfo ? currentHw.getSongInfo() : null;
        const { hits, misses, score, bestStreak, maxMultiplier } = getState();
        const total = hits + misses;
        const accuracy = total > 0 ? Math.round((hits / total) * 100) : 0;
        try {
            const res = await mg.submitRun({
                game_id: 'song_play',
                score,
                duration_ms: (info && Number.isFinite(info.duration))
                    ? Math.round(info.duration * 1000) : 0,
                meta: {
                    title: info && info.title || '',
                    artist: info && info.artist || '',
                    arrangement: info && info.arrangement || '',
                    accuracy,
                    hits,
                    misses,
                    bestStreak,
                    maxMultiplier,
                    grade: _ndGradeFor(accuracy),
                    fullCombo: misses === 0,
                },
            });
            _fillSummaryXpRow(res);
        } catch (e) {
            // Swallow — offline backend, killed request, profile-save race:
            // none of these should surface as a summary failure. The claim
            // stays held (see above): the failure is ambiguous and a retry
            // could double-credit the profile.
        }
    }

    // Surface the XP award on the open summary overlay. The redesigned
    // results screen ships a styled .nd-sum-xp slot; when the overlay
    // predates it (this scoring engine can land ahead of the visual
    // redesign), append a minimal row to the panel so the award is still
    // visible. No overlay at all (closed already) → quietly do nothing.
    function _fillSummaryXpRow(res) {
        if (!res || !res.ok) return;
        const overlay = instanceRoot.querySelector('.nd-summary-overlay');
        if (!overlay) return;
        let row = overlay.querySelector('.nd-sum-xp');
        if (!row) {
            const panel = overlay.firstElementChild;
            if (!panel) return;
            row = document.createElement('div');
            row.className = 'nd-sum-xp text-center text-sm text-green-400 mt-2';
            panel.appendChild(row);
        }
        // Progression (core spec 010): the earned currency is Decibels (dB);
        // the XP-derived level is gone from the UI (Mastery Rank replaced it),
        // so the old "· Level N" suffix is dropped rather than relabeled.
        row.textContent = `+${res.xp_gained} dB`;
        row.classList.remove('hidden');
    }

    // Reveal a summary overlay that was built hidden because a training
    // consent modal was occupying the screen. Idempotent — clears the
    // flag so it runs at most once per deferral.
    function _runDeferredSummary() {
        if (!_summaryDeferred) return;
        _summaryDeferred = false;
        if (!isDefault) return;
        const overlay = instanceRoot.querySelector('.nd-summary-overlay');
        if (overlay) {
            overlay.style.display = '';
            // A queue Up-Next countdown built on a hidden card is held until
            // now — starting it any earlier could advance the queue before the
            // card was ever visible (see showSummary's _ndStartUpNext).
            if (typeof overlay._ndStartUpNext === 'function') {
                const _start = overlay._ndStartUpNext;
                overlay._ndStartUpNext = null;
                _start();
            }
            // Play the reveal sequence now that the overlay is actually
            // visible, using the stats captured at build time (the live
            // counters may already belong to the next song).
            _animateSummary(overlay, overlay._ndReveal);
        }
    }

    function _endOfSongBindEvents() {
        if (endOfSongSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _endOfSongOnEnded;
        try {
            window.slopsmith.on('song:ended', fn);
        } catch (e) {
            return;
        }
        endOfSongOnEndedFn = fn;
        endOfSongSubscribed = true;
    }

    function _endOfSongUnbindEvents() {
        if (!endOfSongSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && endOfSongOnEndedFn) {
            try { window.slopsmith.off('song:ended', endOfSongOnEndedFn); } catch (e) {}
        }
        endOfSongSubscribed = false;
        endOfSongOnEndedFn = null;
    }

    // Returns true if a summary overlay was created, false if it bailed
    // (fewer than 5 judgments) — callers deferring the summary use this
    // to know whether there is actually an overlay to reveal later.
    function showSummary(opts) {
        const {
            hits, misses, score, maxMultiplier, bestStreak, sectionStats,
            tuningMode, _diagBreakdown, _diagTimingErrors, _diagPitchErrors,
        } = getState();
        if (!_summaryWorthy()) return false;
        const total = hits + misses;

        const existing = instanceRoot.querySelector('.nd-summary-overlay');
        if (existing) { existing.remove(); _ndAutoExitRelease = null; }

        const accuracy = Math.round((hits / total) * 100);
        const grade = _ndGradeFor(accuracy);
        const fullCombo = misses === 0;

        // Song identity for the card + the shareable image. Captured at BUILD
        // time: by the time the user taps a button the host may have navigated
        // and getSongInfo() would return {}. arrangement_index + filename feed
        // the Retry path (same song, same instrument).
        const _summaryHw = getHw();
        const _summaryInfo = (_summaryHw && _summaryHw.getSongInfo)
            ? (_summaryHw.getSongInfo() || {}) : {};
        const songTitle = _summaryInfo.title ? String(_summaryInfo.title) : '';
        const songArtist = _summaryInfo.artist ? String(_summaryInfo.artist) : '';
        const instrument = _ndInstrumentLabel(_summaryInfo.arrangement);
        const arrangementIndex = Number.isFinite(_summaryInfo.arrangement_index)
            ? _summaryInfo.arrangement_index : undefined;
        const retryFilename = getCurrentFilename() || '';
        const canRetry = !!retryFilename && typeof window.playSong === 'function';
        const artUrl = _ndSongArtUrl(retryFilename);
        // "Beat your best" delta: read the stored best for THIS song+arrangement
        // BEFORE recording the current run, so a natural-end take shows a true
        // "vs your best" figure. Persist only on the natural song-end completion
        // (claimAutoExit) — a manual/forced re-show must not bank a take.
        const _bestId = ndSongBestId(retryFilename, arrangementIndex);
        const _prevBest = retryFilename ? ndReadSongBest(_bestId) : null;
        const _bestDelta = _ndComputeBestDelta(_prevBest, { accuracy });
        if (retryFilename && opts && opts.claimAutoExit) {
            ndWriteSongBest(_bestId, { accuracy, score, bestStreak });
        }
        // Only render the line once a prior best exists (you can't beat a best
        // you don't have yet). Guilt-guarded: gain → green "New best"; tie →
        // neutral "Matched"; lower → just your standing best, never a red −N%.
        let bestHtml = '';
        if (_prevBest) {
            let cls = 'nd-sum-best', txt;
            if (_bestDelta.newBest) {
                cls += ' nd-sum-best--up';
                txt = `★ New best · +${_bestDelta.accDelta}% accuracy`;
            } else if (_bestDelta.accDelta === 0) {
                txt = `Matched your best · ${_bestDelta.bestAcc}%`;
            } else {
                txt = `Your best · ${_bestDelta.bestAcc}%`;
            }
            bestHtml = `<div class="${cls}">${_ndEscapeHtml(txt)}</div>`;
        }
        // Section time ranges (for the per-section "Practice This Section"
        // loop buttons). Captured now from the live highway — getSections()
        // returns [{time,name}] in chart order; a section's end is the next
        // section's start (or the song's end). First occurrence wins for a
        // repeated name (sectionStats dedupes by name).
        const _hwSections = (_summaryHw && _summaryHw.getSections)
            ? (_summaryHw.getSections() || []) : [];
        const _sectionRange = (name) => {
            for (let i = 0; i < _hwSections.length; i++) {
                if (!_hwSections[i] || _hwSections[i].name !== name) continue;
                const start = Number(_hwSections[i].time);
                if (!Number.isFinite(start)) return null;
                let end = (i + 1 < _hwSections.length) ? Number(_hwSections[i + 1].time) : NaN;
                if (!Number.isFinite(end) || end <= start) {
                    let d = Number(_summaryInfo.duration) || 0;
                    if (d > 6000) d /= 1000;
                    end = (d > start) ? d : start + 30;
                }
                return { start, end };
            }
            return null;
        };
        const shareSections = sectionStats.map((s) => {
            const t = s.hits + s.misses;
            return { name: s.name, acc: t > 0 ? Math.round((s.hits / t) * 100) : 0 };
        });
        // Contextual hero CTA: pick which action gets the primary slot from the
        // shape of the result. Sections with no notes contribute acc:null so a
        // never-reached section can't masquerade as the weakest. When the pick
        // is a section drill we must also know its loop range — fall back to a
        // plain Retry hero if the range is unknown.
        const _heroSectionInput = sectionStats.map((s) => {
            const t = s.hits + s.misses;
            return { name: s.name, acc: t > 0 ? Math.round((s.hits / t) * 100) : null };
        });
        const _heroPick = _ndPickHeroAction({ accuracy, canRetry, sections: _heroSectionInput });
        let _heroRange = null;
        if (_heroPick.kind === 'practice-section') {
            _heroRange = _sectionRange(_heroPick.sectionName);
            // No loop range for the section → fall back to a plain Retry hero;
            // drop the section reason too, so the line can't say "drill <X>"
            // while the rendered hero is actually Retry.
            if (!_heroRange) { _heroPick.kind = 'retry'; _heroPick.reason = ''; }
        }
        const _heroIsSection = _heroPick.kind === 'practice-section';
        const heroReasonHtml = _heroPick.reason
            ? `<div class="nd-sum-hero-reason">${_ndEscapeHtml(_heroPick.reason)}</div>`
            : '';
        // Positive replacement for the (punishing) Misses cell: your best
        // section → else the song length → else the note total. `extraValue`
        // is the compact form for the share strip; `extraValueFull` carries
        // the section name where the popup has room.
        let _topSec = null;
        for (const s of sectionStats) {
            const t = s.hits + s.misses;
            if (t <= 0) continue;
            const acc = Math.round((s.hits / t) * 100);
            if (!_topSec || acc > _topSec.acc) _topSec = { name: s.name, acc };
        }
        let _durSec = Number(_summaryInfo.duration) || 0;
        if (_durSec > 6000) _durSec /= 1000;   // guard ms vs s (no song is >100 min)
        const _fmtDur = (n) => {
            n = Math.max(0, Math.round(n));
            return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
        };
        let extraLabel, extraValue, extraValueFull;
        if (_topSec) {
            extraLabel = 'Top Section';
            extraValue = _topSec.name;        // share card: section name
            extraValueFull = _topSec.name;    // popup: section name too (was name · %)
        } else if (_durSec > 0) {
            extraLabel = 'Length'; extraValue = _fmtDur(_durSec); extraValueFull = extraValue;
        } else {
            extraLabel = 'Notes'; extraValue = String(total); extraValueFull = extraValue;
        }
        const shareData = {
            title: songTitle, artist: songArtist, instrument, artUrl,
            accuracy, score, hits, misses, bestStreak, maxMultiplier, fullCombo,
            sections: shareSections, extraLabel, extraValue,
        };
        // Auto-save the card to disk if the user opted in. Only the natural
        // song-end path passes autoSave (api.showSummary() / manual shows do
        // not), so this fires once per completed song. Fire-and-forget + silent
        // — the summary overlay is already on screen, the PNG lands in the
        // configured (or default "feedBack Cards") folder, and the server keeps
        // every take. instanceRoot carries data-nd-skin so the card themes right.
        if (opts && opts.autoSave) {
            try { ndSaveCard(shareData, instanceRoot, { auto: true }); } catch (e) {}
        }
        const metaSub = [songArtist, instrument].filter(Boolean).join(' · ');
        const songMetaHtml = (songTitle || metaSub)
            ? `<div class="nd-sum-songmeta">
                <div class="nd-sum-song-text">${
                    songTitle ? `<div class="nd-sum-song-title">${_ndEscapeHtml(songTitle)}</div>` : ''
                }${
                    metaSub ? `<div class="nd-sum-song-sub">${_ndEscapeHtml(metaSub)}</div>` : ''
                }</div>${
                    artUrl ? `<img class="nd-sum-art" alt="" src="${artUrl}">` : ''
                }</div>`
            : '';

        let sectionHtml = '';
        if (sectionStats.length > 0) {
            sectionHtml = '<div class="nd-sum-sections"><div class="nd-sum-subhead">Per Section</div>';
            for (const sec of sectionStats) {
                const secTotal = sec.hits + sec.misses;
                const secAcc = secTotal > 0 ? Math.round((sec.hits / secTotal) * 100) : 0;
                // Green only at 90%+; everything below is amber ("to improve").
                // Never a failure red.
                const cls = secAcc >= 90 ? 'nd-bar-good' : 'nd-bar-mid';
                // Per-section practice button: loops that section's time range
                // on replay. Only when we can re-launch the song AND we know the
                // section's bounds.
                const range = canRetry ? _sectionRange(sec.name) : null;
                const practiceBtn = range
                    ? `<button type="button" class="nd-sum-practice" data-start="${range.start}" data-end="${range.end}" title="Loop this section to practice it">Practice</button>`
                    : '';
                sectionHtml += `
                    <div class="nd-sum-bar-row">
                        <span class="nd-sum-bar-label">${_ndEscapeHtml(sec.name)}</span>
                        <div class="nd-sum-bar-track"><div class="nd-sum-bar-fill ${cls}" style="--nd-bar-w:${secAcc}%"></div></div>
                        <span class="nd-sum-bar-val">${secAcc}%</span>
                        ${practiceBtn}
                    </div>
                `;
            }
            sectionHtml += '</div>';
        }

        // "Focus next" — name the weakest section as a next step, not a failure
        // (the growth-oriented replacement for a punishing letter grade). Only
        // when a section sits meaningfully below a clean pass. Suppressed when
        // the contextual hero is already a drill of that same section (the hero
        // button + its reason line say it more actionably — no need to repeat).
        let focusHtml = '';
        if (sectionStats.length > 0 && !_heroIsSection) {
            let weakest = null;
            for (const sec of sectionStats) {
                const t = sec.hits + sec.misses;
                if (t <= 0) continue;
                const acc = Math.round((sec.hits / t) * 100);
                if (!weakest || acc < weakest.acc) weakest = { name: sec.name, acc };
            }
            if (weakest && weakest.acc < 90) {
                focusHtml = `<div class="nd-sum-focus"><span class="nd-sum-focus-label">Focus next</span>${_ndEscapeHtml(weakest.name)} · ${weakest.acc}%</div>`;
            }
        }

        // Miss-category breakdown (#254 follow-up) — bars sum to total misses
        // so the dominant failure mode is visible at a glance. Tuning mode
        // only — normal play sees just the score/grade headline +
        // per-section bars.
        let breakdownHtml = '';
        if (tuningMode && misses > 0) {
            const labels = {
                pure:         ['Pure (no pitch)',    'nd-bar-dim'],
                chordPartial: ['Chord — partial',    'nd-bar-alt'],
                early:        ['Timing — early',     'nd-bar-mid'],
                late:         ['Timing — late',      'nd-bar-mid'],
                sharp:        ['Pitch — sharp',      'nd-bar-cool'],
                flat:         ['Pitch — flat',       'nd-bar-cool'],
            };
            breakdownHtml = '<div class="nd-sum-sections"><div class="nd-sum-subhead">Miss Breakdown</div>';
            for (const k of Object.keys(labels)) {
                const v = _diagBreakdown[k] || 0;
                if (v === 0) continue;
                const pct = Math.round((v / misses) * 100);
                breakdownHtml += `
                    <div class="nd-sum-bar-row">
                        <span class="nd-sum-bar-label">${labels[k][0]}</span>
                        <div class="nd-sum-bar-track"><div class="nd-sum-bar-fill ${labels[k][1]}" style="--nd-bar-w:${pct}%"></div></div>
                        <span class="nd-sum-bar-val">${v} (${pct}%)</span>
                    </div>
                `;
            }
            const timingMed = diagPercentile(_diagTimingErrors, 50);
            const pitchMed  = diagPercentile(_diagPitchErrors, 50);
            if (timingMed != null || pitchMed != null) {
                breakdownHtml += '<div class="nd-sum-note">';
                if (timingMed != null) {
                    const tp10 = diagPercentile(_diagTimingErrors, 10);
                    const tp90 = diagPercentile(_diagTimingErrors, 90);
                    breakdownHtml += `Timing err (ms): median ${timingMed}, p10..p90 [${tp10}..${tp90}]<br>`;
                }
                if (pitchMed != null) {
                    const pp10 = diagPercentile(_diagPitchErrors, 10);
                    const pp90 = diagPercentile(_diagPitchErrors, 90);
                    breakdownHtml += `Pitch err (¢): median ${pitchMed}, p10..p90 [${pp10}..${pp90}]`;
                }
                breakdownHtml += '</div>';
            }
            breakdownHtml += '</div>';
        }

        let diagnosticPlayHtml = '';
        const diagnosticTrack = getDiagnosticTrack();
        const diagnosticReport = diagnosticTrack
            ? buildDiagnosticPlayReport(diagnosticTrack)
            : null;
        if (diagnosticReport) {
            diagnosticPlayHtml = renderDiagnosticPlayHtml(
                diagnosticReport,
                diagnosticTrack.reportProfile,
            );
        }

        const returnSnap = getDiagnosticReturn();
        const showReturnPrevBtn = !!(diagnosticReport
            && returnSnap
            && returnSnap.active
            && returnSnap.previousFilename);

        const overlay = document.createElement('div');
        overlay.className = 'nd-summary-overlay' + (ndResultsGlowOn() ? ' nd-glow' : '');
        // Skin attribute mirrors the instance root's so the overlay (a
        // separate top-level nd root in the CSS) themes identically.
        try { overlay.setAttribute('data-nd-skin', ndLoadSkin()); } catch (e) {}
        overlay.style.pointerEvents = 'auto';
        // Single dismiss path: remove the panel and, when we claimed the
        // host's auto-exit on song end, perform the deferred return to the
        // menu (navigateHome). Paths that navigate elsewhere themselves
        // (Return to Previous Song) pass navigateHome=false to drop the hold
        // without double-navigating. With the option off, _ndAutoExitRelease
        // is null → this is just the legacy "hide the panel" behaviour.
        const _ndDismissSummary = (navigateHome) => {
            overlay.remove();
            const release = _ndAutoExitRelease;
            _ndAutoExitRelease = null;
            if (release && navigateHome) { try { release(); } catch (e) {} }
        };
        // Queue-aware Up-Next strip (playlist "Play All"): when the host's
        // play-queue has a following track, the card names it and counts
        // down before advancing — the score stays readable and the player
        // keeps control (Play now / Stay). Feature-detected end to end:
        // hosts without the queue (or peekNext), or an idle queue, render
        // the card exactly as before.
        const _ndQueue = (window.feedBack && window.feedBack.playQueue)
            || (window.slopsmith && window.slopsmith.playQueue) || null;
        const _ndQueueNext = (_ndQueue && typeof _ndQueue.active === 'function'
            && _ndQueue.active() && typeof _ndQueue.peekNext === 'function')
            ? _ndQueue.peekNext() : null;
        // Filename-derived label first; upgraded to the real title async.
        const _ndQueueNextLabel = _ndQueueNext
            ? String(_ndQueueNext.filename).split('/').pop().replace(/\.(feedpak|sloppak)$/i, '')
            : '';
        // End-of-set bookkeeping. A NATURAL song-end in queue context appends
        // this song to the set log (claimAutoExit only — a manual/forced
        // re-show of the card must not double-count a song). The current
        // position is peekNext().index - 1; on the LAST song (queue active,
        // nothing next) it's inferred from the log, which is exact whenever
        // the previous song logged (the overwhelmingly common case).
        const _ndQueueActive = !!(_ndQueue && typeof _ndQueue.active === 'function'
            && _ndQueue.active() && typeof _ndQueue.peekNext === 'function');
        if (_ndQueueActive && opts && opts.claimAutoExit) {
            const _ndSetLog = getSetLog();
            const _ndPrevEntry = _ndSetLog.length ? _ndSetLog[_ndSetLog.length - 1] : null;
            setSetLog(_ndSetLogAppend(_ndSetLog, {
                pos: _ndQueueNext ? (_ndQueueNext.index - 1)
                    : (_ndPrevEntry ? _ndPrevEntry.pos + 1 : 0),
                total: _ndQueueNext ? _ndQueueNext.total
                    : (_ndPrevEntry ? _ndPrevEntry.total : 1),
                filename: retryFilename,
                title: songTitle
                    || String(retryFilename).split('/').pop().replace(/\.sloppak$/i, ''),
                artist: songArtist,
                accuracy: accuracy, hits: hits, misses: misses,
            }));
        }
        // The set is done when the last queued song's natural card is up. Two
        // songs minimum — a one-song "set" summary would just repeat the card.
        const _ndSetDone = _ndQueueActive && !_ndQueueNext
            && ndQueueSetSummaryEnabled() && getSetLog().length >= 2;
        // Scores hidden mid-queue: the card collapses (CSS) to the Up-Next
        // countdown strip — advance on the countdown alone, per the design
        // thread. All score DOM still exists (hidden), so every existing
        // wiring/animation path runs unchanged.
        const _ndScoreless = !ndQueueShowScores() && _ndQueueActive && !!_ndQueueNext;
        if (_ndScoreless) { try { overlay.classList.add('nd-sum-scoreless'); } catch (e) {} }
        // End-of-set summary (the design thread's ask: averaged + per-song
        // list). Renders INTO the existing overlay — same auto-exit hold,
        // same dismiss path — replacing the last song's card content. Exit
        // is the only action: the set is over, so it retires the log, clears
        // the (already-exhausted) queue for safety, and does the real exit.
        const _ndRenderSetSummary = () => {
            const log = getSetLog().slice();
            const avg = _ndSetLogAverage(log);
            const src = (_ndQueue && typeof _ndQueue.source === 'function'
                && _ndQueue.source()) || '';
            const rows = log.map((e, i) => `
                <div class="nd-set-row">
                    <span class="nd-set-row-n">${i + 1}</span>
                    <span class="nd-set-row-title">${_ndEscapeHtml(e.artist ? (e.artist + ' — ' + e.title) : e.title)}</span>
                    <span class="nd-set-row-acc">${Number(e.accuracy) || 0}%</span>
                </div>`).join('');
            overlay.classList.remove('nd-sum-scoreless');
            overlay.innerHTML = `
                <div class="nd-sum-shell">
                <div class="nd-sum-panel">
                    <div class="nd-sum-header">Set Complete</div>
                    ${src ? `<div class="nd-sum-song">${_ndEscapeHtml(src)}</div>` : ''}
                    <div class="nd-sum-headline">
                        <div class="nd-sum-acc"><span class="nd-sum-acc-n">${avg}</span>%<div class="nd-sum-label">Average accuracy</div></div>
                        <div class="nd-sum-score"><span class="nd-sum-score-n">${log.length}</span><div class="nd-sum-label">Songs played</div></div>
                    </div>
                    <div class="nd-set-rows">${rows}</div>
                    <div class="nd-sum-actions">
                        <button type="button" class="nd-summary-close nd-btn nd-btn-primary">Exit Song</button>
                    </div>
                </div>
                <div class="nd-sum-frame"></div>
                </div>
            `;
            try { overlay.classList.add('nd-revealed'); } catch (e) {}
            // We've swapped the card to the set-summary view. Drop the per-song
            // reveal payload so a later _runDeferredSummary() (the startHidden
            // path) can't animate the last song's accuracy/score into the
            // summary's reused .nd-sum-acc-n / .nd-sum-score-n (which would show
            // the wrong average). _animateSummary(overlay, null) then no-ops.
            overlay._ndReveal = null;
            const exitBtn = overlay.querySelector('.nd-summary-close');
            if (exitBtn) exitBtn.onclick = () => {
                setSetLog([]);
                try { if (_ndQueue) _ndQueue.clear(); } catch (e) {}
                _ndDismissSummary(true);
            };
        };
        // The results card is a terminal "choose your next action" screen, not a
        // throwaway popover: a stray click on the dim backdrop must NOT leave the
        // song (feedBack — "clicking outside of the card leaves the song"). Exit
        // is only via the explicit Exit Song / Retry / Return to Previous buttons.
        // The overlay still swallows backdrop clicks (pointer-events:auto set
        // above) so they don't reach the highway behind it; it just no longer
        // dismisses on a misclick.
        // .nd-sum-shell wraps the (scrollable) panel so the hand-drawn frame
        // overlay (.nd-sum-frame) can sit absolutely over the panel's edges
        // without scrolling with the content.
        overlay.innerHTML = `
            <div class="nd-sum-shell">
            <div class="nd-sum-panel">
                <canvas class="nd-sum-confetti"></canvas>
                <div class="nd-sum-header">Song Complete</div>
                ${songMetaHtml}
                ${fullCombo ? '<div class="nd-sum-fc">★ Full Combo</div>' : ''}
                <div class="nd-sum-headline">
                    <div class="nd-sum-acc"><span class="nd-sum-acc-n">0</span>%<div class="nd-sum-label">Accuracy</div></div>
                    <div class="nd-sum-score"><span class="nd-sum-score-n">0</span><div class="nd-sum-label">Score</div></div>
                </div>
                ${bestHtml}
                <div class="nd-sum-stats">
                    <div class="nd-sum-stat" style="--row-i:0"><span class="nd-sum-stat-label">Hits</span><span class="nd-sum-stat-val nd-val-good">${hits}/${total}</span></div>
                    <div class="nd-sum-stat" style="--row-i:1"><span class="nd-sum-stat-label">${_ndEscapeHtml(extraLabel)}</span><span class="nd-sum-stat-val nd-val-accent">${_ndEscapeHtml(extraValueFull)}</span></div>
                    <div class="nd-sum-stat" style="--row-i:2"><span class="nd-sum-stat-label">Best Streak</span><span class="nd-sum-stat-val nd-val-accent">${bestStreak}</span></div>
                    <div class="nd-sum-stat" style="--row-i:3"><span class="nd-sum-stat-label">Max Multiplier</span><span class="nd-sum-stat-val nd-val-accent">×${maxMultiplier}</span></div>
                </div>
                <div class="nd-sum-xp hidden"></div>
                ${breakdownHtml}
                ${focusHtml}
                ${sectionHtml}
                ${diagnosticPlayHtml}
                <div class="nd-sum-share">
                    <button type="button" class="nd-summary-copy nd-btn"
                            title="Copy a shareable score card to the clipboard">Copy card</button>
                    <button type="button" class="nd-summary-save nd-btn"
                            title="Save the score card as a PNG">⤓ Save</button>
                </div>
                ${heroReasonHtml}
                ${_ndQueueNext ? `
                <div class="nd-sum-upnext">
                    <span class="nd-sum-upnext-meta">Up next (${_ndQueueNext.index + 1} of ${_ndQueueNext.total})</span>
                    <span class="nd-sum-upnext-title">${_ndEscapeHtml(_ndQueueNextLabel)}</span>
                    <span class="nd-sum-upnext-count"></span>
                    <span class="nd-sum-upnext-btns">
                        <button type="button" class="nd-summary-next nd-btn nd-btn-primary">▶ Play now</button>
                        <button type="button" class="nd-summary-stay nd-btn">⏸ Stay</button>
                    </span>
                </div>` : (_ndSetDone ? `
                <div class="nd-sum-upnext">
                    <span class="nd-sum-upnext-meta">Set complete (${getSetLog().length} songs)</span>
                    <span class="nd-sum-upnext-title">Average accuracy ${_ndSetLogAverage(getSetLog())}%</span>
                    <span class="nd-sum-upnext-btns">
                        <button type="button" class="nd-summary-setsum nd-btn nd-btn-primary">View set summary</button>
                    </span>
                </div>` : '')}
                <div class="nd-sum-actions">
                    ${showReturnPrevBtn ? `
                    <button type="button" class="nd-summary-return-prev nd-btn">
                        Return to Previous Song
                    </button>` : ''}
                    ${tuningMode ? `
                    <button class="nd-summary-download nd-btn">
                        Download Diagnostic JSON
                    </button>` : ''}
                    ${_heroIsSection ? `
                    <button type="button" class="nd-summary-hero-practice nd-btn nd-btn-primary"
                            data-start="${_heroRange.start}" data-end="${_heroRange.end}"
                            title="Loop ${_ndEscapeHtml(_heroPick.sectionName)} to practice it">
                        Practice: ${_ndEscapeHtml(_heroPick.sectionName)}
                    </button>` : ''}
                    ${canRetry ? `
                    <button type="button" class="nd-summary-retry nd-btn${_heroIsSection ? '' : ' nd-btn-primary'}">
                        Retry Song
                    </button>` : ''}
                    <button type="button" class="nd-summary-close nd-btn${canRetry ? '' : ' nd-btn-primary'}">
                        Exit Song
                    </button>
                </div>
            </div>
            <div class="nd-sum-frame"></div>
            </div>
        `;
        const closeBtn = overlay.querySelector('.nd-summary-close');
        if (closeBtn) closeBtn.onclick = () => _ndDismissSummary(true);
        // Up-Next wiring. Advancing is OURS — playQueue.advance() directly,
        // never the host's queue-aware close wrapper: we drop the auto-exit
        // hold WITHOUT navigating (the host's generation guard makes a stale
        // handle harmless) and remove the card first so it can't linger over
        // the next song. Exit Song becomes a REAL exit: clearing the queue
        // first leaves the wrapper nothing to advance to, so it returns to
        // the menu — before this, the button labelled "Exit" silently played
        // the next track, which is exactly the confusion the tester hit.
        if (_ndQueueNext) {
            const nextBtn = overlay.querySelector('.nd-summary-next');
            const stayBtn = overlay.querySelector('.nd-summary-stay');
            const countEl = overlay.querySelector('.nd-sum-upnext-count');
            const titleEl = overlay.querySelector('.nd-sum-upnext-title');
            try {
                // Encode each path segment but preserve the '/' separators —
                // the {filename:path} route matches on the real slashes, so a
                // whole-string encodeURIComponent (%2F) would miss nested paths.
                const _ndNextUrl = String(_ndQueueNext.filename)
                    .split('/').map(encodeURIComponent).join('/');
                fetch('/api/song/' + _ndNextUrl)
                    .then((r) => (r && r.ok ? r.json() : null))
                    .then((m) => {
                        if (m && m.title && titleEl && titleEl.isConnected) {
                            titleEl.textContent = m.artist ? (m.artist + ' — ' + m.title) : m.title;
                        }
                    })
                    .catch(() => {});
            } catch (e) {}
            let _ndAdvanceTimer = null;
            const _ndStopCountdown = () => {
                if (_ndAdvanceTimer) { clearInterval(_ndAdvanceTimer); _ndAdvanceTimer = null; }
                if (countEl) countEl.textContent = '';
                if (stayBtn) stayBtn.style.display = 'none';
            };
            const _ndQueueAdvance = () => {
                // Idempotent: once the card is gone (a prior advance, or another
                // path closed it) never advance again — guards a double-click on
                // Play now and a delay-0 setTimeout that fires after a close.
                if (!overlay.isConnected) return;
                _ndStopCountdown();
                _ndAutoExitRelease = null;      // drop the hold without navigating
                overlay.remove();
                try { _ndQueue.advance(); } catch (e) {}
            };
            if (nextBtn) nextBtn.onclick = _ndQueueAdvance;
            if (stayBtn) stayBtn.onclick = _ndStopCountdown;
            let _ndSecsLeft = ndQueueDelaySeconds();
            // Start the countdown only once the card is actually visible. A card
            // built hidden (startHidden — the training-recording flow) must NOT
            // count down (or, at delay 0, advance) while off-screen, or the queue
            // could move on before the user ever sees the score. _runDeferredSummary
            // fires this on reveal; a visible card starts it immediately.
            const _ndStartUpNext = () => {
                if (_ndSecsLeft <= 0) {
                    // 0 = the user chose instant advance; defer past the current
                    // render so teardown never races the card's own setup.
                    setTimeout(_ndQueueAdvance, 0);
                    return;
                }
                if (countEl) countEl.textContent = 'starting in ' + Math.ceil(_ndSecsLeft) + 's';
                _ndAdvanceTimer = setInterval(() => {
                    // Another path (Retry / Return to Previous / Exit) closed
                    // the card — stop counting, never advance underneath it.
                    if (!overlay.isConnected) { _ndStopCountdown(); return; }
                    _ndSecsLeft -= 1;
                    if (_ndSecsLeft <= 0) { _ndQueueAdvance(); return; }
                    if (countEl) countEl.textContent = 'starting in ' + Math.ceil(_ndSecsLeft) + 's';
                }, 1000);
            };
            if (opts && opts.startHidden) { overlay._ndStartUpNext = _ndStartUpNext; }
            else { _ndStartUpNext(); }
            if (closeBtn) closeBtn.onclick = () => {
                _ndStopCountdown();
                try { _ndQueue.clear(); } catch (e) {}
                _ndDismissSummary(true);
            };
        }
        // Last queued song: the strip's "View set summary" swaps the card to
        // the set summary in place; Exit — with or without viewing it —
        // retires the finished set's log so a later run can't inherit it.
        // (No conflict with the queue-mode Exit override above: _ndSetDone
        // implies there is no next track, so that branch didn't run.)
        if (_ndSetDone) {
            const setsumBtn = overlay.querySelector('.nd-summary-setsum');
            if (setsumBtn) setsumBtn.onclick = _ndRenderSetSummary;
            if (closeBtn) closeBtn.onclick = () => {
                setSetLog([]);
                _ndDismissSummary(true);
            };
        }
        // Album-art thumbnail: drop it (and collapse the gap) if the song has
        // no art — the endpoint 404s and we don't want a broken-image glyph.
        const artImgEl = overlay.querySelector('.nd-sum-art');
        if (artImgEl) artImgEl.onerror = () => { try { artImgEl.remove(); } catch (e) {} };
        // Copy card / Save — render the share image in the active skin.
        const copyBtn = overlay.querySelector('.nd-summary-copy');
        if (copyBtn) copyBtn.onclick = () => ndShareCardClick(copyBtn, 'copy', shareData, overlay);
        const saveBtn = overlay.querySelector('.nd-summary-save');
        if (saveBtn) saveBtn.onclick = () => ndShareCardClick(saveBtn, 'download', shareData, overlay);
        // Retry Song — replay the same song + same arrangement (instrument).
        // Mirrors the Return-to-Previous-Song handler: we navigate ourselves,
        // so drop the auto-exit hold up front and only fall back to releasing
        // it (→ menu) if playSong rejects, leaving the user stranded.
        const retryBtn = overlay.querySelector('.nd-summary-retry');
        if (retryBtn) {
            retryBtn.onclick = () => {
                if (!canRetry) { _ndDismissSummary(true); return; }
                const release = _ndAutoExitRelease;
                _ndAutoExitRelease = null;
                overlay.remove();
                const _fallback = () => { if (release) { try { release(); } catch (e) {} } };
                try {
                    const p = window.playSong(
                        encodeURIComponent(retryFilename),
                        arrangementIndex,
                        { bridge: false },
                    );
                    if (p && typeof p.then === 'function') {
                        p.catch((e) => {
                            console.warn('[note_detect] retry song failed:',
                                e && e.message ? e.message : e);
                            _fallback();
                        });
                    }
                } catch (e) {
                    console.warn('[note_detect] retry song failed:',
                        e && e.message ? e.message : e);
                    _fallback();
                }
            };
        }
        // Per-section "Practice This Section" — replay the song with a loop
        // armed over that section's time range. Uses the host's load-and-loop
        // handoff (window._pendingHighwayLoop), the same mechanism the editor's
        // "Loop in 3D" uses: stash the loop, call playSong, and the host arms
        // the loop + starts playback once the chart is ready.
        // Includes the contextual hero "Practice: <section>" button — it carries
        // the same data-start/data-end, so it reuses this exact loop launcher.
        (overlay.querySelectorAll('.nd-sum-practice, .nd-summary-hero-practice') || []).forEach((pBtn) => {
            pBtn.onclick = () => {
                if (!canRetry) { _ndDismissSummary(true); return; }
                const a = Number(pBtn.dataset.start), b = Number(pBtn.dataset.end);
                const release = _ndAutoExitRelease;
                _ndAutoExitRelease = null;
                overlay.remove();
                const _fallback = () => { if (release) { try { release(); } catch (e) {} } };
                try {
                    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
                        // returnCtx:null → host applies the loop to the next song
                        // that becomes ready (the one we're about to load).
                        window._pendingHighwayLoop = { a, b, returnCtx: null };
                    }
                    const p = window.playSong(
                        encodeURIComponent(retryFilename), arrangementIndex, { bridge: false },
                    );
                    if (p && typeof p.then === 'function') {
                        p.catch((e) => {
                            console.warn('[note_detect] practice section failed:',
                                e && e.message ? e.message : e);
                            try { window._pendingHighwayLoop = null; } catch (_) {}
                            _fallback();
                        });
                    }
                } catch (e) {
                    console.warn('[note_detect] practice section failed:',
                        e && e.message ? e.message : e);
                    try { window._pendingHighwayLoop = null; } catch (_) {}
                    _fallback();
                }
            };
        });
        const returnPrevBtn = overlay.querySelector('.nd-summary-return-prev');
        if (returnPrevBtn) {
            returnPrevBtn.onclick = () => {
                // This button does its own navigation, so don't let the
                // auto-exit releaser fire on success. But keep it as a
                // fallback: if returning to the previous song fails (resolves
                // false or throws) the host timer was already cancelled by our
                // hold, so without this the user is stranded on the ended song
                // — release it to fall back to the menu.
                const release = _ndAutoExitRelease;
                _ndAutoExitRelease = null;
                overlay.remove();
                const _fallback = () => { if (release) { try { release(); } catch (e) {} } };
                ndReturnToPreviousSong().then((ok) => {
                    if (!ok) _fallback();
                }).catch((e) => {
                    console.warn('[note_detect] return to previous song failed:',
                        e && e.message ? e.message : e);
                    _fallback();
                });
            };
        }
        const dlBtn = overlay.querySelector('.nd-summary-download');
        if (dlBtn) dlBtn.onclick = () => downloadDiagnostic();
        // Capture the reveal-animation targets at BUILD time: a deferred
        // (startHidden) summary is revealed after a new song's playSong hook
        // may have reset the live counters, so _runDeferredSummary() must
        // not re-read them.
        overlay._ndReveal = { accuracy, score, fullCombo };
        // startHidden: built now (so the stats are this song's) but kept
        // out of view until _runDeferredSummary() reveals it — used when
        // a training consent modal is taking the screen on song:ended.
        if (opts && opts.startHidden) overlay.style.display = 'none';
        instanceRoot.appendChild(overlay);
        if (!(opts && opts.startHidden)) _animateSummary(overlay, overlay._ndReveal);

        // Host global autoplay/auto-exit handoff: only the natural song-end
        // summary (claimAutoExit) claims the host's deferred return — so it
        // fires when the user dismisses this panel (_ndDismissSummary) rather
        // than after the host's short grace timer would otherwise bounce them
        // to the menu mid-results. autoplayExit / holdAutoExit are absent on
        // older cores → legacy behaviour. Manual + disable()-triggered
        // summaries pass no claimAutoExit and never hold.
        if (opts && opts.claimAutoExit && window.slopsmith
            && window.slopsmith.autoplayExit
            && typeof window.slopsmith.holdAutoExit === 'function') {
            try { _ndAutoExitRelease = window.slopsmith.holdAutoExit(); } catch (e) {}
        }

        // Scores hidden + set complete: the set summary IS the score surface
        // in that mode, so swap the card to it immediately. Placed after the
        // hold claim on purpose — the summary relies on the same deferred
        // return the card does (Exit navigates via _ndDismissSummary).
        if (_ndSetDone && !ndQueueShowScores()) _ndRenderSetSummary();

        publishToJournal(accuracy);
        return true;
    }

    // Reveal sequence for the results panel: adds .nd-revealed (which fires
    // the CSS-side staggered row/bar/grade animations) and runs a single rAF
    // count-up for the accuracy % and score headline. Under reduced motion
    // (or without rAF) the final values land immediately and the CSS side is
    // neutralized by the stylesheet's reduced-motion block.
    function _animateSummary(overlay, vals) {
        if (!overlay || !vals) return;
        const accEl = overlay.querySelector('.nd-sum-acc-n');
        const scoreEl = overlay.querySelector('.nd-sum-score-n');
        const setFinal = () => {
            if (accEl) accEl.textContent = String(vals.accuracy);
            if (scoreEl) scoreEl.textContent = String(vals.score);
        };
        let reduced = false;
        try {
            reduced = !!(window.matchMedia
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (e) {}
        const reveal = () => { try { overlay.classList.add('nd-revealed'); } catch (e) {} };
        if (reduced || typeof requestAnimationFrame !== 'function') {
            reveal();
            setFinal();
            return;
        }
        // Double-rAF so the panel has a laid-out first frame before the
        // staggered animations start (single rAF can coalesce with the
        // append and skip the from-state).
        requestAnimationFrame(() => requestAnimationFrame(reveal));
        const DUR_MS = 1400;
        let start = null;
        const tick = (now) => {
            if (overlay.isConnected === false) return;   // closed mid-count
            if (start === null) start = now;
            const t = Math.min(1, (now - start) / DUR_MS);
            const ease = 1 - Math.pow(1 - t, 3);
            if (accEl) accEl.textContent = String(Math.round(vals.accuracy * ease));
            if (scoreEl) scoreEl.textContent = String(Math.round(vals.score * ease));
            if (t < 1) {
                requestAnimationFrame(tick);
            } else {
                setFinal();
                // Celebrate genuine wins (a clean run, or a strong pass) — reward
                // the work, never tied to a pass/fail grade.
                if (vals.fullCombo || vals.accuracy >= 90) _runConfetti(overlay);
            }
        };
        requestAnimationFrame(tick);
    }

    // One-shot confetti burst over the grade stamp for S/A results. Pure
    // canvas-2D, ~70 particles, self-terminating (~1.5 s), no listeners or
    // timers left behind; bails under reduced motion or when the canvas is
    // unavailable (vm tests, ancient browsers).
    function _runConfetti(overlay) {
        try {
            if (window.matchMedia
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        } catch (e) {}
        const canvas = overlay.querySelector('.nd-sum-confetti');
        if (!canvas || typeof canvas.getContext !== 'function') return;
        const wrap = canvas.parentElement;
        const W = canvas.width = (wrap && wrap.clientWidth) || 360;
        const H = canvas.height = (wrap && wrap.clientHeight) || 130;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // Particle colors follow the active skin's accents.
        let colors = ['#00f0ff', '#ff2ec4', '#00ff88', '#ffffff'];
        try {
            const cs = getComputedStyle(overlay);
            const a = cs.getPropertyValue('--nd-accent').trim();
            const b = cs.getPropertyValue('--nd-accent2').trim();
            const h = cs.getPropertyValue('--nd-hit').trim();
            if (a) colors = [a, b || a, h || a, '#ffffff'];
        } catch (e) {}
        const parts = [];
        for (let i = 0; i < 70; i++) {
            parts.push({
                x: W / 2 + (Math.random() - 0.5) * W * 0.35,
                y: H * 0.6,
                vx: (Math.random() - 0.5) * 4.2,
                vy: -(1.8 + Math.random() * 3.4),
                rot: Math.random() * Math.PI,
                vr: (Math.random() - 0.5) * 0.3,
                size: 2.5 + Math.random() * 3.5,
                color: colors[i % colors.length],
            });
        }
        const LIFE_MS = 1500;
        let t0 = null;
        const frame = (now) => {
            if (overlay.isConnected === false) return;
            if (t0 === null) t0 = now;
            const t = now - t0;
            ctx.clearRect(0, 0, W, H);
            if (t >= LIFE_MS) return;
            const fade = 1 - t / LIFE_MS;
            for (const p of parts) {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.10;
                p.rot += p.vr;
                ctx.save();
                ctx.globalAlpha = fade;
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
                ctx.restore();
            }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    function publishToJournal(accuracy) {
        // Use getHw() so showSummary() can be called on an
        // instance whose highway wasn't available at construction
        // but has since been defined.
        const currentHw = getHw();
        const info = currentHw && currentHw.getSongInfo ? currentHw.getSongInfo() : null;
        if (!info) return;
        const { hits, misses, score, maxMultiplier, bestStreak, sectionStats } = getState();
        dispatchInstanceEvent('notedetect:session', {
            title: info.title,
            artist: info.artist,
            arrangement: info.arrangement,
            accuracy,
            hits,
            misses,
            bestStreak,
            // Game-scoring additions (additive only — the practice journal
            // and other consumers ignore unknown keys).
            score,
            maxMultiplier,
            grade: _ndGradeFor(accuracy),
            fullCombo: misses === 0,
            sections: sectionStats.map(s => ({
                name: s.name,
                accuracy: (s.hits + s.misses) > 0 ? Math.round(s.hits / (s.hits + s.misses) * 100) : 0,
            })),
            timestamp: new Date().toISOString(),
        });
    }

    return {
        showSummary,
        runDeferredSummary: _runDeferredSummary,
        endOfSongBindEvents: _endOfSongBindEvents,
        endOfSongUnbindEvents: _endOfSongUnbindEvents,
        // Called by resetScoring() on every song-switch / retry — re-arms the
        // once-per-take XP guard and drops any stale auto-exit release handle.
        resetState() {
            _xpSubmittedTake = false;
            _ndAutoExitRelease = null;
        },
        // Test hook: exposed so api._submitSongXp stays reachable after the carve.
        // Production code never calls this directly (the natural path is via
        // _endOfSongOnEnded; api.showSummary() does not re-award).
        _submitSongXp,
    };
}
