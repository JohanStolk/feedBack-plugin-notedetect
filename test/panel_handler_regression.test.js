// nd-carve-5 cut 4 — settings panel handler regression.
//
// The seam test (drill_apply_settings_seam.test.js) verified that
// _applySettings routes each key correctly.  This file verifies that the
// HANDLER WIRING inside showSettings() connects control events to the seam:
// a deleted `applySettings(...)` call in onDeviceChange stays invisible to
// the seam test (it drives the seam directly), but makes this test fail.
//
// Tests in this file:
//   1. Device-change handler writes + ORDER proof — the main Creed finding.
//      Mutation: delete `applySettings({ selectedDeviceId: deviceId })` at
//      settings-panel.js:129 → both assertions fail, naming the broken key.
//   2. Timing-slider handler writes timingTolerance — belt over the seam test
//      for this specific end-to-end path.
//   3. Panel-close clears the health-poll timer — VU/health timer cleanup.
//
// DOM setup: loadDetectionCore accepts sandboxBeforeRun which we use to
// install a minimal fake document tracking the created panel element so
// panel.querySelector(sel).onchange etc. are callable by tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// ── Minimal fake DOM helpers ──────────────────────────────────────────────

function makeFakeChild() {
    return {
        value: '',
        checked: false,
        disabled: false,
        innerHTML: '',
        textContent: '',
        style: {},
        title: '',
        className: '',
        isConnected: true,
        onchange: null,
        oninput: null,
        onclick: null,
        appendChild() {},
        remove() { this.isConnected = false; },
        // Grandchildren (e.g. recBlock.querySelector('.nd-rec-arm')) return
        // null — all callers null-guard before assigning onclick/oninput.
        querySelector: () => null,
        querySelectorAll: () => [],
    };
}

function makeFakePanel() {
    // Lazy child registry: querySelector returns the same element for a
    // given selector so the wiring pass and the test can share one object.
    const children = new Map();
    const panel = {
        // className starts empty — showSettings() sets 'nd-settings-panel'
        // itself; starting with the class here would pollute the querySelector
        // before body.appendChild runs and cause an early-exit toggle.
        className: '',
        style: {},
        innerHTML: '',
        isConnected: true,
        _ndHealthTick: null,
        remove() { this.isConnected = false; },
        querySelector(sel) {
            // Normalise compound selectors to the trailing class name so
            // '.nd-settings-panel .nd-device-select' and '.nd-device-select'
            // both resolve to the same child in the registry.
            const key = sel.replace(/.*\s/, '');
            if (!children.has(key)) children.set(key, makeFakeChild());
            return children.get(key);
        },
        querySelectorAll() { return []; },
        appendChild() {},
    };
    return panel;
}

// Build a sandboxBeforeRun hook that installs the fake document and returns
// an accessor for the most recently created panel.
function withFakeDom() {
    let _panel = null;
    let _clearIntervalSpy = null;
    const clearIntervalCalls = [];

    const sandboxBeforeRun = (sandbox) => {
        sandbox.document = {
            getElementById: () => null,
            querySelector(sel) {
                // Only return the panel AFTER body.appendChild has run —
                // before that _panel is null, so showSettings() sees no
                // existing panel and proceeds to build a new one.
                if (!_panel) return null;
                if (sel === '.nd-settings-panel') return _panel;
                // Compound: '.nd-settings-panel .nd-device-select' etc.
                if (sel.startsWith('.nd-settings-panel')) {
                    const inner = sel.replace('.nd-settings-panel', '').trim();
                    return inner ? _panel.querySelector(inner) : _panel;
                }
                return null;
            },
            querySelectorAll: () => [],
            // createElement does NOT set _panel — only body.appendChild does.
            // createNoteDetector() calls createElement('div') for instanceRoot
            // before showSettings() is called; if that also set _panel, the
            // subsequent querySelector('.nd-settings-panel') would return it
            // (isConnected: true) and showSettings() would toggle-close early.
            createElement() {
                return makeFakePanel();
            },
            head: { appendChild: () => {} },
            body: {
                // Set _panel only when the settings panel is appended.
                // body.contains is called by renderRec(); returning false
                // lets it bail early without touching recording-state DI.
                contains: () => false,
                appendChild(el) { if (el) _panel = el; },
            },
            addEventListener: () => {},
        };
        // Spy on clearInterval so tests can verify timer cleanup.
        _clearIntervalSpy = (id) => { clearIntervalCalls.push(id); };
        sandbox.clearInterval = _clearIntervalSpy;
    };

    return {
        sandboxBeforeRun,
        getPanel: () => _panel,
        clearIntervalCalls,
    };
}

// ── Test 1: device-change handler — write + ORDER proof ───────────────────

test('onDeviceChange: selectedDeviceId written before saveSettings (restartAudio)', () => {
    // The Creed mutation input: delete `applySettings({ selectedDeviceId: deviceId })`
    // at settings-panel.js:129 → user picks a new device → audio restarts on the OLD
    // device → this test fails on the first assertion.
    //
    // ORDER proof via localStorage spy: saveSettings() calls localStorage.setItem()
    // with {deviceId: selectedDeviceId, ...} AFTER applySettings writes the var, and
    // BEFORE restartAudio() runs.  Capturing deviceId at setItem() time proves the
    // write landed in the correct place in the call chain.
    let savedDeviceId;
    const dom = withFakeDom();
    const core = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            dom.sandboxBeforeRun(sandbox);
            // Spy on localStorage.setItem to capture the deviceId saved by saveSettings().
            sandbox.localStorage.setItem = (key, value) => {
                try {
                    const parsed = JSON.parse(value);
                    if ('deviceId' in parsed) savedDeviceId = parsed.deviceId;
                } catch (_) {}
            };
        },
    });

    // isDefault: true so saveSettings() calls localStorage.setItem (it's a
    // no-op for non-default instances, which would make savedDeviceId stay
    // undefined and the ORDER assertion would trivially pass on a broken build).
    const det = core.createNoteDetector({ isDefault: true });
    det._showSettings();

    const panel = dom.getPanel();
    assert.ok(panel, 'showSettings must create a panel element');

    const sel = panel.querySelector('.nd-device-select');
    assert.ok(sel, 'panel must have an .nd-device-select child');
    assert.ok(typeof sel.onchange === 'function', 'device select must have onchange wired');

    // Simulate user picking a USB-DI device.
    sel.value = 'usb-di';
    sel.onchange({ target: sel });

    // Write landed in the closure var.
    assert.equal(
        det._getState().selectedDeviceId,
        'usb-di',
        'selectedDeviceId must be updated by onDeviceChange — ' +
        'mutation: delete applySettings({selectedDeviceId}) at settings-panel.js:129',
    );

    // ORDER: saveSettings() — called after applySettings() and before restartAudio() —
    // saw the new value when it called localStorage.setItem.
    assert.equal(
        savedDeviceId,
        'usb-di',
        'selectedDeviceId must be written BEFORE saveSettings runs ' +
        '(and thus before restartAudio) — proves correct call order in onDeviceChange',
    );

    det.destroy();
});

// ── Test 2: timing-slider handler — end-to-end seam write ─────────────────

test('timing-slider oninput: writes timingTolerance through the seam', () => {
    // Belt over the seam test: verify the timing-slider handler calls
    // applySettings({ timingTolerance: ... }) and the value reaches _factoryState.
    const dom = withFakeDom();
    const core = loadDetectionCore({ sandboxBeforeRun: dom.sandboxBeforeRun });
    const det = core.createNoteDetector();
    det._showSettings();

    const panel = dom.getPanel();
    const slider = panel.querySelector('.nd-timing-slider');
    assert.ok(typeof slider.oninput === 'function', 'timing slider must have oninput wired');

    // Slider value is in ms (30–300); seam stores seconds.
    slider.value = '120';
    slider.oninput({ target: slider });

    assert.equal(det._getState().timingTolerance, 0.120,
        'timingTolerance must be 0.120 s after slider fires 120 ms');

    det.destroy();
});

// ── Test 3: panel-close clears the health-poll timer ─────────────────────

test('nd-settings-close onclick: clearInterval called for health-poll timer', () => {
    // showSettings() sets panel._ndHealthTick = setInterval(...).
    // Clicking the × button must call clearInterval(panel._ndHealthTick)
    // so the 1 Hz health-poll stops when the panel is dismissed.
    const dom = withFakeDom();
    const core = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            dom.sandboxBeforeRun(sandbox);
            // Make setInterval return a recognisable sentinel handle.
            sandbox.setInterval = () => 42;
        },
    });

    const det = core.createNoteDetector();
    det._showSettings();

    const panel = dom.getPanel();
    assert.equal(panel._ndHealthTick, 42, 'setInterval handle must be stored in panel._ndHealthTick');

    const closeBtn = panel.querySelector('.nd-settings-close');
    assert.ok(typeof closeBtn.onclick === 'function', 'close button must have onclick wired');

    closeBtn.onclick();

    assert.ok(
        dom.clearIntervalCalls.includes(42),
        'clearInterval(42) must be called when the close button is clicked',
    );

    det.destroy();
});
