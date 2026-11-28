import { describe, expect, it } from 'vitest';
import { parseRoute, rememberSample, sampleOf } from '../web/src/api-floor.js';

// An analysis opened from a sample goes back to that sample (QLIMS display check 22 Nov, item 5).
describe('back from an analysis to its sample', () => {
  it('reads #/sample/<id> and remembers the sample an analysis was opened from', () => {
    expect(parseRoute('#/sample/12')).toEqual({ sample: 12 });
    expect(parseRoute('#/analysis/5')).toEqual({ analysis: 5 });
    expect(sampleOf(5)).toBeNull();
    rememberSample(5, 12, 'LS2600012');
    expect(sampleOf(5)).toEqual({ analysis: 5, sample: 12, no: 'LS2600012' });
    expect(sampleOf(6)).toBeNull();
  });
});
