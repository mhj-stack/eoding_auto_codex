import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, realpath, unlink, cp } from 'node:fs/promises';
import { prepareRuntime, runtimeFiles, dependencyKey, pythonExecutable } from '../scripts/plugin-bootstrap.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eoding-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(dir, 'plugin'), dataDir = path.join(dir, 'private');
  for (const name of ['src', 'scripts', 'skills/eoding-product-register', 'examples']) await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, 'plugin.json'), '{"name":"fixture","version":"0.2.5"}');
  const manifest = { name: 'fixture', version: '0.2.5', type: 'module', private: true, dependencies: { 'fixture-dependency': '1.0.0' }, engines: { node: '>=22' } };
  const lock = { name: 'fixture', version: '0.2.5', lockfileVersion: 3, requires: true, packages: { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, engines: manifest.engines }, 'node_modules/fixture-dependency': { version: '1.0.0', resolved: 'https://example.com/fixture.tgz', integrity: 'sha512-fixture' } } };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  await writeFile(path.join(root, 'requirements.txt'), 'openpyxl==3.1.5\n');
  await writeFile(path.join(root, 'src/plugin-mcp.mjs'), 'export { marker } from "fixture-dependency"; export const value = 1;');
  await writeFile(path.join(root, 'skills/eoding-product-register/SKILL.md'), 'Fixture instructions.');
  return { dir, root, dataDir, manifest, lock };
}

async function installFixture(target) {
  const moduleDir = path.join(target, 'node_modules/fixture-dependency');
  await mkdir(moduleDir, { recursive: true });
  await writeFile(path.join(moduleDir, 'package.json'), '{"name":"fixture-dependency","type":"module","exports":"./index.mjs"}');
  await writeFile(path.join(moduleDir, 'index.mjs'), 'export const marker = "verified dependency";');
  await mkdir(path.dirname(pythonExecutable(target)), { recursive: true });
  await writeFile(pythonExecutable(target), 'fixture-python');
}

async function noTemporaryEntries(dataDir) {
  for (const name of ['runtimes', 'dependencies']) assert.ok(!(await readdir(path.join(dataDir, name))).some(item => item.startsWith('.setup-') || item.endsWith('.lock')));
}

test('concurrent setup installs once; code, skill and release metadata updates reuse dependencies and keep private jobs', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.dataDir, 'jobs'), { recursive: true });
  await writeFile(path.join(f.dataDir, 'jobs/keep.json'), 'private');
  let count = 0;
  const install = async target => {
    count++;
    assert.deepEqual(JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')), f.manifest);
    await installFixture(target);
    await new Promise(resolve => setTimeout(resolve, 30));
  };
  const [a, b] = await Promise.all([prepareRuntime({ ...f, install }), prepareRuntime({ ...f, install })]);
  assert.equal(a, b); assert.equal(count, 1);
  await writeFile(path.join(f.root, 'src/plugin-mcp.mjs'), 'export { marker } from "fixture-dependency"; export const value = 2;');
  const c = await prepareRuntime({ ...f, install });
  assert.notEqual(c, a); assert.equal(count, 1);
  assert.equal((await import(pathToFileURL(path.join(c, 'src/plugin-mcp.mjs')).href)).value, 2);
  assert.equal((await import(pathToFileURL(path.join(c, 'src/plugin-mcp.mjs')).href)).marker, 'verified dependency');
  await writeFile(path.join(f.root, 'skills/eoding-product-register/SKILL.md'), 'Updated instructions.');
  const d = await prepareRuntime({ ...f, install });
  assert.notEqual(d, c); assert.equal(count, 1);
  f.manifest.version = f.lock.version = f.lock.packages[''].version = '0.2.6';
  f.manifest.name = f.lock.name = f.lock.packages[''].name = 'fixture-release';
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify(f.manifest));
  await writeFile(path.join(f.root, 'package-lock.json'), JSON.stringify(f.lock));
  const e = await prepareRuntime({ ...f, install });
  assert.notEqual(e, d); assert.equal(count, 1);
  assert.equal(await realpath(path.join(a, 'node_modules')), await realpath(path.join(e, 'node_modules')));
  assert.equal(await readFile(pythonExecutable(e), 'utf8'), 'fixture-python');
  assert.equal(await readFile(path.join(f.dataDir, 'jobs/keep.json'), 'utf8'), 'private');
  assert.equal((await readdir(path.join(f.dataDir, 'dependencies'))).length, 1);
  await noTemporaryEntries(f.dataDir);
  t.diagnostic('Installer calls for initial setup + source update: previous=2, split cache=1. Subsequent SKILL/release metadata updates add zero installs.');
});

test('every packaged skill is copied and invalidates the application cache without reinstalling dependencies', async t => {
  const f = await fixture(t);
  const extra = path.join(f.root, 'skills/eoding-content-register');
  await mkdir(path.join(extra, 'references'), { recursive: true });
  await writeFile(path.join(extra, 'SKILL.md'), 'Content instructions.');
  await writeFile(path.join(extra, 'references/contract.md'), 'Content contract.');
  let installs = 0;
  const install = async target => { installs++; await installFixture(target); };
  const first = await prepareRuntime({ ...f, install });
  assert.equal(await readFile(path.join(first, 'skills/eoding-content-register/SKILL.md'), 'utf8'), 'Content instructions.');
  assert.equal(await readFile(path.join(first, 'skills/eoding-content-register/references/contract.md'), 'utf8'), 'Content contract.');
  await writeFile(path.join(extra, 'SKILL.md'), 'Updated content instructions.');
  const second = await prepareRuntime({ ...f, install });
  assert.notEqual(first, second);
  assert.equal(installs, 1);
  await symlink(extra, path.join(f.root, 'skills/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runtimeFiles(f.root), /symlink/);
});

test('failed setup leaves no ready runtime, releases its lock, and permits a clean retry', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareRuntime({ ...f, install: async () => { throw new Error('fixture install failed'); } }), /fixture install failed/);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'runtimes')), []);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'dependencies')), []);
  const target = await prepareRuntime({ ...f, install: installFixture });
  assert.ok(JSON.parse(await readFile(path.join(target, 'READY.json'))).key);
  await noTemporaryEntries(f.dataDir);
});

test('dependency key ignores only root name/version and canonical JSON order while retaining every install input', async t => {
  const f = await fixture(t);
  const baseline = await dependencyKey(f.root);
  const changed = async (name, value) => { await writeFile(path.join(f.root, name), JSON.stringify(value)); return dependencyKey(f.root); };
  const manifest = { ...f.manifest, name: 'new-name', version: '9.9.9' };
  assert.equal(await changed('package.json', manifest), baseline);
  const lock = structuredClone(f.lock); lock.name = 'new-name'; lock.version = '9.9.9'; lock.packages[''].name = 'new-name'; lock.packages[''].version = '9.9.9';
  assert.equal(await changed('package-lock.json', lock), baseline);
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify(Object.fromEntries(Object.entries(manifest).reverse()), null, 2));
  assert.equal(await dependencyKey(f.root), baseline);
  assert.notEqual(await changed('package.json', { ...manifest, description: 'retained; only name/version are ignored' }), baseline);
  await changed('package.json', manifest);
  assert.notEqual(await changed('package.json', { ...manifest, engines: { node: '>=24' } }), baseline);
  await changed('package.json', manifest);
  for (const mutate of [value => { value.lockfileVersion = 4; }, value => { value.packages[''].dependencies['fixture-dependency'] = '2.0.0'; }, value => { value.packages['node_modules/fixture-dependency'].version = '2.0.0'; }, value => { value.packages['node_modules/fixture-dependency'].integrity = 'sha512-changed'; }, value => { value.packages['node_modules/fixture-dependency'].resolved = 'https://example.com/changed.tgz'; }]) {
    const altered = structuredClone(lock); mutate(altered);
    assert.notEqual(await changed('package-lock.json', altered), baseline);
  }
  await changed('package-lock.json', lock);
  await writeFile(path.join(f.root, 'requirements.txt'), 'openpyxl==3.1.6\n');
  assert.notEqual(await dependencyKey(f.root), baseline);
  const compatibility = { platform: process.platform, arch: process.arch, nodeMajor: process.versions.node.split('.')[0], nodeAbi: process.versions.modules, installerSchema: 1 };
  await writeFile(path.join(f.root, 'requirements.txt'), 'openpyxl==3.1.5\n');
  assert.equal(await dependencyKey(f.root, compatibility), baseline);
  for (const key of Object.keys(compatibility)) assert.notEqual(await dependencyKey(f.root, { ...compatibility, [key]: `${compatibility[key]}-changed` }), baseline);
});

test('actual lock dependency and requirements changes cause new installs instead of stale reuse', async t => {
  const f = await fixture(t); let installs = 0;
  const install = async target => { installs++; await installFixture(target); };
  const a = await prepareRuntime({ ...f, install });
  f.lock.packages['node_modules/fixture-dependency'].integrity = 'sha512-new';
  await writeFile(path.join(f.root, 'package-lock.json'), JSON.stringify(f.lock));
  const b = await prepareRuntime({ ...f, install });
  assert.notEqual(await realpath(path.join(a, 'node_modules')), await realpath(path.join(b, 'node_modules')));
  await writeFile(path.join(f.root, 'requirements.txt'), 'openpyxl==3.1.6\n');
  const c = await prepareRuntime({ ...f, install });
  assert.notEqual(await realpath(path.join(b, 'python')), await realpath(path.join(c, 'python')));
  assert.equal(installs, 3);
});

test('concurrent different application versions with the same dependencies still install only once', async t => {
  const f = await fixture(t), alternate = path.join(f.dir, 'plugin-next');
  await cp(f.root, alternate, { recursive: true });
  await writeFile(path.join(alternate, 'src/plugin-mcp.mjs'), 'export const value = 2;');
  let installs = 0;
  const install = async target => { installs++; await new Promise(resolve => setTimeout(resolve, 30)); await installFixture(target); };
  const [a, b] = await Promise.all([prepareRuntime({ ...f, install }), prepareRuntime({ ...f, root: alternate, install })]);
  assert.notEqual(a, b); assert.equal(installs, 1);
  assert.equal(await realpath(path.join(a, 'node_modules')), await realpath(path.join(b, 'node_modules')));
  await noTemporaryEntries(f.dataDir);
});

test('external cache roots and redirected runtime dependency links are rejected without adoption or install', async t => {
  const f = await fixture(t), outside = path.join(f.dir, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'keep.txt'), 'outside data');
  await mkdir(f.dataDir);
  await symlink(outside, path.join(f.dataDir, 'dependencies'), process.platform === 'win32' ? 'junction' : 'dir');
  let installs = 0;
  const install = async target => { installs++; await installFixture(target); };
  await assert.rejects(() => prepareRuntime({ ...f, install }), /symlink|external path/);
  assert.equal(installs, 0);
  await unlink(path.join(f.dataDir, 'dependencies'));
  const target = await prepareRuntime({ ...f, install });
  await unlink(path.join(target, 'node_modules'));
  await symlink(outside, path.join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => prepareRuntime({ ...f, install }), /does not match its private cache/);
  assert.equal(installs, 1);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside data');
});

test('a redirected dependency directory is rejected and failed setup does not delete its target', async t => {
  const f = await fixture(t), outside = path.join(f.dir, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'keep.txt'), 'outside data');
  await assert.rejects(() => prepareRuntime({ ...f, install: async target => {
    await installFixture(target);
    await rm(path.join(target, 'node_modules'), { recursive: true });
    await symlink(outside, path.join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  } }), /symlink|external path/);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside data');
  await noTemporaryEntries(f.dataDir);
  assert.equal((await readdir(path.join(f.dataDir, 'dependencies'))).length, 0);
});

test('cache receipts and setup locks cannot be external links or claim a different dependency key', async t => {
  const f = await fixture(t), outside = path.join(f.dir, 'outside.json');
  await writeFile(outside, '{}');
  await mkdir(path.join(f.dataDir, 'runtimes'), { recursive: true });
  const lockFile = path.join(f.dataDir, 'runtimes/setup.lock');
  // Windows file symlinks may require developer mode, so verify a junction is also
  // rejected for these file-only entries without following its contents.
  await symlink(path.dirname(outside), lockFile, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => prepareRuntime({ ...f, install: installFixture }), /setup lock must be a regular file/);
  await unlink(lockFile);
  const target = await prepareRuntime({ ...f, install: installFixture });
  const receiptFile = path.join(target, 'READY.json');
  const saved = JSON.parse(await readFile(receiptFile, 'utf8'));
  await writeFile(receiptFile, JSON.stringify({ ...saved, dependencyKey: '0'.repeat(64), dependencyPath: path.dirname(outside) }));
  await assert.rejects(() => prepareRuntime({ ...f, install: installFixture }), /dependencies do not match/);
  await unlink(receiptFile);
  await symlink(path.dirname(outside), receiptFile, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => prepareRuntime({ ...f, install: installFixture }), /receipt must be a regular file/);
  assert.equal(await readFile(outside, 'utf8'), '{}');
});

test('runtime allowlist excludes local state and tests, and rejects linked source directories', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.local'));
  await writeFile(path.join(f.root, '.local/cookies.json'), 'private');
  await mkdir(path.join(f.root, 'tests'));
  await writeFile(path.join(f.root, 'tests/private.json'), 'private');
  assert.ok(!(await runtimeFiles(f.root)).some(name => name.includes('.local') || name.startsWith('tests/')));
  await symlink(path.join(f.root, '.local'), path.join(f.root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runtimeFiles(f.root), /symlink/);
});

test('portable plugin and optional parent marketplace resolve to the same bootstrap', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  // Tests run inside plugins/eoding-product-register/tests.
  const catalogPath = path.resolve(repo, '.agents/plugins/marketplace.json');
  const catalog = await readFile(catalogPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  // Installed/portable bundles have no parent marketplace repository. Validate
  // their actual entrypoint; when a catalog exists, preserve its resolution check.
  const item = catalog ? catalog.plugins.find(item => item.name === 'eoding-product-register') : { name: 'eoding-product-register' };
  if (catalog) assert.equal(catalog.name, 'eoding-auto-codex');
  const root = catalog ? path.resolve(path.dirname(path.dirname(path.dirname(catalogPath))), item.source.path) : fileURLToPath(new URL('../', import.meta.url));
  const plugin = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'));
  const config = JSON.parse(await readFile(path.join(root, 'mcp.json'), 'utf8'));
  assert.equal(plugin.name, item.name);
  assert.deepEqual(config.mcpServers[item.name].args, ['${PLUGIN_ROOT}/scripts/plugin-start.mjs']);
});
