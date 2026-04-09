import esbuild from 'esbuild';
import path from 'path';
import process from 'process';
import builtins from 'builtin-modules';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  promises as fsPromises,
  readFileSync,
  rmSync,
} from 'fs';

// Load .env.local if it exists
if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^=]+)=["']?(.+?)["']?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const prod = process.argv[2] === 'production';

const patchCodexSdkImportMeta = {
  name: 'patch-codex-sdk-import-meta',
  setup(build) {
    build.onLoad(
      { filter: /[\\/]node_modules[\\/]@openai[\\/]codex-sdk[\\/]dist[\\/]index\.js$/ },
      async (args) => {
        const contents = await fsPromises.readFile(args.path, 'utf8');
        return {
          contents: contents.replace('createRequire(import.meta.url)', 'createRequire(__filename)'),
          loader: 'js',
        };
      },
    );
  },
};

// Obsidian plugin folder path (set via OBSIDIAN_VAULT env var or .env.local)
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT;
const OBSIDIAN_PLUGIN_PATH = OBSIDIAN_VAULT && existsSync(OBSIDIAN_VAULT)
  ? path.join(OBSIDIAN_VAULT, '.obsidian', 'plugins', 'claudian')
  : null;

// Plugin to copy built files to Obsidian plugin folder
const copyToObsidian = {
  name: 'copy-to-obsidian',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      rmSync(path.join(process.cwd(), '.codex-vendor'), { recursive: true, force: true });

      if (!OBSIDIAN_PLUGIN_PATH) return;

      if (!existsSync(OBSIDIAN_PLUGIN_PATH)) {
        mkdirSync(OBSIDIAN_PLUGIN_PATH, { recursive: true });
      }

      const files = ['main.js', 'manifest.json', 'styles.css'];
      for (const file of files) {
        if (existsSync(file)) {
          copyFileSync(file, path.join(OBSIDIAN_PLUGIN_PATH, file));
          console.log(`Copied ${file} to Obsidian plugin folder`);
        }
      }

      const pluginVendorRoot = path.join(OBSIDIAN_PLUGIN_PATH, '.codex-vendor');
      rmSync(pluginVendorRoot, { recursive: true, force: true });
    });
  }
};

// Post-build step: patch all bare require("node-builtin") calls in the output
// with __safeReq("node-builtin"), backed by a try/catch helper that returns a
// Proxy on failure (mobile). On desktop, require() succeeds and returns the
// real module. The __safeReq helper uses require(id) with a variable, so the
// regex replacement doesn't match it — no circular reference.
const patchBareNodeRequires = {
  name: 'patch-bare-node-requires',
  setup(build) {
    const nodeModules = new Set([
      ...builtins,
      ...builtins.map(m => `node:${m}`),
      'electron',
    ]);

    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;

      let code = await fsPromises.readFile('main.js', 'utf-8');

      // Prepend a safe-require helper that wraps require() in try/catch and
      // returns a no-op Proxy on failure (mobile).
      const helper = [
        // Polyfill Node globals that may be absent on Obsidian Mobile
        'if (typeof process === "undefined") { var process = { env: {}, platform: "android", cwd: function() { return "/"; }, execPath: "" }; }',
        'if (typeof Buffer === "undefined") { var Buffer = { alloc: function(n) { return new Uint8Array(n); }, from: function(d, e) { if (typeof d === "string") { var enc = new TextEncoder(); return enc.encode(d); } return new Uint8Array(d); }, concat: function(a) { var len = 0; for (var i = 0; i < a.length; i++) len += a[i].length; var r = new Uint8Array(len); var off = 0; for (var i = 0; i < a.length; i++) { r.set(a[i], off); off += a[i].length; } return r; }, isBuffer: function() { return false; } }; }',
        'if (typeof global === "undefined") { var global = globalThis; }',
        '',
        'var __safeReq = function(id) {',
        '  try { var r = require(id); if (r && typeof r === "object" && Object.keys(r).length > 0) return r; } catch(e) {}',
        '  var p = new Proxy({}, {',
        '      getPrototypeOf: function() { return p; },',
        '      get: function(_, k) {',
        '        if (k === "__esModule") return false;',
        '        if (k === "default") return p;',
        '        if (k === "promises") return new Proxy({}, { getPrototypeOf: function() { return this; }, get: function(_, k2) { return function() { return ""; }; } });',
        '        if (typeof k === "symbol") return undefined;',
        '        return function() { return ""; };',
        '      }',
        '    });',
        '  return p;',
        '};',
      ].join('\n');

      // Replace bare require("node-builtin") with __safeReq("node-builtin").
      // This catches requires from bundled node_modules that esbuild externalised.
      code = code.replace(/\brequire\("([^"]+)"\)/g, (match, mod) => {
        if (nodeModules.has(mod)) {
          return `__safeReq("${mod}")`;
        }
        return match;
      });

      // Strip __toESM wrappers around __safeReq calls. esbuild's __toESM
      // creates an intermediate object that breaks Proxy property delegation
      // on mobile WebView. Removing it gives code the module (or Proxy)
      // directly — safe because source code uses os.homedir(), not
      // os.default.homedir().
      code = code.replace(/__toESM\(__safeReq\("([^"]+)"\)(?:,\s*\d+)?\)/g, '__safeReq("$1")');

      await fsPromises.writeFile('main.js', helper + '\n' + code, 'utf-8');
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [patchCodexSdkImportMeta, patchBareNodeRequires, copyToObsidian],
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
    ...builtins.map(m => `node:${m}`),
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
