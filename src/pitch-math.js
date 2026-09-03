// Pure tuning tables and MIDI/pitch math.
//
// Extracted from main.js (nd-carve-3-leaves step 2). No module-level mutable
// state — every function is input→output only, referencing only the const
// tables defined here. Safe to import from both the ES-module browser path
// and the vm classic-script loader (which strips `export` and pre-runs this
// file before main.js).

// ── Standard open-string MIDI values per instrument type ──────────────────
// MIDI note numbers for open strings in standard tuning (no capo, no offset).
// 5-string bass adds a low B string below the standard 4; 6-string adds a
// high C above. 7-string guitar adds a low B1 below the standard 6 strings;
// the standard low-E string. 8-string guitar adds a further low F#1
// below that (a perfect fourth below B1), matching the most common
// Ibanez/Schecter 8-string standard tuning.
export const _ND_TUNING_BASS_4 = [28, 33, 38, 43];                   // E1 A1 D2 G2
export const _ND_TUNING_BASS_5 = [23, 28, 33, 38, 43];               // B0 E1 A1 D2 G2
export const _ND_TUNING_BASS_6 = [23, 28, 33, 38, 43, 48];           // B0 E1 A1 D2 G2 C3
export const _ND_TUNING_GUITAR_6 = [40, 45, 50, 55, 59, 64];         // E2 A2 D3 G3 B3 E4
export const _ND_TUNING_GUITAR_7 = [35, 40, 45, 50, 55, 59, 64];     // B1 E2 A2 D3 G3 B3 E4
export const _ND_TUNING_GUITAR_8 = [30, 35, 40, 45, 50, 55, 59, 64]; // F#1 B1 E2 A2 D3 G3 B3 E4

export function _ndArrangementKindFromName(name) {
    return /bass/i.test(String(name || '')) ? 'bass' : 'guitar';
}

export function _ndStandardMidiFor(arrangement, stringCount) {
    if (arrangement === 'bass') {
        if (stringCount === 6) return _ND_TUNING_BASS_6;
        return stringCount === 5 ? _ND_TUNING_BASS_5 : _ND_TUNING_BASS_4;
    }
    if (stringCount === 8) return _ND_TUNING_GUITAR_8;
    if (stringCount === 7) return _ND_TUNING_GUITAR_7;
    return _ND_TUNING_GUITAR_6;
}

// ── MIDI ↔ frequency / pitch-name ─────────────────────────────────────────

export function _ndFreqToMidi(freq) {
    return 12 * Math.log2(freq / 440) + 69;
}

// MIDI → scientific pitch name (e.g. 40 → "E2"). Rounds to the nearest
// semitone. Used by the HUD so the "detected note" label is correct
// regardless of arrangement, tuning offsets, or capo — the previous
// implementation hardcoded `['E2','A2','D3','G3','B3','E4']` indexed
// by string, which mislabelled every bass / 7-string / retuned note.
export const _ND_PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function _ndMidiToName(midi) {
    const rounded = Math.round(midi);
    const pc = ((rounded % 12) + 12) % 12;
    const octave = Math.floor(rounded / 12) - 1;
    return _ND_PITCH_NAMES[pc] + octave;
}

// ── String/fret ↔ MIDI ────────────────────────────────────────────────────

export function _ndMidiFromStringFret(string, fret, arrangement, stringCount, offsets, capo) {
    const base = _ndStandardMidiFor(arrangement, stringCount);
    const offset = offsets && offsets[string] !== undefined ? offsets[string] : 0;
    return base[string] + offset + (capo || 0) + fret;
}

export function _ndMidiToStringFret(midiNote, arrangement, stringCount, offsets, capo) {
    // Pure geometric fallback: walk strings 0..N and return the first position
    // that matches the pitch. Used when there is no chart context available
    // (player noodling between chart notes). When a chart note is in play,
    // _ndResolveDisplayFingering picks the chart's (s, f) instead — see the
    // research notes in mapping-bass.test.js.
    const base = _ndStandardMidiFor(arrangement, stringCount);
    let bestDist = Infinity;
    let bestString = -1;
    let bestFret = -1;
    for (let s = 0; s < base.length; s++) {
        const offset = offsets && offsets[s] !== undefined ? offsets[s] : 0;
        const openMidi = base[s] + offset + (capo || 0);
        const fret = Math.round(midiNote - openMidi);
        if (fret < 0 || fret > 24) continue;
        const dist = Math.abs(midiNote - (openMidi + fret));
        if (dist < bestDist) {
            bestDist = dist;
            bestString = s;
            bestFret = fret;
        }
    }
    return { string: bestString, fret: bestFret };
}

// ── Octave-folded pitch distance ───────────────────────────────────────────

export function _ndFoldOctaveCents(cents) {
    if (!Number.isFinite(cents)) return Infinity;
    return cents - (Math.round(cents / 1200) * 1200);
}

export function _ndNearestOctaveCents(detectedMidi, expectedMidi) {
    if (!Number.isFinite(detectedMidi) || !Number.isFinite(expectedMidi)) return Infinity;
    return _ndFoldOctaveCents((detectedMidi - expectedMidi) * 100);
}

// Chart-context-aware fingering resolver. If any candidate chart note's
// expected pitch is within the pitch tolerance of the detected MIDI (allowing
// whole-octave detector mistakes), return that note's (string, fret) — the
// player is hitting the charted fingering. Otherwise fall back to the
// geometric first-match on the arrangement's tuning. This mirrors what
// score-follower apps (e.g. the chart) do: trust the chart for display when
// the player is on-pitch, only guess when they aren't.
export function _ndResolveDisplayFingering(detectedMidi, candidateNotes, arrangement, stringCount, offsets, capo, pitchToleranceCents) {
    if (candidateNotes && candidateNotes.length > 0) {
        for (const cn of candidateNotes) {
            const expected = _ndMidiFromStringFret(cn.s, cn.f, arrangement, stringCount, offsets, capo);
            if (Math.abs(_ndNearestOctaveCents(detectedMidi, expected)) <= pitchToleranceCents) {
                return { string: cn.s, fret: cn.f, displayMidi: expected };
            }
        }
    }
    const fallback = _ndMidiToStringFret(detectedMidi, arrangement, stringCount, offsets, capo);
    return { string: fallback.string, fret: fallback.fret, displayMidi: detectedMidi };
}

// ── DSP utilities ─────────────────────────────────────────────────────────

// Next power-of-two ≥ n. FFT sizes must be powers of two; the input
// buffer is zero-padded up to this length before transforming.
export function _ndNextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

// Parabolic interpolation: refines a peak bin estimate by fitting a parabola
// through the peak and its two neighbours. Returns a sub-bin offset clamped to
// ±1 so a near-zero denom can't produce a runaway offset that lands the
// corrected peak in a neighboring bin.
export function _ndParabolicOffset(yPrev, yPeak, yNext) {
    const denom = yPrev - 2 * yPeak + yNext;
    if (Math.abs(denom) < 1e-12) return 0;
    const delta = 0.5 * (yPrev - yNext) / denom;
    if (delta > 1) return 1;
    if (delta < -1) return -1;
    return delta;
}
