/**
 * MC6821 Peripheral Interface Adapter (PIA) Emulator Core
 *
 * The CoCo 2 has two of these chips (PIA0 at $FF00-$FF1F for keyboard/joysticks,
 * PIA1 at $FF20-$FF3F for sound/VDG control/cassette/cartridge FIRQ). Both
 * instances share identical register decoding logic; only the side effects of
 * accessing certain registers differ. Rather than duplicate that decoding
 * twice, PIA6821.create() builds one chip instance and takes a set of hooks
 * that let the caller plug in per-instance behavior.
 *
 * Sources and References:
 * 1. MC6821 Peripheral Interface Adapter (PIA) Specifications and Interrupt Controls
 * 2. Tandy Color Computer 2 Hardware Reference Manual (Catalog No. 26-3136)
 */
(function (name, definition) {
  if (typeof module != "undefined") module.exports = definition();
  else if (typeof define == "function" && typeof define.amd == "object")
    define(definition);
  else this[name] = definition();
})("MC6821", function () {

  function create(options) {
    options = options || {};
    const portbResetValue = options.portbResetValue !== undefined ? options.portbResetValue : 0xFF;

    const pia = {
      porta: 0xFF,
      ddra: 0x00,
      controla: 0x00,
      portb: portbResetValue,
      ddrb: 0x00,
      controlb: 0x00,

      reset() {
        this.porta = 0xFF;
        this.ddra = 0x00;
        this.controla = 0x00;
        this.portb = portbResetValue;
        this.ddrb = 0x00;
        this.controlb = 0x00;
      },

      read(addr) {
        const reg = addr & 3;
        switch (reg) {
          case 0: // Port A (Data/DDR)
            if (this.controla & 0x04) {
              this.controla &= ~0x80; // Clear CA1 interrupt flag
              if (options.onReadDataA) options.onReadDataA(this);
              return options.readPortA ? options.readPortA(this) : this.porta;
            } else {
              return this.ddra;
            }
          case 1: // Control A
            return this.controla;
          case 2: // Port B (Data/DDR)
            if (this.controlb & 0x04) {
              this.controlb &= ~0x80; // Clear CB1 interrupt flag
              if (options.onReadDataB) options.onReadDataB(this);
              return this.portb;
            } else {
              return this.ddrb;
            }
          case 3: // Control B
            return options.controlBReadMask ? (this.controlb | options.controlBReadMask(this)) : this.controlb;
        }
      },

      write(addr, val) {
        const reg = addr & 3;
        switch (reg) {
          case 0:
            if (this.controla & 0x04) {
              this.porta = val;
            } else {
              this.ddra = val;
            }
            break;
          case 1: {
            const oldControlA = this.controla;
            this.controla = (this.controla & 0xC0) | (val & 0x3F);
            if (options.onWriteControlA) options.onWriteControlA(this, oldControlA, this.controla);
            break;
          }
          case 2:
            if (this.controlb & 0x04) {
              this.portb = val;
              if (options.onWriteDataB) {
                this.controlb &= ~0x80; // Clear CB1 interrupt flag
                options.onWriteDataB(this);
              }
            } else {
              this.ddrb = val;
            }
            break;
          case 3: {
            const oldControlB = this.controlb;
            this.controlb = (this.controlb & 0xC0) | (val & 0x3F);
            if (options.onWriteControlB) options.onWriteControlB(this, oldControlB, this.controlb);
            break;
          }
        }
      }
    };

    return pia;
  }

  return { create: create };
});
