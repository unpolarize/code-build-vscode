import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDesignArtboards,
  collectDesignArtboards,
  formatArtboardAcceptanceBullets
} from '../../src/shared/designArtboard';

// Fixture modeled on a Claude /design research-preview turn: the agent
// presents labeled artboard variants as markdown links, the user picks one,
// and later turns repeat the URL bare (sometimes with query params).
const DESIGN_TURN = `I've created three artboard variants for the settings page:

- [Variant A — compact sidebar](https://claude.ai/public/artifacts/9f2c1a8e-11aa-4bde-9c01-aa10cfe2b901)
- [Variant B — tabbed layout](https://claude.ai/public/artifacts/4d7e33b2-90cd-4f0a-8f4e-bb21dfe3c012)
- **Variant C** — https://claude.ai/design/7a1b52c9-4e6d-4f2b-8d3e-cc32efa4d123

Pick one and I'll implement it.`;

const FOLLOWUP_TURN = `Great choice. Implementing against
https://claude.ai/public/artifacts/4d7e33b2-90cd-4f0a-8f4e-bb21dfe3c012?fullscreen=true now.`;

describe('extractDesignArtboards', () => {
  it('finds markdown-linked artboards with their link text as label', () => {
    const refs = extractDesignArtboards(DESIGN_TURN);
    assert.equal(refs.length, 3);
    assert.deepEqual(refs[0], {
      url: 'https://claude.ai/public/artifacts/9f2c1a8e-11aa-4bde-9c01-aa10cfe2b901',
      label: 'Variant A — compact sidebar'
    });
    assert.deepEqual(refs[1], {
      url: 'https://claude.ai/public/artifacts/4d7e33b2-90cd-4f0a-8f4e-bb21dfe3c012',
      label: 'Variant B — tabbed layout'
    });
  });

  it('labels a bare URL from a same-line "Variant X" prefix', () => {
    const refs = extractDesignArtboards(DESIGN_TURN);
    assert.deepEqual(refs[2], {
      url: 'https://claude.ai/design/7a1b52c9-4e6d-4f2b-8d3e-cc32efa4d123',
      label: 'Variant C'
    });
  });

  it('strips query strings and trailing prose punctuation', () => {
    const refs = extractDesignArtboards(
      'See https://claude.ai/artifacts/abc123, then https://claude.ai/design/def456?x=1.'
    );
    assert.deepEqual(
      refs.map((r) => r.url),
      ['https://claude.ai/artifacts/abc123', 'https://claude.ai/design/def456']
    );
  });

  it('ignores non-artboard claude.ai URLs and other hosts', () => {
    const refs = extractDesignArtboards(
      'https://claude.ai/chat/xyz and https://example.com/artifacts/abc are not artboards'
    );
    assert.equal(refs.length, 0);
  });

  it('returns [] on empty input', () => {
    assert.deepEqual(extractDesignArtboards(''), []);
  });
});

describe('collectDesignArtboards', () => {
  it('dedupes across turns, keeping the first labeled introduction', () => {
    const refs = collectDesignArtboards([DESIGN_TURN, undefined, FOLLOWUP_TURN]);
    assert.equal(refs.length, 3);
    const b = refs.find((r) => r.url.endsWith('bb21dfe3c012'));
    assert.equal(b?.label, 'Variant B — tabbed layout');
  });

  it('backfills a label when a later turn names a previously bare URL', () => {
    const refs = collectDesignArtboards([
      'Draft: https://claude.ai/artifacts/abc123',
      'Final pick: [Settings v2](https://claude.ai/artifacts/abc123)'
    ]);
    assert.deepEqual(refs, [
      { url: 'https://claude.ai/artifacts/abc123', label: 'Settings v2' }
    ]);
  });
});

describe('formatArtboardAcceptanceBullets', () => {
  it('emits one self-contained acceptance bullet with label and provenance', () => {
    const bullet = formatArtboardAcceptanceBullets(
      { url: 'https://claude.ai/artifacts/abc123', label: 'Variant B' },
      { boundAt: '2026-09-07', sessionId: 'sess-1' }
    );
    assert.equal(
      bullet,
      '- Implement against the chosen design artboard: **Variant B** — https://claude.ai/artifacts/abc123 (bound from Code Build /design pick, 2026-09-07, session sess-1)'
    );
  });

  it('sanitizes markdown metacharacters and newlines out of the label', () => {
    const bullet = formatArtboardAcceptanceBullets({
      url: 'https://claude.ai/artifacts/abc123',
      label: '**Variant\n[B]** `(final)`'
    });
    assert.equal(
      bullet,
      '- Implement against the chosen design artboard: **Variant B final** — https://claude.ai/artifacts/abc123 (bound from Code Build /design pick)'
    );
  });

  it('keeps dots inside artboard URL paths', () => {
    const refs = extractDesignArtboards('See https://claude.ai/artifacts/v1.2/board-a.');
    assert.deepEqual(refs.map((r) => r.url), ['https://claude.ai/artifacts/v1.2/board-a']);
  });

  it('omits the label segment when unlabeled', () => {
    const bullet = formatArtboardAcceptanceBullets({ url: 'https://claude.ai/artifacts/abc123' });
    assert.equal(
      bullet,
      '- Implement against the chosen design artboard: https://claude.ai/artifacts/abc123 (bound from Code Build /design pick)'
    );
  });
});
