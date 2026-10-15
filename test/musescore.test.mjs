import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScoreUrl } from '../shared/musescore-contract.mjs';

test('parseScoreUrl accepts musescore.com, www, and the s host', () => {
  assert.equal(
    parseScoreUrl('https://musescore.com/user/9292486/scores/2086216'),
    'https://musescore.com/user/9292486/scores/2086216',
  );
  assert.equal(
    parseScoreUrl('  http://www.musescore.com/user/9292486/scores/2086216  '),
    'http://www.musescore.com/user/9292486/scores/2086216',
  );
  assert.equal(
    parseScoreUrl('https://s.musescore.com/user/9292486/scores/2086216'),
    'https://s.musescore.com/user/9292486/scores/2086216',
  );
});

test('parseScoreUrl rejects a bare id, the mobile host, and other sites', () => {
  assert.equal(parseScoreUrl('2086216'), null);
  assert.equal(parseScoreUrl('https://m.musescore.com/user/9292486/scores/2086216'), null);
  assert.equal(parseScoreUrl('https://example.com/user/9292486/scores/2086216'), null);
  assert.equal(parseScoreUrl(2086216), null);
  assert.equal(parseScoreUrl(''), null);
});
