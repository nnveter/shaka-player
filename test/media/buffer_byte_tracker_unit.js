/*! @license
 * Shaka Player
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

describe('BufferByteTracker', () => {
  /** @type {!shaka.media.BufferByteTracker} */
  let tracker;
  const range = (start, end) => ({start, end});

  beforeEach(() => {
    tracker = new shaka.media.BufferByteTracker();
  });

  it('counts partial segments and all ranges beyond gaps', () => {
    tracker.append(1000, [], [range(0, 10)], range(0, 10));
    tracker.append(2000, [range(0, 10)], [range(0, 10), range(20, 30)],
        range(20, 30));
    expect(tracker.bytesAheadOf(5)).toBe(2500);
    expect(tracker.bytesAheadOf(15)).toBe(2000);
    expect(tracker.bytesAheadOf(25)).toBe(1000);
  });

  it('replaces overlapping bytes rather than counting them twice', () => {
    tracker.append(1000, [], [range(0, 10)], range(0, 10));
    tracker.append(2000, [range(0, 10)], [range(0, 10)], range(2, 8));
    expect(tracker.bytesAheadOf(0)).toBe(2400);
    expect(tracker.bytesAheadOf(8)).toBe(200);
  });

  it('does not resurrect data after eviction and a later append', () => {
    tracker.append(1000, [], [range(0, 10)], range(0, 10));
    tracker.synchronize([range(5, 10)]);
    tracker.append(2000, [range(5, 10)], [range(0, 10)], range(0, 5));
    expect(tracker.bytesAheadOf(0)).toBe(2500);
    tracker.synchronize([]);
    expect(tracker.bytesAheadOf(0)).toBe(0);
  });

  it('attributes new bytes to the ranges which actually appeared', () => {
    // Append window clipping is applied by the caller, which scales the bytes.
    tracker.append(1000, [], [range(2, 8)], range(0, 10));
    expect(tracker.bytesAheadOf(0)).toBe(1000);
  });

  it('leaves no gaps when segments are longer than the manifest says', () => {
    tracker.append(1000, [], [range(0, 10.02)], range(0, 10));
    tracker.append(1000, [range(0, 10.02)], [range(0, 20.04)],
        range(10, 20));
    // The manifest interval overlaps the last 20 ms of the first segment,
    // which is treated as replaced: a 0.1% error, but no gap.
    expect(tracker.bytesAheadOf(0)).toBeCloseTo(1998, 0);
    expect(tracker.learnLimit(1, 500, [range(0, 20.04)])).toBe(true);
  });

  it('leaves no gaps when segments are shorter than the manifest says', () => {
    tracker.append(1000, [], [range(0, 9.98)], range(0, 10));
    tracker.append(1000, [range(0, 9.98)], [range(0, 19.96)],
        range(10, 20));
    expect(tracker.bytesAheadOf(0)).toBeCloseTo(2000, 6);
    expect(tracker.learnLimit(1, 500, [range(0, 19.96)])).toBe(true);
  });

  it('ignores appends which retained nothing', () => {
    tracker.append(1000, [], [], range(0, 10));
    expect(tracker.bytesAheadOf(0)).toBe(0);
    tracker.append(1000, [], [range(0, 10)], range(0, 10));
    expect(tracker.bytesAheadOf(0)).toBe(1000);
  });

  it('never raises a learned budget', () => {
    tracker.append(3000, [], [range(0, 30)], range(0, 30));
    expect(tracker.learnLimit(0, 1000, [range(0, 30)])).toBe(true);
    // More data ahead at a later rejection does not raise the budget.
    tracker.append(2000, [range(0, 30)], [range(0, 40)], range(30, 40));
    expect(tracker.learnLimit(0, 500, [range(0, 40)])).toBe(true);
    // The budget is now 3000 - 500 bytes.
    expect(tracker.shouldWait(30, 400)).toBe(false);
    expect(tracker.shouldWait(30, 600)).toBe(true);
  });

  it('keeps a byte budget through bitrate and segment duration changes', () => {
    tracker.append(3000, [], [range(0, 30)], range(0, 30));
    expect(tracker.learnLimit(0, 1000, [range(0, 30)])).toBe(true);
    expect(tracker.shouldWait(5, 1000)).toBe(true);
    expect(tracker.shouldWait(10, 1000)).toBe(false);
    // A lower bitrate buys more time, without raising the byte budget.
    tracker.synchronize([]);
    tracker.append(3000, [], [range(30, 90)], range(30, 90));
    expect(tracker.shouldWait(40, 1000)).toBe(true);
    expect(tracker.shouldWait(50, 1000)).toBe(false);
    // A heavy VBR segment uses its actual size, not the preceding byte rate.
    expect(tracker.shouldWait(50, 2000)).toBe(true);
    expect(tracker.shouldWait(70, 2000)).toBe(false);
  });

  it('reduces the budget on repeated rejection and terminates recovery', () => {
    tracker.append(3000, [], [range(0, 30)], range(0, 30));
    expect(tracker.learnLimit(0, 1000, [range(0, 30)])).toBe(true);
    expect(tracker.learnLimit(0, 1000, [range(0, 30)])).toBe(true);
    expect(tracker.shouldWait(10, 1000)).toBe(true);
    expect(tracker.learnLimit(0, 1000, [range(0, 30)])).toBe(false);
    expect(tracker.shouldWait(0, 4000)).toBe(false);
  });

  it('does not learn a budget from unaccounted-for buffered data', () => {
    tracker.append(1000, [], [range(0, 10)], range(0, 10));
    expect(tracker.learnLimit(0, 100, [range(0, 20)])).toBe(false);
  });
});
