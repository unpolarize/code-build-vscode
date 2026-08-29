import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatLagLine } from '../../src/host/eventLoopLag';

describe('event-loop lag log line', () => {
  it('tags STALL when p99 is above 200 ms', () => {
    assert.equal(formatLagLine(12.34, 201), '[lag] p50=12.3ms p99=201.0ms STALL');
  });

  it('omits STALL when p99 is within budget', () => {
    assert.equal(formatLagLine(4, 40), '[lag] p50=4.0ms p99=40.0ms');
  });
});
