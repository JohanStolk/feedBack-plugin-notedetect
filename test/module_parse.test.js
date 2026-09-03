// Gate: src/main.js must parse as a valid ES module.
//
// The vm-based test loader (_loader.js) runs src/main.js as classic script,
// so duplicate top-level declarations (a SyntaxError in ES modules) are
// invisible to the rest of the suite. This test catches them by copying
// src/main.js to a temp .mjs file and running `node --check` on it.
// The .mjs extension makes Node parse it as an ES module — no --input-type,
// no stdin piping (stdin transport is unreliable across Node versions).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('src/main.js parses as a valid ES module (no duplicate top-level declarations)', () => {
    const mainJs = path.join(__dirname, '..', 'src', 'main.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-module-parse-'));
    const tmpFile = path.join(tmpDir, 'main.mjs');
    try {
        fs.writeFileSync(tmpFile, fs.readFileSync(mainJs));
        const result = spawnSync(process.execPath, ['--check', tmpFile]);
        assert.equal(
            result.status, 0,
            'src/main.js failed ES-module parse check — likely a duplicate top-level declaration:\n'
                + (result.stderr || '').toString().trim()
                + (result.error ? '\nspawn error: ' + String(result.error) : ''),
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
