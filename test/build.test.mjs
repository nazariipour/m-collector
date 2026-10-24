import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSubscription } from '../scripts/build.mjs';

const config = {
  owner: 'example', repository: 'configs', branch: 'main',
  directories: ['app', 'mci', 'mtn'], optionalFormatDirectories: ['app'],
  schemes: ['vless', 'ss'],
};
const first = 'vless://a@example.com:443#One';
const second = 'ss://b@example.org:80#Two';

function transport(files, failurePath) {
  return async (url) => {
    if (url.includes('/git/trees/')) return {
      sha: 'a'.repeat(40), truncated: false,
      tree: Object.keys(files).map((path) => ({ path, type: 'blob' })),
    };
    const path = new URL(url).pathname.split('/').slice(4).join('/');
    assert.ok(url.includes('/' + 'a'.repeat(40) + '/'));
    if (path === failurePath) throw new Error('HTTP 503');
    assert.ok(Object.hasOwn(files, path), path);
    return files[path];
  };
}

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mahsa-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('discovers new files, deduplicates exact URIs, and reports optional opaque app files', async (t) => {
  const directory = await sandbox(t);
  const files = {
    'app/sub.txt': Buffer.from([255, 0, 128]).toString('base64'),
    'app/new.txt': first,
    'mci/sub_1.txt': Buffer.from(first + '\n' + second).toString('base64'),
    'mtn/new/nodes.txt': second,
    'mtn/empty.txt': '',
    'other/ignored.txt': 'garbage',
    'mci/README.md': 'garbage',
  };
  const report = await buildSubscription(config, directory, transport(files));
  const plain = await readFile(join(directory, 'all.txt'), 'utf8');
  const encoded = await readFile(join(directory, 'all-base64.txt'), 'utf8');
  assert.equal(plain, `${first}\n${second}\n`);
  assert.equal(Buffer.from(encoded.trim(), 'base64').toString('utf8'), plain);
  assert.equal(report.uniqueCount, 2);
  assert.equal(report.duplicatesRemoved, 2);
  assert.equal(report.files.length, 5);
  assert.equal(report.files.find((file) => file.path === 'app/sub.txt').status, 'unsupported');
});

test('keeps prior outputs when any source download fails', async (t) => {
  const directory = await sandbox(t);
  await writeFile(join(directory, 'all.txt'), 'previous');
  await assert.rejects(buildSubscription(config, directory,
    transport({ 'mci/one.txt': first, 'mtn/two.txt': second }, 'mtn/two.txt')));
  assert.equal(await readFile(join(directory, 'all.txt'), 'utf8'), 'previous');
});

test('keeps prior outputs when a required file changes to an unsupported format', async (t) => {
  const directory = await sandbox(t);
  await writeFile(join(directory, 'all.txt'), 'previous');
  await assert.rejects(buildSubscription(config, directory,
    transport({ 'mci/one.txt': first, 'mtn/two.txt': 'not a subscription' })));
  assert.equal(await readFile(join(directory, 'all.txt'), 'utf8'), 'previous');
});

test('refuses to publish an empty aggregate', async (t) => {
  const directory = await sandbox(t);
  await assert.rejects(buildSubscription(config, directory, transport({ 'mci/empty.txt': '' })));
});

test('keeps all prior outputs when a required file contains malformed Base64', async (t) => {
  const directory = await sandbox(t);
  const names = ['all.txt', 'all-base64.txt', 'report.json'];
  for (const name of names) await writeFile(join(directory, name), `previous-${name}`);
  await assert.rejects(buildSubscription(config, directory,
    transport({ 'mci/one.txt': first, 'mtn/two.txt': 'dmxlc3M6Ly9h==' })));
  for (const name of names) {
    assert.equal(await readFile(join(directory, name), 'utf8'), `previous-${name}`);
  }
});

test('refuses a truncated tree', async (t) => {
  const directory = await sandbox(t);
  await assert.rejects(buildSubscription(config, directory, async () => ({
    sha: 'a'.repeat(40), truncated: true, tree: [],
  })));
});

test('produces identical files for identical upstream data', async (t) => {
  const directory = await sandbox(t);
  const fetcher = transport({ 'mci/one.txt': first });
  await buildSubscription(config, directory, fetcher);
  const before = await readFile(join(directory, 'report.json'), 'utf8');
  await buildSubscription(config, directory, fetcher);
  assert.equal(await readFile(join(directory, 'report.json'), 'utf8'), before);
});
