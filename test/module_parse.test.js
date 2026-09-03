// Gate: src/main.js must parse as a valid ES module.
//
// The vm-based test loader (_loader.js) runs src/main.js as classic script,
// so duplicate top-level declarations (a SyntaxError in ES modules) are
// invisible to the rest of the suite. This test catches them by running
// `node --input-type=module --check` on the file and asserting exit 0.
// Parsing is purely syntactic — no evaluation, no stubs needed.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('src/main.js parses as a valid ES module (no duplicate top-level declarations)', () => {
    const mainJs = path.join(__dirname, '..', 'src', 'main.js');
    const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--check'],
        { input: require('node:fs').readFileSync(mainJs), encoding: 'utf8' },
    );
    assert.equal(
        result.status, 0,
        'src/main.js failed ES-module parse check — likely a duplicate top-level declaration:\n'
            + (result.stderr || '').trim(),
    );
});
