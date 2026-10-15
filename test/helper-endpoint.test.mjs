import assert from 'node:assert/strict';
import test from 'node:test';
import { HELPER_PATH } from '../shared/musescore-contract.mjs';
import { helperApiUrl, helperCandidates, parseHelperOrigin } from '../src/helper-endpoint.mjs';

test('an https helper address is kept and a lan http address is refused', () => {
  assert.equal(parseHelperOrigin(' https://helper.example/maestro-ai/ '), 'https://helper.example');
  assert.equal(parseHelperOrigin('http://127.0.0.1:4173'), 'http://127.0.0.1:4173');
  assert.equal(parseHelperOrigin('http://192.168.1.20:4173'), null);
  assert.equal(parseHelperOrigin('not a url'), null);
});

test('the published page tries the saved helper, then this machine', () => {
  assert.deepEqual(
    helperCandidates('https://rico-rodriguez.github.io', 'https://helper.example'),
    ['https://helper.example', '', 'http://127.0.0.1:4173'],
  );
  assert.deepEqual(
    helperCandidates('http://127.0.0.1:4173', ''),
    [''],
  );
  assert.equal(
    helperApiUrl('http://127.0.0.1:4173', HELPER_PATH),
    'http://127.0.0.1:4173/maestro-ai/api/musescore',
  );
  assert.equal(helperApiUrl('', HELPER_PATH), HELPER_PATH);
});
