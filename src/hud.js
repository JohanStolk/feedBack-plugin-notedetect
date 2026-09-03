// HUD (score/accuracy/streak/multiplier display + screen-edge flash overlay)
// and canvas draw-overlay (miss markers, hit glow rings, detected-note dot).
//
// Extracted from main.js factory (nd-carve-5 cut 1 — H+I). No module-level
// state. One file: flash overlay lifecycle is HUD-owned (createFlashOverlay/
// stopHUD), and drawOverlay shares the same DI surface (hw, getState,
// noteKey, noteStateFor) — separate files would halve the gain.

import { _ndMidiToName } from './pitch-math.js';
import { _ndIsStreakMilestone } from './classify.js';

// Safety-net poll throttle for loop-state sync inside updateHUD.
// See long comment at the declaration site in main.js.
const DRILL_LOOP_POLL_MS = 1000;

/**
 * createHUD({ hw, instanceRoot, loadSkin, noteKey, noteStateFor, getState,
 *             drillCallbacks })
 *
 * drillCallbacks: { syncFromLoopState, conductorTick, render }
 *
 * getState() returns a snapshot of factory-level scoring/detection/settings:
 *   enabled, hits, misses, streak, bestStreak, score, multiplier,
 *   detectedString, detectedConfidence, detectedDisplayMidi, detectedMidi,
 *   detectedFret, lastChordScore, lastChordHit, lastChordTotal, lastChordTime,
 *   edgeFlashEnabled, latencyOffset, detectionConfidenceMin,
 *   missMarkerDuration, hitGlowDuration, showTimingErrors, showPitchErrors,
 *   noteResults (live Map ref — not copied).
 *
 * Returns: { startHUD, stopHUD, drawOverlay }
 */
export function createHUD({
    hw,
    instanceRoot,
    loadSkin,
    noteKey,
    noteStateFor,
    getState,
    drillCallbacks,
}) {
    // HUD-private animation + interval state
    let hudInterval = null;
    let flashTimeouts = [];
    let lastHitCount = 0;
    let lastMissCount = 0;
    let displayScore = 0;
    let lastMultTier = 1;
    let lastStreakVal = 0;
    let drillLoopPollLastMs = 0;

    // Thin hw wrappers — avoids injecting factory-level _ndChartNotes/_ndChartChords.
    function _chartNotes() {
        if (!hw) return [];
        if (typeof hw.getFilteredNotes === 'function') return hw.getFilteredNotes() || [];
        return (hw.getNotes && hw.getNotes()) || [];
    }
    function _chartChords() {
        if (!hw) return [];
        if (typeof hw.getFilteredChords === 'function') return hw.getFilteredChords() || [];
        return (hw.getChords && hw.getChords()) || [];
    }

    function createHUDDom() {
        if (instanceRoot.querySelector('.nd-hud')) return;
        // Re-stamp the skin on (re)create — another instance (or the
        // settings screen) may have switched it while this HUD was down.
        try { instanceRoot.setAttribute('data-nd-skin', loadSkin()); } catch (e) {}
        const hud = document.createElement('div');
        // All layout/typography lives in assets/plugin.css, themed by the
        // instanceRoot's data-nd-skin attribute. Class names queried by
        // updateHUD()/_drillRender() are load-bearing — keep them stable.
        hud.className = 'nd-hud';
        hud.innerHTML = `
            <div class="nd-hud-score">0</div>
            <div class="nd-hud-mainrow">
                <span class="nd-hud-accuracy"></span>
                <span class="nd-hud-mult" data-tier="1">×1</span>
            </div>
            <div class="nd-hud-streak"></div>
            <div class="nd-hud-counts"></div>
            <div class="nd-hud-detected"></div>
            <div class="nd-drill hidden">
                <div class="nd-drill-header"></div>
                <div class="nd-drill-list"></div>
            </div>
        `;
        instanceRoot.appendChild(hud);
    }

    function removeHUD() {
        const hud = instanceRoot.querySelector('.nd-hud');
        if (hud) hud.remove();
        const flash = instanceRoot.querySelector('.nd-flash-overlay');
        if (flash) flash.remove();
    }

    function createFlashOverlay() {
        if (instanceRoot.querySelector('.nd-flash-overlay')) return;
        const flash = document.createElement('div');
        flash.className = 'nd-flash-overlay';
        flash.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;border:4px solid transparent;transition:border-color 0.05s;';
        instanceRoot.appendChild(flash);
    }

    function startHUD() {
        createHUDDom();
        createFlashOverlay();
        lastHitCount = 0;
        lastMissCount = 0;
        // Sync animation state to the live counters so a mid-song re-enable
        // doesn't replay a count-up / multiplier pop for ground it already
        // covered. The badge DOM must be seeded too — createHUD's template
        // hard-codes ×1, and updateHUD only rewrites it on tier CHANGES, so
        // syncing lastMultTier alone would leave a recreated HUD stuck at
        // ×1 while a >1 multiplier is live.
        const { score, multiplier, streak } = getState();
        displayScore = score;
        lastMultTier = multiplier;
        lastStreakVal = streak;
        const multEl = instanceRoot.querySelector('.nd-hud-mult');
        if (multEl) {
            multEl.setAttribute('data-tier', String(multiplier));
            multEl.textContent = '×' + multiplier;
        }
        if (hudInterval) clearInterval(hudInterval);
        hudInterval = setInterval(updateHUD, 33);
    }

    function stopHUD() {
        if (hudInterval) { clearInterval(hudInterval); hudInterval = null; }
        // Cancel pending edge-flash timeouts so disable()/destroy() don't
        // need to reach in. flashTimeouts is HUD-private; clearing here
        // replaces the standalone loop that used to live in disable().
        for (const tid of flashTimeouts) clearTimeout(tid);
        flashTimeouts = [];
        removeHUD();
    }

    function updateHUD() {
        const {
            enabled, hits, misses, streak, bestStreak, score, multiplier,
            detectedString, detectedConfidence, detectedDisplayMidi, detectedMidi, detectedFret,
            lastChordScore, lastChordHit, lastChordTotal, lastChordTime,
            edgeFlashEnabled, latencyOffset, detectionConfidenceMin,
        } = getState();
        if (!enabled) return;

        // Bridge slopsmith's loop state into our drill flag. Loop
        // changes normally arrive via the playback:loop-set /
        // playback:loop-cleared events bound in _drillBindEvents; this
        // is only the safety-net poll for hosts that don't emit them,
        // throttled to ~1 Hz — getLoop() is a legacy bridge surface on
        // newer hosts and every call is instrumented (bridge-hit event
        // + diagnostics snapshot), so a 30 Hz poll is NOT cheap.
        const nowMs = Date.now();
        if (nowMs - drillLoopPollLastMs >= DRILL_LOOP_POLL_MS) {
            drillLoopPollLastMs = nowMs;
            drillCallbacks.syncFromLoopState();
        }
        // Detect conductor loop wraps from the chart clock (reliable; the
        // host loop:restart event doesn't always reach us on this loop path)
        // and fire the beat-locked metronome. No-op unless a conductor drill
        // is active. Runs every tick (unthrottled) — it reads the local chart
        // clock, not the instrumented getLoop() bridge.
        drillCallbacks.conductorTick();
        drillCallbacks.render();

        const total = hits + misses;
        const accEl = instanceRoot.querySelector('.nd-hud-accuracy');
        const streakEl = instanceRoot.querySelector('.nd-hud-streak');
        const countsEl = instanceRoot.querySelector('.nd-hud-counts');
        const detectedEl = instanceRoot.querySelector('.nd-hud-detected');
        const flashEl = instanceRoot.querySelector('.nd-flash-overlay');
        const scoreEl = instanceRoot.querySelector('.nd-hud-score');
        const multEl = instanceRoot.querySelector('.nd-hud-mult');

        if (scoreEl) {
            // Eased count-up toward the live score; snap instantly downward
            // (a reset/new song should not "count down" from the old total).
            if (score < displayScore) displayScore = score;
            const diff = score - displayScore;
            displayScore = diff < 1 ? score : displayScore + diff * 0.25;
            scoreEl.textContent = String(Math.round(displayScore));
        }

        if (multEl && multiplier !== lastMultTier) {
            multEl.setAttribute('data-tier', String(multiplier));
            multEl.textContent = '×' + multiplier;
            if (multiplier > lastMultTier) {
                // Remove + reflow + re-add so consecutive tier-ups retrigger
                // the one-shot keyframe.
                multEl.classList.remove('nd-pop');
                void multEl.offsetWidth;
                multEl.classList.add('nd-pop');
            }
            lastMultTier = multiplier;
        }

        if (accEl && total > 0) {
            const accuracy = Math.round((hits / total) * 100);
            const color = accuracy >= 90 ? '#00ff88' : accuracy >= 70 ? '#ffcc00' : '#ff4444';
            accEl.textContent = accuracy + '%';
            accEl.style.color = color;
        } else if (accEl) {
            accEl.textContent = '';
        }

        if (streakEl) {
            let text = streak > 0 ? `${streak} streak` : '';
            if (bestStreak > 0) text += `  best: ${bestStreak}`;
            streakEl.textContent = text;
            if (streak === 0 && lastStreakVal >= 10) {
                // A multiplier-worthy streak just broke — shake the panel.
                const hudEl = instanceRoot.querySelector('.nd-hud');
                if (hudEl) {
                    hudEl.classList.remove('nd-shake');
                    void hudEl.offsetWidth;
                    hudEl.classList.add('nd-shake');
                }
            } else if (streak > lastStreakVal && _ndIsStreakMilestone(streak)) {
                streakEl.classList.remove('nd-flash');
                void streakEl.offsetWidth;
                streakEl.classList.add('nd-flash');
            }
            lastStreakVal = streak;
        }

        if (countsEl && total > 0) {
            countsEl.textContent = `${hits} / ${total}`;
        } else if (countsEl) {
            // Clear on zero-total so a reset/new-song enable doesn't
            // show the previous session's `X / Y` until the first
            // judgment lands. Mirrors the accuracy label's else-branch.
            countsEl.textContent = '';
        }

        if (detectedEl) {
            if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
                // Use the chart-corrected display MIDI when available;
                // otherwise use the raw detected MIDI. Bass, 7-string guitar,
                // non-standard tuning, and capo all still route through the
                // same MIDI-name formatter instead of string-index lookups.
                const displayMidi = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
                detectedEl.textContent = `${_ndMidiToName(displayMidi)} · s${detectedString} f${detectedFret}`;
            } else if (lastChordScore !== null) {
                // No confident single-note detected this frame, but we
                // have a recent chord score from the constraint path —
                // show it for a short TTL after the chord's chart time
                // so the readout doesn't linger forever through silence
                // / noise between notes.
                const songTime = (hw.getTime ? hw.getTime() : 0) - latencyOffset
                    + (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
                const CHORD_HUD_TTL_SEC = 1.5;
                if (songTime - lastChordTime <= CHORD_HUD_TTL_SEC) {
                    const pct = Math.round(lastChordScore * 100);
                    detectedEl.textContent = `chord ${lastChordHit}/${lastChordTotal} (${pct}%)`;
                } else {
                    detectedEl.textContent = '';
                }
            } else {
                detectedEl.textContent = '';
            }
        }

        if (flashEl) {
            // Track pending flash timeouts so stopHUD() can clear them.
            // Each timeout self-splices from the list on fire so the array
            // doesn't grow unbounded across a long session (~60 min of play
            // at ~20 hits/min was previously accumulating ~1200 stale entries
            // before disable ran).
            const spawnFlash = (color) => {
                // slopsmith#254 — off by default now that the highway
                // renderer lights the note itself; opt back in via the
                // "Screen-edge flash on hit/miss" toggle.
                if (!edgeFlashEnabled) return;
                flashEl.style.borderColor = color;
                const tid = setTimeout(() => {
                    if (flashEl) flashEl.style.borderColor = 'transparent';
                    const idx = flashTimeouts.indexOf(tid);
                    if (idx !== -1) flashTimeouts.splice(idx, 1);
                }, 80);
                flashTimeouts.push(tid);
            };
            if (hits > lastHitCount) {
                spawnFlash('rgba(0, 255, 136, 0.6)');
            } else if (misses > lastMissCount) {
                spawnFlash('rgba(255, 50, 68, 0.4)');
            }
            lastHitCount = hits;
            lastMissCount = misses;
        }
    }

    // ── Draw hook overlay on the highway canvas ───────────────────────
    function drawOverlay(ctx, W, H) {
        const {
            enabled, detectedString, detectedConfidence, detectedFret,
            detectionConfidenceMin, detectedDisplayMidi, detectedMidi,
            missMarkerDuration, hitGlowDuration,
            showTimingErrors, showPitchErrors,
            noteResults,
        } = getState();
        if (!enabled) return;
        if (!hw.project || !hw.fretX) return;
        // This overlay positions everything with the 2D highway's
        // projection (hw.project / hw.fretX). A custom renderer (3D
        // highway, piano, …) draws its own scene with different
        // geometry — and fires our draw hook on its 2D overlay layer —
        // so these markers would land in meaningless places (the stray
        // red miss X's complaint, slopsmith#254). Bail when a non-default
        // renderer is active; that renderer owns the per-note feedback
        // (the 3D highway lights the note mesh on hit/active and red-
        // outlines + labels misses, via the bundle.getNoteState path).
        // Our HUD / screen-flash are DOM, not canvas, so they're
        // unaffected. Older cores without isDefaultRenderer → assume 2D.
        if (hw.isDefaultRenderer && !hw.isDefaultRenderer()) return;

        const t = hw.getTime();
        const renderT = t + (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const notes = _chartNotes();
        const chords = _chartChords();

        const drawTextReadable = (text, x, y) => {
            if (hw.fillTextUnmirrored) hw.fillTextUnmirrored(text, x, y);
            else ctx.fillText(text, x, y);
        };

        const nowPoint = hw.project(0);

        const drawIndicator = (s, f, noteTime, judgment) => {
            const tOff = noteTime - renderT;
            if (!nowPoint) return;

            const age = Math.max(0, renderT - noteTime);
            let scale = nowPoint.scale || 1;
            let x;
            let y;
            if (judgment.hit || tOff >= -0.05) {
                const p = hw.project(tOff);
                if (!p) return;
                scale = p.scale || scale;
                x = hw.fretX(f, scale, W);
                y = p.y * H;
            } else {
                const nowY = nowPoint.y * H;
                const pastArea = Math.max(40, H - nowY - 18);
                const progress = Math.min(1, age / Math.max(0.1, missMarkerDuration));
                x = hw.fretX(f, scale, W);
                y = nowY + Math.min(pastArea, 28 + progress * pastArea);
            }

            if (judgment.hit) {
                // slopsmith#254 — when *our* provider is the one driving
                // the gem lighting, the green overlay ring is redundant;
                // skip it. But if the core supports the hook yet some
                // other plugin owns the provider (we declined to stomp it
                // in ensureDrawHook), the gem isn't lit by us — fall
                // through to the ring so there's still on-highway hit
                // feedback. Older cores (no getter) also keep the ring.
                if (hw && hw.getNoteStateProvider && hw.getNoteStateProvider() === noteStateFor) return;
                const fade = Math.max(0, 1 - age / Math.max(0.1, hitGlowDuration)) * scale;
                if (fade <= 0) return;
                ctx.save();
                ctx.globalAlpha = fade * 0.7;
                ctx.globalCompositeOperation = 'lighter';
                ctx.shadowColor = '#00ff88';
                ctx.shadowBlur = 20 * scale;
                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth = 3 * scale;
                ctx.beginPath();
                ctx.arc(x, y, 14 * scale, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            } else {
                const fade = Math.max(0, 1 - age / Math.max(0.1, missMarkerDuration)) * scale;
                if (fade <= 0) return;
                ctx.save();
                ctx.globalAlpha = fade * 0.85;
                ctx.shadowColor = '#ff3344';
                ctx.shadowBlur = 12 * scale;
                ctx.strokeStyle = '#ff3344';
                ctx.lineWidth = 2.5 * scale;
                const sz = 8 * scale;
                ctx.beginPath();
                ctx.moveTo(x - sz, y - sz);
                ctx.lineTo(x + sz, y + sz);
                ctx.moveTo(x + sz, y - sz);
                ctx.lineTo(x - sz, y + sz);
                ctx.stroke();

                const pulse = Math.max(0, 1 - age / 0.2);
                if (pulse > 0) {
                    const nowY = nowPoint.y * H;
                    ctx.globalAlpha = pulse * 0.5;
                    ctx.strokeStyle = '#ff3344';
                    ctx.lineWidth = 5 * scale;
                    ctx.beginPath();
                    ctx.moveTo(Math.max(0, x - 18 * scale), nowY + 4);
                    ctx.lineTo(Math.min(W, x + 18 * scale), nowY + 4);
                    ctx.stroke();
                }

                const labels = [];
                if (showTimingErrors && judgment.timingState && judgment.timingState !== 'OK') {
                    labels.push({
                        color: '#ffb347',
                        text: `${judgment.timingState === 'EARLY' ? '↑' : '↓'} ${judgment.timingError > 0 ? '+' : ''}${judgment.timingError}ms`,
                    });
                }
                if (showPitchErrors && judgment.pitchState && judgment.pitchState !== 'OK') {
                    labels.push({
                        color: '#66c7ff',
                        text: `${judgment.pitchState === 'SHARP' ? '♯' : '♭'} ${judgment.pitchError > 0 ? '+' : ''}${judgment.pitchError}¢`,
                    });
                }
                if (labels.length > 0) {
                    ctx.font = `bold ${Math.max(10, 11 * scale)}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    for (let i = 0; i < labels.length; i++) {
                        const yy = y + (i - (labels.length - 1) / 2) * 16 * scale - 18 * scale;
                        ctx.lineWidth = 3;
                        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                        ctx.strokeText(labels[i].text, x, yy);
                        ctx.fillStyle = labels[i].color;
                        drawTextReadable(labels[i].text, x, yy);
                    }
                }
                ctx.restore();
            }
        };

        if (notes) {
            for (const n of notes) {
                if (n.t < renderT - missMarkerDuration - 0.2) continue;
                if (n.t > renderT + 3) break;
                if (n.mt) continue;
                const key = noteKey(n, n.t);
                const result = noteResults.get(key);
                if (result) drawIndicator(n.s, n.f, n.t, result);
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t < renderT - missMarkerDuration - 0.2) continue;
                if (c.t > renderT + 3) break;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    const key = noteKey(cn, c.t);
                    const result = noteResults.get(key);
                    if (result) drawIndicator(cn.s, cn.f, c.t, result);
                }
            }
        }

        if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
            if (nowPoint) {
                const x = hw.fretX(detectedFret, nowPoint.scale, W);
                const y = nowPoint.y * H;
                ctx.save();
                ctx.globalAlpha = Math.min(1, detectedConfidence);
                ctx.fillStyle = '#44ddff';
                ctx.shadowColor = '#44ddff';
                ctx.shadowBlur = 12;
                ctx.beginPath();
                ctx.arc(x, y, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#000';
                ctx.font = 'bold 7px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(detectedFret, x, y);
                ctx.restore();
            }
        }
    }

    return { startHUD, stopHUD, drawOverlay };
}
