// The built-in calibration pack was renamed in core from
// slopsmith-diagnostic-basic-guitar.sloppak to feedBack-diagnostic-… (core
// #900). Both names must still be recognised as the diagnostic track, with the
// case-insensitive match the library's filenames need.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('./_loader');

const { filenameLooksDiagnostic } = loadDetectionCore();

test('current core name (feedBack-…) is a diagnostic track', () => {
    assert.strictEqual(
        filenameLooksDiagnostic('diagnostics-builtin/feedBack-diagnostic-basic-guitar.sloppak'), true);
});

test('legacy name (slopsmith-…) is still a diagnostic track', () => {
    assert.strictEqual(
        filenameLooksDiagnostic('diagnostics-builtin/slopsmith-diagnostic-basic-guitar.sloppak'), true);
});

test('ordinary songs are not diagnostic tracks', () => {
    assert.strictEqual(filenameLooksDiagnostic('Uriah Heep - Shadows Of Grief.feedpak'), false);
    assert.strictEqual(filenameLooksDiagnostic(''), false);
    assert.strictEqual(filenameLooksDiagnostic(null), false);
});

test('the launcher points at the pack core seeds today', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    assert.match(src,
        /dlcRelativePath: 'diagnostics-builtin\/feedBack-diagnostic-basic-guitar\.sloppak'/);
});
