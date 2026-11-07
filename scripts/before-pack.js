// electron-builder beforePack hook.
//
// The assistant runs on the Claude runtime that @anthropic-ai/claude-agent-sdk ships as one
// optional npm package per platform (claude-agent-sdk-darwin-arm64, ...-darwin-x64, ...). npm only
// installs the package for the machine it runs on, so a macOS runner has just one of the two. The
// universal Mac build packs the app once per architecture from the same node_modules and then merges
// the two; for that merge (and for the app to work on both kinds of Mac) both macOS runtimes must be
// present. This fetches whichever one is missing. It does nothing for Windows and Linux builds.
//
// A failure here never fails the build: the app then just shows "runtime missing" in the
// assistant panel on the Mac type that lacks its runtime, and everything else works.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCOPE = '@anthropic-ai';
const MAC_PACKAGES = ['claude-agent-sdk-darwin-arm64', 'claude-agent-sdk-darwin-x64'];

/** Makes sure every macOS runtime package exists under nodeModules. Returns the names it fetched. */
function ensureMacRuntimes(nodeModules, log = console.log) {
  const sdkManifest = path.join(nodeModules, SCOPE, 'claude-agent-sdk', 'package.json');
  if (!fs.existsSync(sdkManifest)) return [];
  const optional = JSON.parse(fs.readFileSync(sdkManifest, 'utf8')).optionalDependencies || {};
  const fetched = [];

  for (const name of MAC_PACKAGES) {
    const target = path.join(nodeModules, SCOPE, name);
    if (fs.existsSync(path.join(target, 'package.json'))) continue;
    const version = optional[`${SCOPE}/${name}`];
    if (!version) {
      log(`before-pack: ${SCOPE}/${name} is not an optional dependency of the SDK; skipping`);
      continue;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshuttle-runtime-'));
    try {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const out = execFileSync(npm, ['pack', `${SCOPE}/${name}@${version}`, '--pack-destination', tmp, '--silent'], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      const tarball = path.join(tmp, out.trim().split(/\r?\n/).pop());
      fs.mkdirSync(target, { recursive: true });
      execFileSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1']);
      fetched.push(name);
      log(`before-pack: fetched ${SCOPE}/${name}@${version}`);
    } catch (err) {
      fs.rmSync(target, { recursive: true, force: true });
      log(`before-pack: could not fetch ${SCOPE}/${name}@${version}: ${err.message}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return fetched;
}

exports.ensureMacRuntimes = ensureMacRuntimes;

exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  ensureMacRuntimes(path.join(context.packager.projectDir, 'node_modules'));
};
