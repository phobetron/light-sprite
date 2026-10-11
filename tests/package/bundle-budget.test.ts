import assert from 'node:assert/strict';
import { beforeAll, describe, it } from '@rstest/core';
import { buildConsumerBundles } from '../support/package/bundle-consumers';

const budget = 20 * 1024;

describe('production JavaScript delivery budget', () => {
  let gzipBytes: Awaited<ReturnType<typeof buildConsumerBundles>>;
  beforeAll(async () => { gzipBytes = await buildConsumerBundles(); }, 30_000);

  it('keeps the default controller consumer within 20 KiB gzip', () => {
    assert.ok(gzipBytes.controller <= budget,
      `Default controller: ${gzipBytes.controller} gzip bytes exceeds ${budget}`);
  });

  it('keeps the full public runtime API consumer within 20 KiB gzip', () => {
    assert.ok(gzipBytes['all-exports'] <= budget,
      `Full runtime API: ${gzipBytes['all-exports']} gzip bytes exceeds ${budget}`);
  });
});
