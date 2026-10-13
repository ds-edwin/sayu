import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appBaseUrl} from '../lib/app-url.ts';
test('redirect retains repository path and discards auth parameters', () => {
  assert.equal(appBaseUrl('https://ds-edwin.github.io/sayu/?code=x#state=y'), 'https://ds-edwin.github.io/sayu/');
  assert.equal(appBaseUrl('https://ds-edwin.github.io/sayu/index.html#code=x'), 'https://ds-edwin.github.io/sayu/');
  assert.equal(appBaseUrl('https://example.org/'), 'https://example.org/');
});
