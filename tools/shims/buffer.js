// Browser stand-in for the Node `Buffer` global, injected by esbuild.
//
// bot/pdftext.js needs exactly four behaviours and nothing else:
//   Buffer.isBuffer(x)                       -- line 70
//   Buffer.from(uint8array | string)         -- lines 61, 70
//   buf.length / new Uint8Array(buf)         -- lines 72-74, 88
//   buf.subarray(0, 1024).includes(needle)   -- line 61, where `needle` is a
//                                               BYTE SEQUENCE, not a byte
//
// That last one is the whole reason this file exists. Node's
// Buffer.prototype.includes accepts a Buffer and does a substring search;
// Uint8Array.prototype.includes only accepts a single number and would
// silently return false, making every PDF fail the %PDF- header check.

const encoder = new TextEncoder();

class Buffer extends Uint8Array {
  static isBuffer(b) {
    return b instanceof Buffer;
  }

  static from(src, enc) {
    if (typeof src === 'string') {
      if (enc && enc !== 'utf8' && enc !== 'utf-8') {
        throw new Error('Buffer shim: unsupported encoding "' + enc + '"');
      }
      return new Buffer(encoder.encode(src));
    }
    if (src instanceof ArrayBuffer) return new Buffer(new Uint8Array(src));
    if (ArrayBuffer.isView(src)) {
      return new Buffer(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
    }
    return new Buffer(src || []);
  }

  static alloc(n) {
    return new Buffer(n);
  }

  // Uint8Array.prototype.subarray honours Symbol.species and so already
  // returns a Buffer -- but that is a subtle, load-bearing assumption. Pin the
  // prototype explicitly instead, on the same (non-copying) view.
  subarray(begin, end) {
    const view = Uint8Array.prototype.subarray.call(this, begin, end);
    Object.setPrototypeOf(view, Buffer.prototype);
    return view;
  }

  includes(needle, offset) {
    if (typeof needle === 'number') return Uint8Array.prototype.includes.call(this, needle, offset);
    const hay = this;
    const pat = needle instanceof Uint8Array ? needle : Buffer.from(needle);
    if (!pat.length) return true;
    const last = hay.length - pat.length;
    outer: for (let i = Math.max(0, offset | 0); i <= last; i++) {
      for (let j = 0; j < pat.length; j++) if (hay[i + j] !== pat[j]) continue outer;
      return true;
    }
    return false;
  }

  toString(enc) {
    if (enc && enc !== 'utf8' && enc !== 'utf-8') {
      throw new Error('Buffer shim: unsupported encoding "' + enc + '"');
    }
    return new TextDecoder().decode(this);
  }
}

export { Buffer };
