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

// Wrap Node builtin and SDK requires in try/catch so the plugin can load on
// Obsidian Mobile where these modules are unavailable. On desktop the real
// module is returned; on mobile a Proxy that throws on use is returned instead.
//
// Two-phase approach:
//   Phase 1 (safeRequireShim): esbuild onResolve/onLoad intercepts source-file
//     imports of Node builtins and the Claude SDK, replacing them with try/catch
//     wrappers. Only source files are shimmed — node_modules imports pass through
//     to esbuild's external resolution.
//   Phase 2 (patchBareNodeRequires): Post-build step that scans main.js for any
//     remaining bare require("builtin") calls (from bundled node_modules code)
//     and replaces them with __safeReq("builtin") backed by a try/catch helper.
const safeRequireShim = {
  name: 'safe-require-shim',
  setup(build) {
    const SAFE_RE = /^(fs|fs\/promises|os|path|child_process|events|stream|@anthropic-ai\/claude-agent-sdk.*)$/;

    build.onResolve({ filter: SAFE_RE }, (args) => {
      if (args.importer?.includes('node_modules')) return;
      return { path: args.path, namespace: 'safe-ext' };
    });

    build.onLoad({ filter: /.*/, namespace: 'safe-ext' }, (args) => ({
      contents: [
        `var m;`,
        `try { m = require("${args.path}"); } catch(e) { m = null; }`,
        `module.exports = m || new Proxy({}, {`,
        `  get(_, k) {`,
        `    if (k === "__esModule") return false;`,
        `    if (k === "default") return module.exports;`,
        `    if (k === "promises") return new Proxy({}, { get(_, k2) { return function() { throw new Error("'${args.path}' unavailable on mobile"); }; } });`,
        `    if (typeof k === "symbol") return undefined;`,
        `    return function() { throw new Error("'${args.path}' unavailable on mobile"); };`,
        `  }`,
        `});`,
      ].join('\n'),
      loader: 'js',
    }));
  },
};

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
        'var __safeReq = function(id) {',
        '  try { return require(id); } catch(e) {',
        '    return new Proxy({}, { get: function(_, k) {',
        '      if (k === "__esModule") return false;',
        '      if (k === "promises") return new Proxy({}, { get: function(_, k2) { return function() { throw new Error(id + " unavailable on mobile"); }; } });',
        '      if (typeof k === "symbol") return undefined;',
        '      return function() { throw new Error(id + " unavailable on mobile"); };',
        '    } });',
        '  }',
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

      await fsPromises.writeFile('main.js', helper + '\n' + code, 'utf-8');
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [safeRequireShim, patchCodexSdkImportMeta, patchBareNodeRequires, copyToObsidian],
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
