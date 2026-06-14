'use strict';

/**
 * Sequenced scrollback for one session, so an attach can say "I have everything
 * up to seq N" and be sent only the tail instead of the whole screen.
 *
 * `seq` counts characters, not chunks: it is the total ever written. That makes
 * since(n) an arithmetic question and survives chunk re-splitting.
 */
class RingBuffer {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    /** @type {string[]} */
    this.chunks = [];
    this.seq = 0;
    /** Characters dropped off the front. */
    this.dropped = 0;
    this.size = 0;
  }

  append(data) {
    if (!data) return this.seq;
    this.chunks.push(data);
    this.size += data.length;
    this.seq += data.length;
    this.trim();
    return this.seq;
  }

  trim() {
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const head = this.chunks.shift();
      this.size -= head.length;
      this.dropped += head.length;
    }
    // A single chunk larger than the cap still has to shrink, or one noisy
    // write pins the buffer above its limit forever.
    if (this.size > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0];
      const keep = only.slice(only.length - this.maxBytes);
      this.dropped += only.length - keep.length;
      this.size = keep.length;
      this.chunks[0] = keep;
    }
  }

  /** The last `count` characters held, without joining what precedes them. */
  tail(count) {
    if (count <= 0) return '';
    const parts = [];
    let have = 0;
    for (let i = this.chunks.length - 1; i >= 0 && have < count; i--) {
      parts.push(this.chunks[i]);
      have += this.chunks[i].length;
    }
    const joined = parts.reverse().join('');
    return have > count ? joined.slice(have - count) : joined;
  }

  /**
   * Everything after `sinceSeq`.
   *
   * The already-up-to-date case answers before anything is concatenated: it is
   * the one a reconnecting client hits on every attach, and joining a full
   * scrollback to return an empty string blocked the event loop for
   * milliseconds at a time.
   *
   * @param {number} [sinceSeq] omit or pass 0 for the full retained buffer
   * @returns {{data: string, seq: number, truncated: boolean}}
   *   `truncated` means the caller asked for bytes that have already aged out,
   *   so the client must clear its screen before writing this.
   */
  since(sinceSeq) {
    const from = Number.isFinite(sinceSeq) ? sinceSeq : 0;
    if (from >= this.seq) return { data: '', seq: this.seq, truncated: false };
    const start = Math.max(from, this.dropped);
    return {
      data: this.tail(this.seq - start),
      seq: this.seq,
      truncated: from > 0 && from < this.dropped,
    };
  }

  /**
   * Forgets the retained text without rewinding the wire sequence. `dropped`
   * moves with it, so a client still holding an earlier position is told to
   * clear rather than handed a tail from the wrong offset.
   */
  clear() {
    this.chunks = [];
    this.size = 0;
    this.dropped = this.seq;
  }
}

module.exports = { RingBuffer };
