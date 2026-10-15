import assert from 'node:assert/strict';
import test from 'node:test';
import { HELPER_PATH } from '../shared/musescore-contract.mjs';
import { helperApiUrl, helperCandidates } from '../src/helper-endpoint.mjs';

test('the page tries the hosted score service, then itself', () => {
  assert.deepEqual(helperCandidates('https://rico-rodriguez.github.io'), ['']);
  assert.equal(helperApiUrl('', HELPER_PATH), HELPER_PATH);
  assert.equal(
    helperApiUrl('https://maestro.example', HELPER_PATH),
    'https://maestro.example/maestro-ai/api/musescore',
  );
});
