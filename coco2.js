/**
 * Tandy Color Computer 2 Emulator Main System Logic
 * 
 * Sources and References:
 * 1. Tandy Color Computer 2 Hardware Reference Manual (Catalog No. 26-3136)
 * 2. MC6883 Synchronous Address Multiplexer (SAM) Technical Data & Register Map
 * 3. MC6821 Peripheral Interface Adapter (PIA) Specifications and Interrupt Controls
 * 4. MC6847 Video Display Generator (VDG) Modes and Color Set Tables
 * 5. TRS-80 Color Computer Archive (https://colorcomputerarchive.com/) - Cartridge (.ccc), Cassette (.wav), and Floppy Disk (.dsk) file formats
 * 6. CoCo 2 schematics regarding CART* physical FIRQ coupling diode/RC transient circuitry
 */

// State variables
const ram = new Uint8Array(64 * 1024);
const colorBasicRom = new Uint8Array(8192);
const extendedBasicRom = new Uint8Array(8192);

let romsLoaded = false;
let isRunning = false;
let cpuSpeedHz = 895000; // Default CoCo speed is 0.895 MHz
let lastTime = 0;
let accumulatedCycles = 0;

// PIA 0 (Keyboard, joysticks, etc. - mapped at $FF00-$FF1F)
const pia0 = MC6821.create({
  portbResetValue: 0xFF,
  readPortA: () => readKeyboardRow(),
  onReadDataA: () => MC6809.set_irq_line(false),
  onReadDataB: () => MC6809.set_irq_line(false),
  // Writing Port B also clears the CB1 vertical sync interrupt flag
  onWriteDataB: () => MC6809.set_irq_line(false)
});

// PIA 1 (Sound, VDG control, RS232, cassette - mapped at $FF20-$FF3F)
const pia1 = MC6821.create({
  portbResetValue: 0x00,
  readPortA: (pia) => (cassetteInputBit === 1) ? (pia.porta | 0x01) : (pia.porta & ~0x01),
  onReadDataA: () => MC6809.set_irq_line(false), // Clear cassette (CA1) IRQ
  onReadDataB: () => MC6809.set_firq_line(false), // Port B data read clears the CB1/FIRQ line
  onWriteControlA: (pia, oldControlA, newControlA) => {
    const oldMotor = (oldControlA & 0x08) !== 0;
    const newMotor = (newControlA & 0x08) !== 0;
    if (oldMotor !== newMotor && cassetteBuffer) {
      updateTapeStatusUI(newMotor);
      if (newMotor) {
        if (cpuSpeedHz !== 895000) {
          cassetteSavedCpuSpeedHz = cpuSpeedHz;
          cpuSpeedHz = 895000;
          updateSpeedUI();
        }
      } else if (cassetteSavedCpuSpeedHz !== null) {
        cpuSpeedHz = cassetteSavedCpuSpeedHz;
        cassetteSavedCpuSpeedHz = null;
        updateSpeedUI();
      }
    }
  },
  onWriteControlB: (pia, oldControlB, newControlB) => {
    // The ROM's boot code enables CB1 interrupts as routine PIA1 setup; if
    // the transient CART* pulse is still pending (not yet delivered since
    // the last reset), that write is what autostarts the cartridge. This
    // must fire at most ONCE per reset -- later gameplay writes to this
    // same register (for unrelated purposes) must not re-trigger it.
    if (cartridgeFirqPending && cartridgeLoaded && (newControlB & 0x01)) {
      cartridgeFirqPending = false;
      MC6809.set_firq_line(true);
    }
  },
  controlBReadMask: () => cartridgeLoaded ? 0x80 : 0
});

// SAM (Synchronous Address Multiplexer - toggled at $FFC0-$FFDF)
const sam = MC6883.create({
  onClockChange: (isFast) => {
    // If the slider is set to Native (index 4), adjust execution speed dynamically
    if (speedSlider && parseInt(speedSlider.value) === 4) {
      cpuSpeedHz = isFast ? 1790000 : 895000;
    }
    updateSpeedUI();
  }
});

// VDG (Video Display Generator)
// colorizeGraphicsRow/blurCgRow (defined below) supply the post-chip analog
// signal conditioning - the VDG core itself only emits raw digital pixels.
const vdg = MC6847.create({ ram, colorizeRow: colorizeGraphicsRow, blurRow: blurCgRow });

// NTSC composite signal conditioning state: 'monochrome', 'phase0', 'phase1'.
// Defaults to 'phase1' to match the button's initial label/style in index.html.
let ntscMode = 'phase1';

// 3-tap horizontal Gaussian filter [0.25, 0.50, 0.25] to simulate RF composite
// video warmth/bandwidth-limited chroma bleed on an RGB row (native mode
// resolution, 3 bytes/pixel).
function blurRowRGB(row, width) {
  const blurred = new Uint8Array(width * 3);
  for (let x = 0; x < width; x++) {
    const xc = x * 3;
    const xm1 = (x > 0 ? x - 1 : x) * 3;
    const xp1 = (x < width - 1 ? x + 1 : x) * 3;
    blurred[xc]     = (0.25 * row[xm1]     + 0.5 * row[xc]     + 0.25 * row[xp1])     | 0;
    blurred[xc + 1] = (0.25 * row[xm1 + 1] + 0.5 * row[xc + 1] + 0.25 * row[xp1 + 1]) | 0;
    blurred[xc + 2] = (0.25 * row[xm1 + 2] + 0.5 * row[xc + 2] + 0.25 * row[xp1 + 2]) | 0;
  }
  return blurred;
}

// Turns one row of raw 1bpp VDG pixel output (native mode resolution) into
// RGB. This is analog composite/RF signal conditioning that happens to the
// VDG's clean digital output on its way to the screen - it does not live in
// the VDG chip core (mc6847.js) itself.
function colorizeGraphicsRow(bits, width, css) {
  const fgRGB = css ? [238, 238, 238] : [0, 255, 0];
  const bgRGB = [0, 17, 0];

  const row = new Uint8Array(width * 3);

  if (ntscMode === 'monochrome') {
    for (let x = 0; x < width; x++) {
      const rgb = bits[x] ? fgRGB : bgRGB;
      row[x * 3] = rgb[0]; row[x * 3 + 1] = rgb[1]; row[x * 3 + 2] = rgb[2];
    }
    return row;
  }

  // Authentic NTSC Chrominance artifacts: adjacent bit pairs combine into a
  // single 2-pixel-wide artifact color on the composite signal.
  const blueRGB = [40, 100, 255];
  const orangeRGB = [255, 100, 0];

  for (let x = 0; x < width; x += 2) {
    const p0 = bits[x], p1 = bits[x + 1];
    const code = (p0 ? 2 : 0) | (p1 ? 1 : 0);

    let rgb;
    if (code === 0) rgb = bgRGB;
    else if (code === 3) rgb = fgRGB;
    else if (code === 2) rgb = (ntscMode === 'phase0') ? blueRGB : orangeRGB;
    else rgb = (ntscMode === 'phase0') ? orangeRGB : blueRGB;

    row[x * 3] = rgb[0]; row[x * 3 + 1] = rgb[1]; row[x * 3 + 2] = rgb[2];
    row[(x + 1) * 3] = rgb[0]; row[(x + 1) * 3 + 1] = rgb[1]; row[(x + 1) * 3 + 2] = rgb[2];
  }

  return blurRowRGB(row, width);
}

// CG (color graphics) modes already output discrete VDG colors directly -
// there's no monochrome bitmap for a composite decoder to reinterpret, so
// real hardware wouldn't show artifact colors here. But the same bandwidth
// limiting that produces artifact colors on RG modes also softens/bleeds
// CG modes' sharp pixel edges on a real TV, so still apply the blur when an
// NTSC phase is selected, purely for visual consistency with RG modes.
// Skip it for CG6 (gm 6): at 128 native columns stretched 2x to fill the
// screen, the blur just muddies already-large pixels rather than adding
// warmth.
function blurCgRow(row, width, gm) {
  if (ntscMode === 'monochrome' || gm === 6) return row;
  return blurRowRGB(row, width);
}

// Web Audio API State for 6-bit DAC Emulation
let audioCtx = null;
let audioNode = null;
let audioQueue = [];
const AUDIO_SAMPLE_RATE = 44100;
let audioCycleTimer = 0;
let audioEnabled = true; // matches the Unmute button's initial label/style in index.html

// Audio filter state variables for analog emulation (LPF + HPF)
let audioLPFPrev = 0.0;
let audioHPFPrevOut = 0.0;
let audioHPFPrevIn = 0.0;

// Cassette Wave Player state
let cassetteBuffer = null;
let cassetteSampleRate = 44100;
let cassetteSampleIndex = 0;
let cassetteCycleTimer = 0;
let cassetteInputBit = 1; // 1 = idle high
let cassetteTapeName = "";

// The ROM's CLOAD/CSAVE bit decoder measures pulse widths by counting CPU
// cycles, calibrated only for the stock 0.895 MHz clock (exactly like real
// CoCo hardware, where the "fast poke" also breaks cassette I/O). Stash
// whatever speed was selected while the tape motor is engaged and restore
// it afterward, so cassette loads work regardless of the speed slider.
let cassetteSavedCpuSpeedHz = null;

// Floppy Disk cache
let lastLoadedDiskBuffer = null;
let lastLoadedDiskName = "";

// Cartridge state
let cartridgeLoaded = false;
let cartridgeRomBackup = null;

// Real hardware's AC-coupled CART* pin delivers one transient pulse per
// reset while a cartridge is seated; the ROM's boot code autostarts the
// cartridge the first time it enables PIA1's CB1 interrupt afterward. This
// must fire at most once per reset -- later gameplay writes to the same
// register (for unrelated purposes) must not re-trigger it.
let cartridgeFirqPending = false;

// Joystick state (analog range: 0 to 63, center: 31)
let rightJoyX = 31;
let rightJoyY = 31;
let rightJoyButton = false;

let leftJoyX = 31;
let leftJoyY = 31;
let leftJoyButton = false;

// Keyboard-controlled joystick states
let keyboardJoyX = 31;
let keyboardJoyY = 31;
let keyboardJoyButton = false;

// Keyboard matrix state (7 rows, 8 columns)
const pressedKeys = Array(7).fill(0).map(() => Array(8).fill(false));

// Keyboard Matrix Grid Layout mapping CoCo keys to Row/Col
const COCO_KEY_MAP = {
  '@': { row: 0, col: 0 }, 'a': { row: 0, col: 1 }, 'b': { row: 0, col: 2 }, 'c': { row: 0, col: 3 },
  'd': { row: 0, col: 4 }, 'e': { row: 0, col: 5 }, 'f': { row: 0, col: 6 }, 'g': { row: 0, col: 7 },
  'h': { row: 1, col: 0 }, 'i': { row: 1, col: 1 }, 'j': { row: 1, col: 2 }, 'k': { row: 1, col: 3 },
  'l': { row: 1, col: 4 }, 'm': { row: 1, col: 5 }, 'n': { row: 1, col: 6 }, 'o': { row: 1, col: 7 },
  'p': { row: 2, col: 0 }, 'q': { row: 2, col: 1 }, 'r': { row: 2, col: 2 }, 's': { row: 2, col: 3 },
  't': { row: 2, col: 4 }, 'u': { row: 2, col: 5 }, 'v': { row: 2, col: 6 }, 'w': { row: 2, col: 7 },
  'x': { row: 3, col: 0 }, 'y': { row: 3, col: 1 }, 'z': { row: 3, col: 2 }, 
  'arrowup': { row: 3, col: 3 }, 'arrowdown': { row: 3, col: 4 }, 
  'arrowleft': { row: 3, col: 5 }, 'arrowright': { row: 3, col: 6 }, 
  ' ': { row: 3, col: 7 },
  '0': { row: 4, col: 0 }, '1': { row: 4, col: 1 }, '2': { row: 4, col: 2 }, '3': { row: 4, col: 3 },
  '4': { row: 4, col: 4 }, '5': { row: 4, col: 5 }, '6': { row: 4, col: 6 }, '7': { row: 4, col: 7 },
  '8': { row: 5, col: 0 }, '9': { row: 5, col: 1 }, ':': { row: 5, col: 2 }, ';': { row: 5, col: 3 },
  ',': { row: 5, col: 4 }, '-': { row: 5, col: 5 }, '.': { row: 5, col: 6 }, '/': { row: 5, col: 7 },
  'enter': { row: 6, col: 0 }, 'clear': { row: 6, col: 1 }, 'break': { row: 6, col: 2 },
  'alt': { row: 6, col: 3 }, 'control': { row: 6, col: 4 }, 'f1': { row: 6, col: 5 },
  'f2': { row: 6, col: 6 }, 'shift': { row: 6, col: 7 }
};

// Auto-Typer State
let typerQueue = [];
let typerState = 'idle'; // 'idle', 'keydown', 'keyup'
let typerFrameCount = 0;
let typerCurrentChar = '';
let typerKeyPressed = null;
let typerHoldFrames = 4;    // frames to hold key down
let typerReleaseFrames = 4; // frames to release key (idle)

// HTML Elements
let canvas, ctx;
let debugRegs, debugDisasm, debugMemHex;
let speedSlider, speedValue;
let typeTextarea, startTypeBtn, typeSpeedSlider, typeSpeedValue, typeProgress;
let memoryStartAddrInput;

// base64 decoding helper
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Set up memory layout callback functions
function byteAt(addr) {
  addr &= 0xFFFF;
  
  // I/O & hardware registers
  if (addr >= 0xFF00) {
    if (addr >= 0xFF00 && addr <= 0xFF1F) {
      return pia0.read(addr);
    }
    if (addr >= 0xFF20 && addr <= 0xFF3F) {
      return pia1.read(addr);
    }
    if (addr >= 0xFFE0 && addr <= 0xFFFF) {
      // Hardware interrupt vectors
      if (!sam.allRamMode) {
        // ROM mode: vectors map to top of Color BASIC ROM ($FFF2-$FFFF -> $BFF2-$BFFF)
        return colorBasicRom[addr - 0xE000];
      } else {
        return ram[addr];
      }
    }
    return 0xFF;
  }

  if (sam.allRamMode) {
    return ram[addr];
  } else {
    // ROM mode
    if (addr >= 0x8000 && addr <= 0x9FFF) {
      return extendedBasicRom[addr - 0x8000];
    } else if (addr >= 0xA000 && addr <= 0xBFFF) {
      return colorBasicRom[addr - 0xA000];
    } else {
      return ram[addr];
    }
  }
}

function byteTo(addr, val) {
  addr &= 0xFFFF;
  val &= 0xFF;

  // I/O & hardware registers
  if (addr >= 0xFF00) {
    if (addr >= 0xFF00 && addr <= 0xFF1F) {
      pia0.write(addr, val);
      return;
    }
    if (addr >= 0xFF20 && addr <= 0xFF3F) {
      pia1.write(addr, val);
      return;
    }
    if (addr >= 0xFFC0 && addr <= 0xFFDF) {
      sam.write(addr);
      return;
    }
    if (addr >= 0xFFE0 && addr <= 0xFFFF) {
      if (sam.allRamMode) {
        ram[addr] = val;
      }
      return;
    }
    return;
  }

  if (sam.allRamMode) {
    if (cartridgeLoaded) {
      const cartLen = cartridgeRomBackup ? cartridgeRomBackup.length : 16128;
      const cartEnd = 0xC000 + Math.min(cartLen, 16128) - 1;
      if (addr >= 0xC000 && addr <= cartEnd) {
        // Cartridge ROM is write protected!
        return;
      }
    }
    ram[addr] = val;
  } else {
    // ROM mode
    if (addr >= 0x8000 && addr <= 0xBFFF) {
      // ROM is write protected!
      return;
    }
    if (cartridgeLoaded) {
      const cartLen = cartridgeRomBackup ? cartridgeRomBackup.length : 16128;
      const cartEnd = 0xC000 + Math.min(cartLen, 16128) - 1;
      if (addr >= 0xC000 && addr <= cartEnd) {
        // Cartridge ROM is write protected!
        return;
      }
    }
    ram[addr] = val;
  }
}

function updateTapeStatusUI(motorOn) {
  const status = document.getElementById('tape-status');
  if (status && cassetteTapeName) {
    if (motorOn) {
      status.innerText = `▶ ${cassetteTapeName}`;
      status.classList.add('active');
    } else {
      status.innerText = `⏸ ${cassetteTapeName}`;
      status.classList.add('active');
    }
  }
}

function updateSpeedUI() {
  const speedModeText = document.getElementById('hardware-speed-mode');
  if (speedModeText) {
    speedModeText.innerText = sam.isFastClock ? "1.79 MHz (Fast)" : "0.89 MHz (Normal)";
  }

  const speedValueText = document.getElementById('cpu-speed-value');
  if (speedValueText) {
    if (cpuSpeedHz === 895000) {
      speedValueText.innerText = "895 kHz (Original)";
    } else if (cpuSpeedHz === 1790000) {
      speedValueText.innerText = sam.isFastClock ? "1.79 MHz (Fast Mode)" : "1.79 MHz (Overclocked)";
    } else if (cpuSpeedHz === 100) {
      speedValueText.innerText = "100 Hz (Debug)";
    } else if (cpuSpeedHz === 1000) {
      speedValueText.innerText = "1 kHz";
    } else if (cpuSpeedHz === 10000) {
      speedValueText.innerText = "10 kHz";
    } else if (cpuSpeedHz === 100000) {
      speedValueText.innerText = "100 kHz";
    } else if (cpuSpeedHz === 4000000) {
      speedValueText.innerText = "4.0 MHz (Turbo)";
    } else if (cpuSpeedHz === 10000000) {
      speedValueText.innerText = "10.0 MHz (Max Turbo)";
    } else {
      speedValueText.innerText = (cpuSpeedHz / 1000000).toFixed(2) + " MHz";
    }
  }
}

// Keyboard Scanning
function readKeyboardRow() {
  let rowVal = 0xFF; // All bits high (pull-up resistors)
  const colStrobe = pia0.portb;
  
  // Strobe is active-low: if a bit is 0, that column is scanned
  for (let col = 0; col < 8; col++) {
    if ((colStrobe & (1 << col)) === 0) {
      for (let row = 0; row < 7; row++) {
        if (pressedKeys[row][col]) {
          rowVal &= ~(1 << row);
        }
      }
    }
  }
  
  // Include simulated auto-typer keypresses
  if (typerKeyPressed) {
    if ((colStrobe & (1 << typerKeyPressed.col)) === 0) {
      rowVal &= ~(1 << typerKeyPressed.row);
    }
    // Also scan Shift key if character requires Shift (Row 6, Col 7)
    if (typerKeyPressed.shift && (colStrobe & (1 << 7)) === 0) {
      rowVal &= ~(1 << 6);
    }
  }
  
  // Joystick comparator logic
  // Channel select is controlled by CA2 and CB2:
  // CB2 (bit 3 of pia0.controlb) is MUX SEL B (high bit)
  // CA2 (bit 3 of pia0.controla) is MUX SEL A (low bit)
  const channel = ((pia0.controlb & 0x08) ? 2 : 0) | ((pia0.controla & 0x08) ? 1 : 0);
  let joyVal = 31;
  if (channel === 0) {
    joyVal = rightJoyX;
  } else if (channel === 1) {
    joyVal = rightJoyY;
  } else if (channel === 2) {
    joyVal = leftJoyX;
  } else if (channel === 3) {
    joyVal = leftJoyY;
  }
  
  // 6-bit DAC value is written to pia1.porta bits 2-7
  const dacVal = (pia1.porta >> 2) & 0x3F;
  
  // Set comparator bit (bit 7 of Port A): 1 if joyVal >= dacVal, else 0
  if (joyVal >= dacVal) {
    rowVal |= 0x80;
  } else {
    rowVal &= ~0x80;
  }
  
  // Joystick fire buttons (active low):
  // Bit 0 = Right Joystick Button
  // Bit 1 = Left Joystick Button
  if (rightJoyButton) {
    rowVal &= ~0x01;
  }
  if (leftJoyButton) {
    rowVal &= ~0x02;
  }
  
  return rowVal;
}

// Map ASCII/Special Characters to CoCo Keypress
function getCoCoKeyPress(char) {
  // Convert uppercase letters to unshifted CoCo keys (producing uppercase on CoCo)
  if (char >= 'A' && char <= 'Z') {
    const mapping = COCO_KEY_MAP[char.toLowerCase()];
    if (mapping) return { row: mapping.row, col: mapping.col, shift: false };
  }
  
  // Convert lowercase letters to shifted CoCo keys (producing lowercase on CoCo)
  if (char >= 'a' && char <= 'z') {
    const mapping = COCO_KEY_MAP[char];
    if (mapping) return { row: mapping.row, col: mapping.col, shift: true };
  }
  
  // Handle shift symbols on CoCo layout
  const shiftSymbols = {
    '!': { key: '1', shift: true },
    '"': { key: '2', shift: true },
    '#': { key: '3', shift: true },
    '$': { key: '4', shift: true },
    '%': { key: '5', shift: true },
    '&': { key: '6', shift: true },
    "'": { key: '7', shift: true },
    '(': { key: '8', shift: true },
    ')': { key: '9', shift: true },
    '*': { key: ':', shift: true },
    '+': { key: ';', shift: true },
    '<': { key: ',', shift: true },
    '=': { key: '-', shift: true },
    '>': { key: '.', shift: true },
    '?': { key: '/', shift: true },
    '^': { key: '@', shift: true },
    '[': { key: 'arrowright', shift: true },
    ']': { key: 'arrowleft', shift: true },
    '_': { key: ' ', shift: true }
  };
  
  if (shiftSymbols[char]) {
    const target = shiftSymbols[char];
    const mapping = COCO_KEY_MAP[target.key];
    if (mapping) return { row: mapping.row, col: mapping.col, shift: target.shift };
  }
  
  // Direct character map lookup
  const mapping = COCO_KEY_MAP[char];
  if (mapping) return { row: mapping.row, col: mapping.col, shift: false };
  
  // Fallbacks for Carriage Return
  if (char === '\n' || char === '\r') {
    return { row: 6, col: 0, shift: false }; // Enter key
  }
  
  return null;
}

// Full Screen Management: F11 is the browser's own chrome-level fullscreen
// and can't be intercepted or reacted to by any page. F8 instead requests
// the Fullscreen API on .crt-screen-bezel, the existing direct parent of
// the CRT screen -- see the :fullscreen CSS rules for how it's letterboxed
// via flexbox, which reliably preserves the screen's aspect ratio (unlike
// position:fixed + explicit dimensions, which fought the browser's
// internal top-layer fullscreen layout unpredictably).
function toggleFullscreen() {
  const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (!isFullscreen) {
    const target = document.querySelector('.crt-screen-bezel');
    if (target.requestFullscreen) target.requestFullscreen();
    else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}

// Host Keyboard Event Listeners
function handleKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    return;
  }

  // F8 toggles full screen, independent of the emulated keyboard.
  if (e.key === 'F8') {
    e.preventDefault();
    toggleFullscreen();
    return;
  }

  // Left Control is mapped as Right Joystick Fire button
  if (e.code === 'ControlLeft') {
    keyboardJoyButton = true;
    e.preventDefault();
    return;
  }
  
  let key = e.key; // Keep case for getCoCoKeyPress character matching
  let lowerKey = key.toLowerCase();
  
  // Update Right Joystick axes based on arrow keys
  if (lowerKey === 'arrowup') {
    keyboardJoyY = 0;
  } else if (lowerKey === 'arrowdown') {
    keyboardJoyY = 63;
  } else if (lowerKey === 'arrowleft') {
    keyboardJoyX = 0;
  } else if (lowerKey === 'arrowright') {
    keyboardJoyX = 63;
  }
  
  // Prevent browser scrolling/default actions for active keys
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'backspace', 'escape', 'tab'].includes(lowerKey)) {
    e.preventDefault();
  }
  
  // Remappings for special keys
  let lookupChar = key;
  if (lowerKey === 'backspace') lookupChar = 'arrowleft';
  else if (lowerKey === 'escape') lookupChar = 'break';
  
  const press = getCoCoKeyPress(lookupChar);
  if (press) {
    pressedKeys[press.row][press.col] = true;
    if (press.shift) {
      pressedKeys[6][7] = true;
      updateKeyElement('shift', true);
    } else {
      if (lowerKey !== 'shift') {
        pressedKeys[6][7] = false;
        updateKeyElement('shift', false);
      }
    }
    
    // Highlight the mapped key in the virtual keyboard
    let uiKey = lowerKey;
    if (uiKey === 'backspace') uiKey = 'arrowleft';
    if (uiKey === 'escape') uiKey = 'break';
    if (uiKey === "'") uiKey = '7';
    if (uiKey === '"') uiKey = '2';
    updateKeyElement(uiKey, true);
  }
  
  // Only force Shift key in matrix if physically pressing the Shift key itself
  if (lowerKey === 'shift') {
    pressedKeys[6][7] = true;
    updateKeyElement('shift', true);
  }
}

function handleKeyUp(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    return;
  }
  
  // Left Control is mapped as Right Joystick Fire button
  if (e.code === 'ControlLeft') {
    keyboardJoyButton = false;
    e.preventDefault();
    return;
  }
  
  let key = e.key;
  let lowerKey = key.toLowerCase();
  
  // Center Right Joystick axes on arrow key release
  if (lowerKey === 'arrowup' || lowerKey === 'arrowdown') {
    keyboardJoyY = 31;
  }
  if (lowerKey === 'arrowleft' || lowerKey === 'arrowright') {
    keyboardJoyX = 31;
  }
  
  let lookupChar = key;
  if (lowerKey === 'backspace') lookupChar = 'arrowleft';
  else if (lowerKey === 'escape') lookupChar = 'break';
  
  const press = getCoCoKeyPress(lookupChar);
  if (press) {
    pressedKeys[press.row][press.col] = false;
    
    let uiKey = lowerKey;
    if (uiKey === 'backspace') uiKey = 'arrowleft';
    if (uiKey === 'escape') uiKey = 'break';
    if (uiKey === "'") uiKey = '7';
    if (uiKey === '"') uiKey = '2';
    updateKeyElement(uiKey, false);
  }
  
  // Release shift if releasing physical Shift key
  if (lowerKey === 'shift') {
    pressedKeys[6][7] = false;
    updateKeyElement('shift', false);
  }
}

// Virtual Screen Render Engine
// Emulates MC6847 VDG output based on PIA and SAM configurations
function renderScreen() {
  vdg.render(ctx, sam.f * 512, pia1.portb, sam.v);
  if (ntscMode === 'monochrome') desaturateScreen();
}

// Simulates a black-and-white CoCo monitor/TV. Real NTSC composite video
// carries color as a subcarrier modulated on top of a luminance signal; a
// B&W set decodes only the luminance and discards the color entirely. This
// is applied once, uniformly, after the VDG's own render - covering text,
// semigraphics, CG, and RG modes alike - the same way a real B&W set would
// desaturate whatever the chip drew, rather than picking gray equivalents
// mode-by-mode.
function desaturateScreen() {
  const imgData = ctx.getImageData(0, 0, 256, 192);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    data[i] = luma; data[i + 1] = luma; data[i + 2] = luma;
  }
  ctx.putImageData(imgData, 0, 0);
}

// Vertical Sync interrupt timer (60 Hz)
let vsyncCycleTimer = 0;

function initAudio() {
  if (audioCtx) return;
  
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    console.error("Web Audio API not supported in this browser.");
    return;
  }
  
  try {
    audioCtx = new AudioContextClass({ sampleRate: AUDIO_SAMPLE_RATE });
    
    // ScriptProcessorNode: 2048 buffer, 0 input channels, 1 output channel
    audioNode = audioCtx.createScriptProcessor(2048, 0, 1);
    
    audioNode.onaudioprocess = function(e) {
      const outputBuffer = e.outputBuffer;
      const channelData = outputBuffer.getChannelData(0);
      const length = channelData.length;
      
      let lastVal = 0.0;
      for (let i = 0; i < length; i++) {
        let rawSample = 0.0;
        if (audioEnabled && audioQueue.length > 0) {
          rawSample = audioQueue.shift();
        } else {
          rawSample = lastVal;
        }
        
        // Emulate the original hardware's analog audio conditioning:
        // 1. First-order Low-Pass Filter (LPF) to smooth DAC quantization staircase (cutoff ~4 kHz)
        //    y[n] = y[n-1] + alpha * (x[n] - y[n-1])
        const alpha = 0.35;
        const lpfSample = audioLPFPrev + alpha * (rawSample - audioLPFPrev);
        audioLPFPrev = lpfSample;
        
        // 2. First-order High-Pass Filter (HPF) to remove DC offset / drift (cutoff ~50 Hz)
        //    y[n] = beta * (y[n-1] + x[n] - x[n-1])
        const beta = 0.99;
        const hpfSample = beta * (audioHPFPrevOut + lpfSample - audioHPFPrevIn);
        audioHPFPrevIn = lpfSample;
        audioHPFPrevOut = hpfSample;
        
        lastVal = rawSample; // Store original sample for underflow hold
        channelData[i] = hpfSample;
      }
    };
    
    audioNode.connect(audioCtx.destination);
    console.log("Audio system initialized successfully.");
  } catch (err) {
    console.error("Failed to initialize audio:", err);
  }
}

function recalculateTyperTiming() {
  if (typeof typeSpeedSlider === 'undefined') return;
  const val = parseInt(typeSpeedSlider.value);
  const vsyncFreq = 60 * (cpuSpeedHz / 895000);
  const totalScans = Math.max(4, Math.round(vsyncFreq / val));
  typerHoldFrames = Math.max(2, Math.floor(totalScans / 2));
  typerReleaseFrames = Math.max(2, totalScans - typerHoldFrames);
  
  // Prevent character truncation and keyboard ghosting during mid-typing speed changes
  if (typerState === 'keydown') {
    if (typerCurrentChar) {
      typerQueue.unshift(typerCurrentChar);
    }
    typerKeyPressed = null;
    typerState = 'keyup'; // Force a release phase first at the new speed
    typerFrameCount = 0;
  } else if (typerState === 'keyup') {
    typerKeyPressed = null;
    typerState = 'keyup'; // Reset counts for a clean release phase at the new speed
    typerFrameCount = 0;
  }
}

// Auto-Typer execution logic
function updateAutoTyper() {
  if (typerQueue.length === 0) {
    if (typerState !== 'idle') {
      typerState = 'idle';
      typerKeyPressed = null;
      updateTyperProgress();
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    }
    return;
  }
  
  if (typerState === 'idle') {
    // Pull next character
    typerCurrentChar = typerQueue.shift();
    const press = getCoCoKeyPress(typerCurrentChar);
    if (press) {
      typerKeyPressed = press;
      typerState = 'keydown';
      typerFrameCount = 0;
    } else {
      // Skip characters we cannot type
      typerState = 'idle';
    }
    updateTyperProgress();
  } else if (typerState === 'keydown') {
    typerFrameCount++;
    if (typerFrameCount >= typerHoldFrames) {
      typerKeyPressed = null; // Release key
      typerState = 'keyup';
      typerFrameCount = 0;
    }
  } else if (typerState === 'keyup') {
    typerFrameCount++;
    const releaseDelay = (typerCurrentChar === '\n' || typerCurrentChar === '\r') 
      ? Math.max(30, typerReleaseFrames * 6) // Give CoCo plenty of time (approx 500ms) to parse the line
      : typerReleaseFrames;
    if (typerFrameCount >= releaseDelay) {
      typerState = 'idle';
      typerFrameCount = 0;
    }
  }
}

// UI Typer Progress bar
let totalCharsToType = 0;
function updateTyperProgress() {
  if (totalCharsToType === 0 || typerQueue.length === 0) {
    typeProgress.style.width = '0%';
    typeProgress.innerText = '';
    return;
  }
  const typed = totalCharsToType - typerQueue.length;
  const pct = Math.round((typed / totalCharsToType) * 100);
  typeProgress.style.width = pct + '%';
  typeProgress.innerText = pct + '%';
}

// Main Frame Execution Loop
function emulatorFrame(timestamp) {
  if (!isRunning) return;
  
  // Poll gamepad input. A connected USB gamepad drives the LEFT joystick
  // (Player 1 on real CoCo hardware's port labeling), leaving the keyboard
  // free to drive the RIGHT joystick (Player 2) - so one person can play a
  // 2-player game solo with gamepad + keyboard.
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  for (let i = 0; i < gamepads.length; i++) {
    if (gamepads[i] && gamepads[i].connected) {
      gp = gamepads[i];
      break;
    }
  }

  if (gp) {
    // Left Stick axes: 0 (X), 1 (Y)
    let gpX = gp.axes[0] || 0.0;
    let gpY = gp.axes[1] || 0.0;

    const deadzone = 0.15;
    leftJoyX = Math.abs(gpX) > deadzone ? Math.round(31.5 + gpX * 31.5) : 31;
    leftJoyY = Math.abs(gpY) > deadzone ? Math.round(31.5 + gpY * 31.5) : 31;

    // X button (index 2) or A/Cross button (index 0) on standard layout
    let gpButton = false;
    if (gp.buttons[2] && gp.buttons[2].pressed) gpButton = true;
    if (gp.buttons[0] && gp.buttons[0].pressed) gpButton = true;

    leftJoyButton = gpButton;
  } else {
    // No gamepad connected: left joystick stays centered/unpressed.
    leftJoyX = 31;
    leftJoyY = 31;
    leftJoyButton = false;
  }

  // Right joystick is always driven by the keyboard-simulated joystick.
  rightJoyX = keyboardJoyX;
  rightJoyY = keyboardJoyY;
  rightJoyButton = keyboardJoyButton;
  
  if (lastTime === 0) lastTime = timestamp;
  let elapsedMs = timestamp - lastTime;
  lastTime = timestamp;
  
  // Cap elapsed time to avoid "spiral of death" during lag
  if (elapsedMs > 100) elapsedMs = 100;
  
  // Execute CPU cycles matching the selected speed multiplier
  const cyclesToRun = (cpuSpeedHz * elapsedMs) / 1000;
  accumulatedCycles += cyclesToRun;
  
  const cyclesToRunInt = Math.floor(accumulatedCycles);
  if (cyclesToRunInt > 0) {
    accumulatedCycles -= cyclesToRunInt;
    
    let cyclesRemaining = cyclesToRunInt;
    const cyclesPerFrame = Math.floor(cpuSpeedHz / 60);
    
    while (cyclesRemaining > 0) {
      const cyclesToVsync = cyclesPerFrame - vsyncCycleTimer;
      
      // Limit chunk size to 20 cycles to ensure cycle-accurate audio sampling (10 if tape is playing)
      const isTapePlaying = cassetteBuffer && (pia1.controla & 0x08) !== 0;
      const maxChunk = isTapePlaying ? 10 : 20;
      
      const chunk = Math.min(cyclesRemaining, Math.min(maxChunk, Math.max(1, Math.floor(cyclesToVsync))));
      
      MC6809.steps(chunk);
      cyclesRemaining -= chunk;
      vsyncCycleTimer += chunk;
      
      // Cycle-accurate sound sampling
      audioCycleTimer += chunk;
      const cyclesPerSample = cpuSpeedHz / AUDIO_SAMPLE_RATE;
      while (audioCycleTimer >= cyclesPerSample) {
        audioCycleTimer -= cyclesPerSample;
        
        let sample = 0.0;
        // Sound is enabled if Sound Enable (PIA 1 CB2) is 1, and Sound Select (PIA 0 CA2/CB2) is 00 (6-bit DAC)
        const soundEnabled = (pia1.controlb & 0x08) !== 0 && (pia0.controla & 0x08) === 0 && (pia0.controlb & 0x08) === 0;
        if (soundEnabled) {
          const dacVal = (pia1.porta >> 2) & 0x3F;
          sample = (dacVal - 31.5) / 31.5;
        }
        audioQueue.push(sample);
      }
      
      // Cycle-accurate cassette tape playback sampling
      if (cassetteBuffer) {
        const motorOn = (pia1.controla & 0x08) !== 0;
        if (motorOn) {
          cassetteCycleTimer += chunk;
          const cyclesPerWavSample = cpuSpeedHz / cassetteSampleRate;
          while (cassetteCycleTimer >= cyclesPerWavSample) {
            cassetteCycleTimer -= cyclesPerWavSample;
            if (cassetteSampleIndex < cassetteBuffer.length) {
              const val = cassetteBuffer[cassetteSampleIndex++];
              // Comparator digitizes analog wave to 1-bit square wave (zero-crossing threshold)
              const nextBit = (val > 0.0) ? 1 : 0;
              if (nextBit !== cassetteInputBit) {
                const oldBit = cassetteInputBit;
                cassetteInputBit = nextBit;
                
                // Set CA1 Interrupt Flag on configured transition edge
                const edgeSelect = (pia1.controla & 0x02) !== 0; // true = rising, false = falling
                let triggered = false;
                if (oldBit === 0 && nextBit === 1 && edgeSelect) {
                  triggered = true; // Low-to-high transition (rising edge)
                } else if (oldBit === 1 && nextBit === 0 && !edgeSelect) {
                  triggered = true; // High-to-low transition (falling edge)
                }
                
                if (triggered) {
                  pia1.controla |= 0x80; // Set CA1 Interrupt Flag (bit 7)
                  if (pia1.controla & 0x01) { // CA1 Interrupt Enable (bit 0)
                    MC6809.set_irq_line(true);
                  }
                }
              }
            } else {
              // End of tape, return to idle high
              cassetteBuffer = null;
              cassetteInputBit = 1;
              console.log("Cassette tape playback finished.");

              // Restore the speed the user had selected before the motor engaged
              if (cassetteSavedCpuSpeedHz !== null) {
                cpuSpeedHz = cassetteSavedCpuSpeedHz;
                cassetteSavedCpuSpeedHz = null;
                updateSpeedUI();
              }

              // Reset UI status
              const status = document.getElementById('tape-status');
              if (status) {
                status.innerText = "Finished";
                status.classList.remove('active');
              }
            }
          }
        }
      }
      
      if (vsyncCycleTimer >= cyclesPerFrame) {
        vsyncCycleTimer -= cyclesPerFrame;
        
        // Set CB1 vertical sync flag (bit 7 of PIA 0 Port B Control)
        pia0.controlb |= 0x80;

        // If interrupt enabled, signal CPU
        if (pia0.controlb & 0x01) {
          MC6809.set_irq_line(true);
        }
        
        // Update simulated typing inside the VSYNC interrupt (perfectly synchronized!)
        updateAutoTyper();
      }
    }
  }
  
  // Cap the audio queue to prevent latency and accumulation
  if (audioQueue.length > 4096) {
    audioQueue.splice(0, audioQueue.length - 2048);
  }
  
  // Render display
  renderScreen();
  
  // Refresh Debugger Monitors
  updateDebugger();
  
  requestAnimationFrame(emulatorFrame);
}

// Debug Panel Updates
function updateDebugger() {
  // Update registers
  const status = MC6809.status();
  debugRegs.innerHTML = `
PC: <span class="val">$${hex16(status.pc)}</span>   SP: <span class="val">$${hex16(status.sp)}</span>   U:  <span class="val">$${hex16(status.u)}</span>
A:  <span class="val">$${hex8(status.a)}</span>    B:  <span class="val">$${hex8(status.b)}</span>    X:  <span class="val">$${hex16(status.x)}</span>
Y:  <span class="val">$${hex16(status.y)}</span>    DP: <span class="val">$${hex8(status.dp)}</span>   CC: <span class="val">%${status.flags.toString(2).padStart(8,'0')}</span> (${MC6809.flagsToString()})
  `;
  
  // Disassembler
  const opByte = byteAt(status.pc);
  const arg1 = byteAt(status.pc + 1);
  const arg2 = byteAt(status.pc + 2);
  const arg3 = byteAt(status.pc + 3);
  const arg4 = byteAt(status.pc + 4);
  const dis = MC6809.disasm(opByte, arg1, arg2, arg3, arg4, status.pc);
  const mnem = dis[0];
  const instLen = dis[1];
  const byteList = [];
  for (let offset = 0; offset < instLen; offset++) {
    byteList.push(byteAt(status.pc + offset));
  }
  const bytesText = byteList.map(b => hex8(b)).join(' ');
  debugDisasm.innerHTML = `
<div class="line active">
  <span class="addr">$${hex16(status.pc)}:</span>
  <span class="bytes">${bytesText.padEnd(11, ' ')}</span>
  <span class="mnem">${mnem}</span>
</div>
  `;
  
  // Memory hex monitor
  let startAddr = parseInt(memoryStartAddrInput.value, 16);
  if (isNaN(startAddr)) startAddr = 0x0400;
  startAddr &= 0xFFF0; // Align to 16 bytes
  
  let hexText = '';
  for (let line = 0; line < 32; line++) {
    const lineAddr = startAddr + line * 16;
    hexText += `<span class="addr">$${hex16(lineAddr)}:</span> `;
    let hexBytes = '';
    let chars = '';
    for (let offset = 0; offset < 16; offset++) {
      const val = byteAt(lineAddr + offset);
      hexBytes += hex8(val) + ' ';
      // printable ASCII or block
      chars += (val >= 32 && val < 127) ? String.fromCharCode(val) : '.';
    }
    hexText += `<span class="bytes">${hexBytes}</span> <span class="ascii">${escapeHtml(chars)}</span>\n`;
  }
  debugMemHex.innerHTML = hexText;
}

// Helpers
function hex8(v) { return (v & 0xFF).toString(16).toUpperCase().padStart(2, '0'); }
function hex16(v) { return (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// On-screen Virtual Key Click Handling
function handleVirtualKeyClick(keyId) {
  const mapping = COCO_KEY_MAP[keyId];
  if (mapping) {
    // Strobe keypress for 10 frames
    typerQueue = [keyId];
    totalCharsToType = 1;
    typerState = 'idle';
  }
}

// Virtual Keyboard highlight support
function updateKeyElement(key, isPressed) {
  const el = document.getElementById(`key-${key}`);
  if (el) {
    if (isPressed) {
      el.classList.add('pressed');
    } else {
      el.classList.remove('pressed');
    }
  }
}

// Boot and System Management
function powerOff() {
  isRunning = false;
  
  // Clear screen to black
  if (ctx && canvas) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  
  // Set LED color to off
  const led = document.getElementById('power-led');
  if (led) led.className = 'led off';
  
  console.log("Color Computer 2 Powered OFF.");
}

function powerOn() {
  if (!romsLoaded) {
    // Initialize ROMs from base64 fallback
    try {
      colorBasicRom.set(base64ToUint8Array(COLOR_BASIC_ROM_B64));
      extendedBasicRom.set(base64ToUint8Array(EXT_BASIC_ROM_B64));
      romsLoaded = true;
      console.log("CoCo 2 ROMs loaded from base64.");
    } catch(e) {
      console.error("Base64 ROM decode error:", e);
      alert("Failed to decode embedded ROMs!");
      return;
    }
  }
  
  // Clear RAM (preserve cartridge ROM space if loaded)
  if (cartridgeLoaded) {
    ram.subarray(0, 0xC000).fill(0);
    ram.subarray(0xFF00, 0x10000).fill(0);
    if (cartridgeRomBackup) {
      const loadSize = Math.min(cartridgeRomBackup.length, 16128);
      for (let i = 0; i < loadSize; i++) {
        ram[0xC000 + i] = cartridgeRomBackup[i];
      }
    }
  } else {
    ram.fill(0);
  }
  
  // Setup hardware defaults
  pia0.reset();
  pia1.reset();

  sam.reset();
  sam.f = 2; // Default screen at page 2 ($0400)
  cpuSpeedHz = 895000;
  cassetteSavedCpuSpeedHz = null;

  if (speedSlider) {
    speedSlider.value = 4;
  }
  updateSpeedUI();

  // Map reset vectors into memory
  // ROM starts at $A000. Reset vector is $FFFE-$FFFF which points to $A027 (Color BASIC entry)
  // Let's verify what the ROM reset vector actually reads. It will be loaded from colorBasicRom.
  
  // Initialize CPU
  MC6809.init(byteTo, byteAt, null);
  // Simulate the transient CART* pin pulse: real hardware's RC coupling
  // latches this once per reset while a cartridge is seated. The ROM's boot
  // code then asserts FIRQ itself the moment it enables CB1 interrupts (see
  // pia1's onWriteControlB), autostarting the cartridge exactly once.
  MC6809.set_firq_line(false);
  cartridgeFirqPending = cartridgeLoaded;
  MC6809.set_irq_line(false);
  
  // Set LED color
  const led = document.getElementById('power-led');
  if (led) led.className = 'led on';
  
  console.log("Color Computer 2 Powered ON.");
  
  const alreadyRunning = isRunning;
  isRunning = true;
  if (!alreadyRunning) {
    lastTime = 0;
    accumulatedCycles = 0;
    requestAnimationFrame(emulatorFrame);
  }
}

function systemReset() {
  if (cartridgeLoaded && cartridgeRomBackup) {
    const loadSize = Math.min(cartridgeRomBackup.length, 16128);
    for (let i = 0; i < loadSize; i++) {
      ram[0xC000 + i] = cartridgeRomBackup[i];
    }
  }
  
  MC6809.reset();
  // See powerOn(): the CART* pulse latches once per reset; the ROM's boot
  // code asserts FIRQ itself via pia1's onWriteControlB.
  MC6809.set_firq_line(false);
  cartridgeFirqPending = cartridgeLoaded;
  MC6809.set_irq_line(false);
  cpuSpeedHz = 895000;
  cassetteSavedCpuSpeedHz = null;
  sam.reset();
  sam.f = 2;

  if (speedSlider) {
    speedSlider.value = 4;
  }
  updateSpeedUI();

  pia0.controla = 0x00;
  pia0.controlb = 0x00;
  pia1.controla = 0x00;
  pia1.controlb = 0x00;

  console.log("Color Computer 2 System Reset.");
}

function loadCassetteWav(arrayBuffer, fileName) {
  if (!audioCtx) {
    initAudio();
  }
  if (!audioCtx) {
    alert("Please enable audio first by clicking the 'Unmute' button, then load the WAV file.");
    return;
  }
  
  audioCtx.decodeAudioData(arrayBuffer, (audioBuffer) => {
    cassetteBuffer = audioBuffer.getChannelData(0);
    cassetteSampleRate = audioBuffer.sampleRate;
    cassetteSampleIndex = 0;
    cassetteCycleTimer = 0;
    cassetteInputBit = 1;
    cassetteTapeName = fileName;
    
    // Update UI status
    const status = document.getElementById('tape-status');
    if (status) {
      status.innerText = `⏸ ${fileName}`;
      status.classList.add('active');
    }
    const ejectBtn = document.getElementById('btn-eject-tape');
    if (ejectBtn) {
      ejectBtn.style.display = 'inline-block';
    }
    
    console.log(`Cassette loaded: ${fileName} (${cassetteBuffer.length} samples at ${cassetteSampleRate} Hz)`);
  }, (err) => {
    console.error("Error decoding WAV file:", err);
    alert("Failed to decode WAV file as audio cassette!");
  });
}

function loadCartridgeRom(arrayBuffer, fileName) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length > 16384) {
    alert(`Warning: Cartridge size (${bytes.length} bytes) exceeds standard 16KB limit. Loading first 16KB.`);
  }
  
  // Cartridge memory maps to $C000-$DFFF (8KB) or $C000-$FEFF (16KB)
  const loadSize = Math.min(bytes.length, 16128); // Max space before hardware registers at $FF00
  
  // Clear any existing cartridge space first to prevent leftover data
  for (let i = 0; i < 16128; i++) {
    ram[0xC000 + i] = 0;
  }
  
  for (let i = 0; i < loadSize; i++) {
    ram[0xC000 + i] = bytes[i];
  }
  
  cartridgeRomBackup = new Uint8Array(arrayBuffer);
  cartridgeLoaded = true;
  
  // Update UI status
  const status = document.getElementById('cart-status');
  if (status) {
    status.innerText = fileName;
    status.classList.add('active');
  }
  const ejectBtn = document.getElementById('btn-eject-cart');
  if (ejectBtn) {
    ejectBtn.style.display = 'inline-block';
  }
  
  console.log(`Cartridge loaded: ${fileName} (${loadSize} bytes written to $C000)`);
  systemReset();
}

function showDiskModal(diskName, files, onSelect) {
  const overlay = document.createElement('div');
  overlay.id = 'disk-modal-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
  overlay.style.backdropFilter = 'blur(8px)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '10000';
  
  const modal = document.createElement('div');
  modal.style.width = '500px';
  modal.style.maxHeight = '80%';
  modal.style.backgroundColor = 'rgba(20, 20, 20, 0.95)';
  modal.style.border = '1px solid rgba(0, 255, 0, 0.3)';
  modal.style.borderRadius = '12px';
  modal.style.padding = '20px';
  modal.style.boxShadow = '0 0 25px rgba(0, 255, 0, 0.2)';
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  modal.style.fontFamily = 'monospace';
  modal.style.color = '#00ff00';
  
  const header = document.createElement('h3');
  header.style.margin = '0 0 15px 0';
  header.style.borderBottom = '1px solid rgba(0, 255, 0, 0.2)';
  header.style.paddingBottom = '10px';
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.innerHTML = `<span>💾 ${diskName}</span><span style="font-size: 0.8em; color: #88ff88;">FAT Directory</span>`;
  modal.appendChild(header);
  
  const listContainer = document.createElement('div');
  listContainer.style.overflowY = 'auto';
  listContainer.style.flex = '1';
  listContainer.style.margin = '0 0 20px 0';
  listContainer.style.border = '1px solid rgba(0, 255, 0, 0.1)';
  listContainer.style.borderRadius = '6px';
  listContainer.style.backgroundColor = 'rgba(0, 10, 0, 0.5)';
  
  if (files.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.padding = '20px';
    emptyMsg.style.textAlign = 'center';
    emptyMsg.style.color = '#88aa88';
    emptyMsg.innerText = "No active files found on this disk.";
    listContainer.appendChild(emptyMsg);
  } else {
    files.forEach((file) => {
      const row = document.createElement('div');
      row.style.padding = '10px 15px';
      row.style.borderBottom = '1px solid rgba(0, 255, 0, 0.05)';
      row.style.cursor = 'pointer';
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      row.style.transition = 'background-color 0.2s';
      
      row.addEventListener('mouseenter', () => {
        row.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.backgroundColor = 'transparent';
      });
      
      const fileTypeStr = ['BASIC', 'DATA', 'BIN', 'TEXT'][file.type] || 'UNK';
      const fileFormatStr = file.format === 0 ? 'BIN' : 'ASC';
      
      row.innerHTML = `
        <span style="font-weight: bold;">${file.fullName}</span>
        <span style="font-size: 0.9em; color: #88ff88;">${fileTypeStr} (${fileFormatStr}) - ${file.size} B</span>
      `;
      
      row.addEventListener('click', () => {
        document.body.removeChild(overlay);
        onSelect(file);
      });
      
      listContainer.appendChild(row);
    });
  }
  modal.appendChild(listContainer);
  
  const footer = document.createElement('div');
  footer.style.display = 'flex';
  footer.style.justifyContent = 'flex-end';
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-secondary btn-sm';
  closeBtn.innerText = 'Cancel';
  closeBtn.style.padding = '6px 12px';
  closeBtn.addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  footer.appendChild(closeBtn);
  modal.appendChild(footer);
  
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function loadDiskDsk(arrayBuffer, fileName, skipShowModal = false) {
  lastLoadedDiskBuffer = arrayBuffer;
  lastLoadedDiskName = fileName;
  
  const status = document.getElementById('disk-status');
  if (status) {
    status.innerText = fileName;
    status.classList.add('active');
  }
  const dirBtn = document.getElementById('btn-show-dir');
  if (dirBtn) {
    dirBtn.style.display = 'inline-block';
  }
  const ejectBtn = document.getElementById('btn-eject-disk');
  if (ejectBtn) {
    ejectBtn.style.display = 'inline-block';
  }

  const bytes = new Uint8Array(arrayBuffer);
  
  // CoCo standard single-sided disk: 35 tracks, 18 sectors/track, 256 bytes/sector = 161,280 bytes
  if (bytes.length < 161280) {
    alert("Invalid DSK file! Size is too small for a standard 35-track single-sided CoCo disk.");
    return;
  }
  
  const fatOffset = (17 * 18 + 1) * 256; // Track 17, Sector 2
  const dirOffset = (17 * 18 + 2) * 256; // Track 17, Sectors 3-11
  
  const fat = bytes.slice(fatOffset, fatOffset + 256);
  const files = [];
  
  // 9 directory sectors
  for (let s = 0; s < 9; s++) {
    const secOffset = dirOffset + s * 256;
    // 8 entries per sector
    for (let e = 0; e < 8; e++) {
      const entryOffset = secOffset + e * 32;
      const firstChar = bytes[entryOffset];
      
      if (firstChar === 0x00 || firstChar === 0xFF) {
        continue; // Empty/unused or deleted entry
      }
      
      let name = "";
      for (let i = 0; i < 8; i++) {
        name += String.fromCharCode(bytes[entryOffset + i]);
      }
      name = name.trim();
      
      let ext = "";
      for (let i = 0; i < 3; i++) {
        ext += String.fromCharCode(bytes[entryOffset + 8 + i]);
      }
      ext = ext.trim();
      
      const fileType = bytes[entryOffset + 11];  // 0=BASIC, 1=DATA, 2=BIN, 3=TEXT
      const fileFormat = bytes[entryOffset + 12]; // 0=Binary, 2=ASCII
      const firstGranule = bytes[entryOffset + 13];
      const lastSectorBytes = (bytes[entryOffset + 14] << 8) | bytes[entryOffset + 15];
      
      // Follow the FAT linked list to map sectors
      const fileSectors = [];
      let currentGranule = firstGranule;
      let chainLen = 0;
      
      while (currentGranule < 68 && chainLen < 100) {
        chainLen++;
        const fatEntry = fat[currentGranule];
        
        // Granule to logical track and sector mappings (Track 17 is skipped!)
        const track = currentGranule < 34 
          ? Math.floor(currentGranule / 2) 
          : Math.floor((currentGranule + 2) / 2);
        const startSector = (currentGranule % 2 === 0) ? 1 : 10;
        
        if (fatEntry >= 0xC0 && fatEntry <= 0xC9) {
          // Last granule: lower 4 bits (fatEntry - 0xC0) represent active sectors in granule
          const sectorsUsed = fatEntry - 0xC0;
          for (let i = 0; i < sectorsUsed; i++) {
            fileSectors.push({ track, sector: startSector + i, isLast: (i === sectorsUsed - 1) });
          }
          break;
        } else if (fatEntry === 0xFF || fatEntry > 0xC9) {
          // Fallback/corrupted chain end
          for (let i = 0; i < 9; i++) {
            fileSectors.push({ track, sector: startSector + i, isLast: (i === 8) });
          }
          break;
        } else {
          // Intermediate granule: all 9 sectors are used
          for (let i = 0; i < 9; i++) {
            fileSectors.push({ track, sector: startSector + i, isLast: false });
          }
          currentGranule = fatEntry;
        }
      }
      
      // Reassemble raw bytes
      const fileBytes = [];
      for (let i = 0; i < fileSectors.length; i++) {
        const sec = fileSectors[i];
        const secOffset = (sec.track * 18 + (sec.sector - 1)) * 256;
        const sectorData = bytes.slice(secOffset, secOffset + 256);
        
        if (sec.isLast) {
          const readLen = (lastSectorBytes > 0 && lastSectorBytes <= 256) ? lastSectorBytes : 256;
          for (let b = 0; b < readLen; b++) {
            fileBytes.push(sectorData[b]);
          }
        } else {
          for (let b = 0; b < 256; b++) {
            fileBytes.push(sectorData[b]);
          }
        }
      }
      
      files.push({
        name,
        ext,
        fullName: ext ? `${name}.${ext}` : name,
        type: fileType,
        format: fileFormat,
        size: fileBytes.length,
        bytes: new Uint8Array(fileBytes)
      });
    }
  }
  
  if (!skipShowModal) {
    showDiskModal(fileName, files, (selectedFile) => {
      if (selectedFile.type === 0 || selectedFile.type === 3) {
        if (selectedFile.format === 2) {
          // ASCII file: load to auto-typer text field
          let text = "";
          for (let i = 0; i < selectedFile.bytes.length; i++) {
            text += String.fromCharCode(selectedFile.bytes[i]);
          }
          text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r');
          typeTextarea.value = text;
          console.log(`Loaded ASCII file "${selectedFile.fullName}" to auto-typer.`);
        } else {
          // Tokenized binary BASIC: inject directly to RAM at $1E01 and update pointers!
          const progStart = 0x1E01;
          for (let i = 0; i < selectedFile.bytes.length; i++) {
            ram[progStart + i] = selectedFile.bytes[i];
          }
          const progEnd = progStart + selectedFile.bytes.length;
          ram[progEnd] = 0;
          ram[progEnd + 1] = 0;
          
          const finalEnd = progEnd + 2;
          ram[0x0019] = (finalEnd >> 8) & 0xFF;
          ram[0x001A] = finalEnd & 0xFF;
          ram[0x001B] = (finalEnd >> 8) & 0xFF;
          ram[0x001C] = finalEnd & 0xFF;
          ram[0x001D] = (finalEnd >> 8) & 0xFF;
          ram[0x001E] = finalEnd & 0xFF;
          
          console.log(`Injected tokenized BASIC program to $1E01-$${finalEnd.toString(16).toUpperCase()}`);
        }
      } else if (selectedFile.type === 2) {
        // Machine Code BIN: parse blocks and write to RAM
        const fileBytes = selectedFile.bytes;
        let ptr = 0;
        let execAddr = 0x0000;
        let loadedBlocks = [];
        
        while (ptr < fileBytes.length) {
          const flag = fileBytes[ptr];
          if (flag === 0x00) {
            if (ptr + 5 > fileBytes.length) break;
            const length = (fileBytes[ptr + 1] << 8) | fileBytes[ptr + 2];
            const loadAddr = (fileBytes[ptr + 3] << 8) | fileBytes[ptr + 4];
            ptr += 5;
            
            if (ptr + length > fileBytes.length) break;
            for (let i = 0; i < length; i++) {
              ram[loadAddr + i] = fileBytes[ptr + i];
            }
            loadedBlocks.push({ addr: loadAddr, len: length });
            ptr += length;
          } else if (flag === 0xFF) {
            if (ptr + 5 > fileBytes.length) break;
            execAddr = (fileBytes[ptr + 3] << 8) | fileBytes[ptr + 4];
            break;
          } else {
            ptr++;
          }
        }
        
        console.log(`Loaded BIN program "${selectedFile.fullName}". Exec Address: $${execAddr.toString(16).toUpperCase()}`);
        
        // Auto-type EXEC command to trigger machine code!
        typeTextarea.value = `EXEC &H${execAddr.toString(16).toUpperCase()}\r`;
        startTypeBtn.click();
      } else {
        alert(`Unsupported file type on DSK: ${selectedFile.fullName}`);
      }
    });
  }
}

function ejectDisk() {
  lastLoadedDiskBuffer = null;
  lastLoadedDiskName = "";
  
  const status = document.getElementById('disk-status');
  if (status) {
    status.innerText = "No Disk";
    status.classList.remove('active');
  }
  
  const dirBtn = document.getElementById('btn-show-dir');
  if (dirBtn) {
    dirBtn.style.display = 'none';
  }
  
  const ejectBtn = document.getElementById('btn-eject-disk');
  if (ejectBtn) {
    ejectBtn.style.display = 'none';
  }
  
  const diskInput = document.getElementById('disk-input');
  if (diskInput) {
    diskInput.value = "";
  }
  
  console.log("Floppy disk ejected.");
}

function ejectCartridge() {
  cartridgeRomBackup = null;
  cartridgeLoaded = false;
  
  // Clear cartridge RAM space
  for (let i = 0; i < 16128; i++) {
    ram[0xC000 + i] = 0;
  }
  
  const status = document.getElementById('cart-status');
  if (status) {
    status.innerText = "Empty";
    status.classList.remove('active');
  }
  
  const ejectBtn = document.getElementById('btn-eject-cart');
  if (ejectBtn) {
    ejectBtn.style.display = 'none';
  }
  
  const cartInput = document.getElementById('cart-input');
  if (cartInput) {
    cartInput.value = "";
  }
  
  console.log("Cartridge ejected.");
  systemReset(); // Reset system since cartridge was removed
}

function ejectCassette() {
  cassetteBuffer = null;
  cassetteTapeName = "";

  // Restore the speed the user had selected if the tape was ejected mid-load
  if (cassetteSavedCpuSpeedHz !== null) {
    cpuSpeedHz = cassetteSavedCpuSpeedHz;
    cassetteSavedCpuSpeedHz = null;
    updateSpeedUI();
  }

  const status = document.getElementById('tape-status');
  if (status) {
    status.innerText = "No Tape";
    status.classList.remove('active');
  }
  
  const ejectBtn = document.getElementById('btn-eject-tape');
  if (ejectBtn) {
    ejectBtn.style.display = 'none';
  }
  
  const tapeInput = document.getElementById('tape-input');
  if (tapeInput) {
    tapeInput.value = "";
  }
  
  // Turn off tape motor UI
  updateTapeStatusUI(false);
  
  console.log("Cassette tape ejected.");
}

// Initialization on DOM load
window.addEventListener('DOMContentLoaded', () => {
  // Elements
  canvas = document.getElementById('coco-screen');
  ctx = canvas.getContext('2d', { alpha: false });
  
  debugRegs = document.getElementById('debug-regs');
  debugDisasm = document.getElementById('debug-disasm');
  debugMemHex = document.getElementById('debug-mem-hex');
  
  speedSlider = document.getElementById('cpu-speed-slider');
  speedValue = document.getElementById('cpu-speed-value');
  
  typeTextarea = document.getElementById('typer-text');
  startTypeBtn = document.getElementById('btn-start-typing');
  typeSpeedSlider = document.getElementById('typer-speed');
  typeSpeedValue = document.getElementById('typer-speed-value');
  typeProgress = document.getElementById('typer-progress-bar');
  
  memoryStartAddrInput = document.getElementById('mem-start-addr');
  
  // Wire up sliders
  speedSlider.addEventListener('input', () => {
    const val = parseInt(speedSlider.value);
    if (val === 0) {
      cpuSpeedHz = 100;
    } else if (val === 1) {
      cpuSpeedHz = 1000;
    } else if (val === 2) {
      cpuSpeedHz = 10000;
    } else if (val === 3) {
      cpuSpeedHz = 100000;
    } else if (val === 4) {
      cpuSpeedHz = sam.isFastClock ? 1790000 : 895000;
    } else if (val === 5) {
      cpuSpeedHz = 1790000;
    } else if (val === 6) {
      cpuSpeedHz = 4000000;
    } else if (val === 7) {
      cpuSpeedHz = 10000000;
    }
    
    // Sync SAM clock state with the chosen speed
    const isFastSpeed = (cpuSpeedHz >= 1790000);
    if (isFastSpeed) {
      sam.r |= 1;
    } else {
      sam.r &= ~1;
    }
    
    updateSpeedUI();
    recalculateTyperTiming();
  });
  
  typeSpeedSlider.addEventListener('input', () => {
    const val = parseInt(typeSpeedSlider.value);
    typeSpeedValue.innerText = val + " char/sec";
    recalculateTyperTiming();
  });
  
  // Power & Reset Buttons
  document.getElementById('btn-power').addEventListener('click', () => {
    if (isRunning) {
      powerOff();
    } else {
      powerOn();
      // Audio defaults to enabled, but browsers require a user gesture
      // before an AudioContext can actually produce sound - Power is the
      // first gesture most users make, so unlock it here rather than
      // making them separately click Unmute.
      if (audioEnabled) {
        if (!audioCtx) initAudio();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      }
    }
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    systemReset();
  });
  
  // NTSC Artifact mode selector
  document.getElementById('btn-ntsc-mode').addEventListener('click', () => {
    const btn = document.getElementById('btn-ntsc-mode');
    if (ntscMode === 'monochrome') {
      ntscMode = 'phase0';
      btn.innerText = "📺 NTSC: Phase 0";
      btn.className = "btn-primary btn-sm";
    } else if (ntscMode === 'phase0') {
      ntscMode = 'phase1';
      btn.innerText = "📺 NTSC: Phase 1";
      btn.className = "btn-primary btn-sm";
    } else {
      ntscMode = 'monochrome';
      btn.innerText = "📺 NTSC: Off";
      btn.className = "btn-secondary btn-sm";
    }
    renderScreen();
  });
  
  // Audio mute/unmute toggle
  document.getElementById('btn-audio-toggle').addEventListener('click', () => {
    const btn = document.getElementById('btn-audio-toggle');
    
    if (!audioCtx) {
      initAudio();
    }
    
    audioEnabled = !audioEnabled;
    
    if (audioEnabled) {
      btn.innerText = "🔊 Mute";
      btn.className = "btn-primary btn-sm";
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    } else {
      btn.innerText = "🔈 Unmute";
      btn.className = "btn-secondary btn-sm";
    }
  });
  
  // Presets
  document.getElementById('btn-speed-native').addEventListener('click', () => {
    speedSlider.value = 4;
    speedSlider.dispatchEvent(new Event('input'));
  });
  document.getElementById('btn-speed-turbo').addEventListener('click', () => {
    speedSlider.value = 6;
    speedSlider.dispatchEvent(new Event('input'));
  });
  document.getElementById('btn-speed-max').addEventListener('click', () => {
    speedSlider.value = 7;
    speedSlider.dispatchEvent(new Event('input'));
  });
  
  // Typing Action
  startTypeBtn.addEventListener('click', () => {
    if (typeTextarea.value.trim() === '') return;
    
    // Clear all pressed keys to prevent stuck modifier/Shift states
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 8; c++) {
        pressedKeys[r][c] = false;
      }
    }
    // Update virtual key elements
    const activeKeys = document.querySelectorAll('.key.active');
    activeKeys.forEach(k => k.classList.remove('active'));
    
    // Queue up code characters, normalizing newlines to prevent double-returns
    const text = typeTextarea.value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    typerQueue = text.split('');
    totalCharsToType = typerQueue.length;
    typerState = 'idle';
    typerKeyPressed = null;
    
    console.log(`Starting simulated typing of ${totalCharsToType} characters...`);
  });
  
  document.getElementById('btn-clear-typer').addEventListener('click', () => {
    typerQueue = [];
    totalCharsToType = 0;
    typerKeyPressed = null;
    typerState = 'idle';
    updateTyperProgress();
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    console.log("Auto-typer queue cleared.");
  });
  // Keyboard Listeners
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  
  // Add listeners to virtual keyboard keys
  const keys = document.querySelectorAll('.key');
  keys.forEach(k => {
    const keyId = k.id.replace('key-', '');
    // Support click
    k.addEventListener('mousedown', () => {
      const press = getCoCoKeyPress(keyId);
      if (press) {
        typerKeyPressed = press;
        updateKeyElement(keyId, true);
      }
    });
    k.addEventListener('mouseup', () => {
      typerKeyPressed = null;
      updateKeyElement(keyId, false);
    });
    k.addEventListener('mouseleave', () => {
      typerKeyPressed = null;
      updateKeyElement(keyId, false);
    });
  });
  
  // Wire up Virtual Hardware Slots UI controls
  const diskInput = document.getElementById('disk-input');
  const btnInsertDisk = document.getElementById('btn-insert-disk');
  const btnShowDir = document.getElementById('btn-show-dir');
  
  if (btnInsertDisk && diskInput) {
    btnInsertDisk.addEventListener('click', () => {
      diskInput.click();
    });
    diskInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onerror = () => {
        alert("Error reading disk file: " + file.name);
      };
      reader.onload = (evt) => {
        loadDiskDsk(evt.target.result, file.name);
      };
      reader.readAsArrayBuffer(file);
    });
  }
  
  if (btnShowDir) {
    btnShowDir.addEventListener('click', () => {
      if (lastLoadedDiskBuffer && lastLoadedDiskName) {
        loadDiskDsk(lastLoadedDiskBuffer, lastLoadedDiskName);
      }
    });
  }
  
  const cartInput = document.getElementById('cart-input');
  const btnInsertCart = document.getElementById('btn-insert-cart');
  
  if (btnInsertCart && cartInput) {
    btnInsertCart.addEventListener('click', () => {
      cartInput.click();
    });
    cartInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onerror = () => {
        alert("Error reading cartridge file: " + file.name);
      };
      reader.onload = (evt) => {
        loadCartridgeRom(evt.target.result, file.name);
      };
      reader.readAsArrayBuffer(file);
    });
  }
  
  const tapeInput = document.getElementById('tape-input');
  const btnLoadTape = document.getElementById('btn-load-tape');
  
  if (btnLoadTape && tapeInput) {
    btnLoadTape.addEventListener('click', () => {
      tapeInput.click();
    });
    tapeInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onerror = () => {
        alert("Error reading cassette tape file: " + file.name);
      };
      reader.onload = (evt) => {
        loadCassetteWav(evt.target.result, file.name);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Wire up Eject buttons
  const btnEjectDisk = document.getElementById('btn-eject-disk');
  if (btnEjectDisk) {
    btnEjectDisk.addEventListener('click', ejectDisk);
  }
  
  const btnEjectCart = document.getElementById('btn-eject-cart');
  if (btnEjectCart) {
    btnEjectCart.addEventListener('click', ejectCartridge);
  }
  
  const btnEjectTape = document.getElementById('btn-eject-tape');
  if (btnEjectTape) {
    btnEjectTape.addEventListener('click', ejectCassette);
  }

  // Initialize Eject buttons visibility
  if (btnEjectDisk) {
    btnEjectDisk.style.display = lastLoadedDiskBuffer ? 'inline-block' : 'none';
  }
  if (btnEjectCart) {
    btnEjectCart.style.display = cartridgeLoaded ? 'inline-block' : 'none';
  }
  if (btnEjectTape) {
    btnEjectTape.style.display = cassetteBuffer ? 'inline-block' : 'none';
  }

  // Prevent buttons and file inputs from retaining focus and triggering on Enter/Space
  document.addEventListener('click', (e) => {
    const focusable = e.target.closest('button, input[type="file"]');
    if (focusable) {
      focusable.blur();
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'file') {
      e.target.blur();
    }
  });

  // Power on automatically on load
  powerOn();
  recalculateTyperTiming();
});
