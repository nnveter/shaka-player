/*! @license
 * Shaka Player
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.media.BufferByteTracker');


/**
 * Estimates retained bytes from successful media appends. Container bytes are
 * not the browser's allocation size; partial ranges assume a uniform byte rate.
 * The learned limit is a working budget ahead of the playhead, not a device
 * memory limit. Each physical SourceBuffer owns its own tracker.
 *
 * The limit is only ever lowered, like StreamingEngine's buffering scale, and
 * lasts as long as the SourceBuffer. Being in bytes, it does not depend on the
 * variant's bitrate. Only appends of whole segments at known media times are
 * tracked; chunked input, sequence mode and raw formats are not.
 */
shaka.media.BufferByteTracker = class {
  constructor() {
    /** @private {!Array<{start: number, end: number, bytes: number}>} */
    this.entries_ = [];

    /** @private {number} */
    this.limit_ = Infinity;
  }

  /**
   * Record a successful append, including replacement of existing samples.
   * Bytes are attributed to the newly buffered ranges, which are exact. The
   * expected media interval, when known, only locates samples that replaced
   * data already buffered, since replacement does not change the ranges.
   * Manifest times can be tens of milliseconds off (rounded HLS durations,
   * audio frame boundaries, composition offsets); using them for new data
   * would leave unaccounted gaps between segments. Init segments must not be
   * passed here.
   *
   * @param {number} bytes Bytes retained inside the append window.
   * @param {!Array<shaka.extern.BufferedRange>} before
   * @param {!Array<shaka.extern.BufferedRange>} after
   * @param {shaka.extern.BufferedRange} interval The expected media times,
   *   clipped to the append window.
   */
  append(bytes, before, after, interval) {
    const BufferByteTracker = shaka.media.BufferByteTracker;
    this.synchronize(after);
    // Data the browser evicted while appending was not replaced.
    const ranges = BufferByteTracker.subtract_(after, before).concat(
        BufferByteTracker.intersect_(
            BufferByteTracker.intersect_([interval], before), after));
    const duration = ranges.reduce((sum, r) => sum + r.end - r.start, 0);
    if (duration <= 0) {
      // Nothing was retained (for example, entirely outside the window).
      return;
    }
    for (const range of ranges) {
      const kept = [];
      for (const entry of this.entries_) {
        const pieces = shaka.media.BufferByteTracker.subtract_(
            [entry], [range]);
        for (const piece of pieces) {
          kept.push({
            start: piece.start,
            end: piece.end,
            bytes: entry.bytes * (piece.end - piece.start) /
                (entry.end - entry.start),
          });
        }
      }
      kept.push({
        start: range.start,
        end: range.end,
        bytes: bytes * (range.end - range.start) / duration,
      });
      this.entries_ = kept;
    }
    this.synchronize(after);
  }

  /**
   * Discard bytes evicted by either the browser or remove(). This is permanent:
   * a later append to the same times must not resurrect old byte counts.
   * @param {!Array<shaka.extern.BufferedRange>} ranges
   */
  synchronize(ranges) {
    const kept = [];
    for (const entry of this.entries_) {
      for (const range of ranges) {
        const start = Math.max(entry.start, range.start);
        const end = Math.min(entry.end, range.end);
        if (end > start) {
          kept.push({start, end,
            bytes: entry.bytes * (end - start) / (entry.end - entry.start)});
        }
      }
    }
    // Coalesce equal-density adjacent chunks, without losing VBR boundaries.
    kept.sort((a, b) => a.start - b.start);
    this.entries_ = [];
    for (const entry of kept) {
      const last = this.entries_[this.entries_.length - 1];
      if (last && last.end == entry.start &&
          Math.abs(last.bytes / (last.end - last.start) -
              entry.bytes / (entry.end - entry.start)) < 0.01) {
        last.end = entry.end;
        last.bytes += entry.bytes;
      } else {
        this.entries_.push(entry);
      }
    }
  }

  /**
   * @param {number} time
   * @return {number}
   */
  bytesAheadOf(time) {
    return this.entries_.reduce((sum, entry) => {
      const duration = Math.max(0, entry.end - Math.max(time, entry.start));
      return sum + entry.bytes * duration / (entry.end - entry.start);
    }, 0);
  }

  /**
   * Only learn from fully accounted-for ranges. A repeated rejection must
   * lower the budget, even when Firefox's accepted overshoot is still present.
   * @param {number} time
   * @param {number} rejectedBytes
   * @param {!Array<shaka.extern.BufferedRange>} ranges
   * @return {boolean} Whether waiting for playback can make this append fit.
   */
  learnLimit(time, rejectedBytes, ranges) {
    this.synchronize(ranges);
    const missing = shaka.media.BufferByteTracker.subtract_(ranges,
        this.entries_);
    if (missing.some((r) => r.end - Math.max(r.start, time) > 0.001)) {
      return false;
    }
    const ahead = this.bytesAheadOf(time);
    const limit = Math.min(ahead, this.limit_ - rejectedBytes);
    if (!Number.isFinite(limit) || rejectedBytes <= 0 ||
        limit <= rejectedBytes) {
      return false;
    }
    this.limit_ = limit;
    return true;
  }

  /**
   * @param {number} time
   * @param {number} bytes
   * @return {boolean}
   */
  shouldWait(time, bytes) {
    // An oversized segment needs the normal recovery path, not an endless
    // wait for a budget smaller than the segment itself.
    return bytes < this.limit_ &&
        this.bytesAheadOf(time) + bytes > this.limit_;
  }

  /**
   * @param {number} time
   * @return {boolean}
   */
  isFull(time) {
    return this.bytesAheadOf(time) >= this.limit_;
  }

  /**
   * @param {!Array<shaka.extern.BufferedRange>} ranges
   * @param {!Array<shaka.extern.BufferedRange>} kept
   * @return {!Array<shaka.extern.BufferedRange>}
   * @private
   */
  static intersect_(ranges, kept) {
    const BufferByteTracker = shaka.media.BufferByteTracker;
    return BufferByteTracker.subtract_(ranges,
        BufferByteTracker.subtract_(ranges, kept));
  }

  /**
   * @param {!Array<shaka.extern.BufferedRange>} ranges
   * @param {!Array<shaka.extern.BufferedRange>} removed
   * @return {!Array<shaka.extern.BufferedRange>}
   * @private
   */
  static subtract_(ranges, removed) {
    let result = ranges.map((r) => ({start: r.start, end: r.end}));
    for (const cut of removed) {
      const next = [];
      for (const range of result) {
        if (cut.end <= range.start || cut.start >= range.end) {
          next.push(range);
        } else {
          if (range.start < cut.start) {
            next.push({start: range.start, end: cut.start});
          }
          if (range.end > cut.end) {
            next.push({start: cut.end, end: range.end});
          }
        }
      }
      result = next;
    }
    return result;
  }
};
