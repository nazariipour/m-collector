import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSubscription } from '../scripts/parser.mjs';

const schemes = ['ss', 'vless', 'vmess', 'hysteria2'];
const uri = 'vless://test-id@example.com:443?security=tls#Example';

test('preserves URI parameters and removes blank lines in plain input', () => {
  const input = `\uFEFF${uri}\r\n\r\nss://example@example.com:443#Two\r\n`;
  assert.deepEqual(parseSubscription(input, schemes), [uri, 'ss://example@example.com:443#Two']);
});

test('decodes a complete base64 subscription before splitting lines', () => {
  const input = Buffer.from(`${uri}\nss://abc@example.com:80#Two`).toString('base64');
  assert.deepEqual(parseSubscription(input, schemes), [uri, 'ss://abc@example.com:80#Two']);
});

test('accepts unpadded URL-safe base64 with whitespace', () => {
  const input = Buffer.from(`${uri}\n`).toString('base64url');
  assert.deepEqual(parseSubscription(`\n${input}\r\n`, schemes), [uri]);
});

test('treats an empty file as an empty list', () => {
  assert.deepEqual(parseSubscription(' \r\n', schemes), []);
});

test('rejects opaque binary payloads instead of creating garbage entries', () => {
  assert.throws(() => parseSubscription(Buffer.from([255, 254, 0, 150]).toString('base64'), schemes));
});

test('rejects mixed valid and invalid content without silently losing lines', () => {
  assert.throws(() => parseSubscription(`${uri}\nnot-a-config`, schemes));
});

test('rejects unsupported schemes and invalid base64', () => {
  assert.throws(() => parseSubscription('custom://abc', schemes));
  assert.throws(() => parseSubscription('%%%%', schemes));
});

test('rejects surplus padding and noncanonical Base64 trailing bits', () => {
  assert.throws(() => parseSubscription('dmxlc3M6Ly9h==', schemes));
  assert.throws(() => parseSubscription('dmxlc3M6Ly9hYh==', schemes));
});
