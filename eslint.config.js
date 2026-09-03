// Minimal ESLint config for nd-carve-5 gate: catch undefined references in src/*.
// Browser globals + the plugin's own known globals are declared here.
// Only no-undef is enforced — add more rules as the carve progresses.
export default [
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // Browser standard globals
                window: 'readonly', document: 'readonly', console: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly',
                setInterval: 'readonly', clearInterval: 'readonly',
                requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
                localStorage: 'readonly', navigator: 'readonly',
                fetch: 'readonly', URL: 'readonly', location: 'readonly',
                alert: 'readonly', getComputedStyle: 'readonly',
                HTMLElement: 'readonly', HTMLCanvasElement: 'readonly',
                Image: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
                MutationObserver: 'readonly', IntersectionObserver: 'readonly',
                AudioContext: 'readonly', AnalyserNode: 'readonly',
                Float32Array: 'readonly', Uint8Array: 'readonly', Int16Array: 'readonly',
                Promise: 'readonly', Map: 'readonly', Set: 'readonly',
                WeakMap: 'readonly', WeakRef: 'readonly', WeakSet: 'readonly',
                performance: 'readonly', crypto: 'readonly',
                Blob: 'readonly', FileReader: 'readonly',
                ImageBitmap: 'readonly', OffscreenCanvas: 'readonly',
                CanvasRenderingContext2D: 'readonly',
                Worker: 'readonly', MessageChannel: 'readonly',
                AbortController: 'readonly', AbortSignal: 'readonly',
                // Runtime-loaded third-party globals (dynamically imported CDN libs)
                tf: 'readonly',  // TensorFlow.js (loaded lazily from CDN)
                // Plugin-ecosystem globals declared in screen.js entry point
            },
        },
        rules: {
            'no-undef': 'error',
        },
    },
    {
        // Test files are CJS, not ES modules; skip them here (node:test runner handles them)
        files: ['test/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly', module: 'readonly', __dirname: 'readonly',
                __filename: 'readonly', exports: 'readonly', process: 'readonly',
                console: 'readonly', Buffer: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly',
                setInterval: 'readonly', clearInterval: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
        },
    },
];
