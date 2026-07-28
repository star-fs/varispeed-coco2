/**
 * MC6883 Synchronous Address Multiplexer (SAM) Emulator Core
 *
 * The SAM has no data bus registers of its own; the CPU "writes" to it by
 * reading or writing any address in its $FFC0-$FFDF address decode range,
 * where the low address bit (odd/even) sets or clears one configuration bit.
 *
 * Sources and References:
 * 1. MC6883 Synchronous Address Multiplexer (SAM) Technical Data & Register Map
 * 2. Tandy Color Computer 2 Hardware Reference Manual (Catalog No. 26-3136)
 */
(function (name, definition) {
  if (typeof module != "undefined") module.exports = definition();
  else if (typeof define == "function" && typeof define.amd == "object")
    define(definition);
  else this[name] = definition();
})("MC6883", function () {

  function create(options) {
    options = options || {};

    const sam = {
      v: 0,   // VDG mode (V0-V2)
      f: 0,   // Display start offset page (F0-F6)
      p: 0,   // Page select (P0)
      r: 0,   // CPU speed (R0-R1)
      m: 0,   // Memory size (M0-M1)
      ty: 0,  // Map type (0 = ROM mode, 1 = All RAM mode)

      get allRamMode() {
        return this.ty === 1;
      },

      get isFastClock() {
        // R0 (bit 0 of R) controls CPU clock speed: 0 = Normal (895 kHz), 1 = Turbo (1.79 MHz)
        return (this.r & 1) === 1;
      },

      reset() {
        this.v = 0;
        this.f = 0;
        this.p = 0;
        this.r = 0;
        this.m = 0;
        this.ty = 0;
      },

      // addr is any address in $FFC0-$FFDF; the SAM decodes which config
      // bit it addresses from the offset, and reads the value from bit 0
      // (even address = clear that bit, odd address = set it).
      write(addr) {
        const bitIndex = Math.floor((addr - 0xFFC0) / 2);
        const val = addr & 1;

        if (bitIndex < 3) {
          // V0, V1, V2 (VDG mode select)
          if (val) this.v |= (1 << bitIndex); else this.v &= ~(1 << bitIndex);
        } else if (bitIndex < 10) {
          // F0 to F6 (Display starting offset)
          const fBit = bitIndex - 3;
          if (val) this.f |= (1 << fBit); else this.f &= ~(1 << fBit);
        } else if (bitIndex === 10) {
          // P0 (Page Select - for systems with >64K RAM, unused on standard CoCo 2)
          if (val) this.p |= 1; else this.p &= ~1;
        } else if (bitIndex === 11 || bitIndex === 12) {
          // R0, R1 (CPU clock speed mode select)
          const rBit = bitIndex - 11;
          if (val) this.r |= (1 << rBit); else this.r &= ~(1 << rBit);
          if (options.onClockChange) options.onClockChange(this.isFastClock);
        } else if (bitIndex === 13 || bitIndex === 14) {
          // M0, M1 (RAM size select)
          const mBit = bitIndex - 13;
          if (val) this.m |= (1 << mBit); else this.m &= ~(1 << mBit);
        } else if (bitIndex === 15) {
          // TY (Map Type: 0 = ROM/RAM, 1 = All RAM)
          this.ty = val;
        }
      }
    };

    return sam;
  }

  return { create: create };
});
