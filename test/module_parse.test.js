// Gate: every file under src/ must parse as a valid ES module.
//
// The vm-based test loader (_loader.js) runs src/main.js as classic script,
// so duplicate top-level declarations (a SyntaxError in ES modules) are
// invisible to the rest of the suite. This test catches them by copying
// each src/*.js file to a temp .mjs file and running `node --check` on it.
// The .mjs extension makes Node parse it as an ES module — no --input-type,
// no stdin piping (stdin transport is unreliable across Node versions).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SRC_DIR = path.join(__dirname, '..', 'src');

function checkAsEsModule(filePath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-module-parse-'));
    const tmpFile = path.join(tmpDir, path.basename(filePath).replace(/\.js$/, '.mjs'));
    try {
        fs.writeFileSync(tmpFile, fs.readFileSync(filePath));
        const result = spawnSync(process.execPath, ['--check', tmpFile]);
        assert.equal(
            result.status, 0,
            `${path.relative(SRC_DIR, filePath)} failed ES-module parse check:\n`
                + (result.stderr || '').toString().trim()
                + (result.error ? '\nspawn error: ' + String(result.error) : ''),
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// One test per file so a failure names the exact file.
for (const name of fs.readdirSync(SRC_DIR).filter(n => n.endsWith('.js'))) {
    test(`src/${name} parses as a valid ES module`, () => {
        checkAsEsModule(path.join(SRC_DIR, name));
    });
}
