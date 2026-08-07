/**
 * MC6847 Video Display Generator (VDG) Emulator Core
 *
 * Renders the CoCo 2's Text/Semigraphics 4 and CG/RG graphics modes to
 * a 2D canvas context, based on the current SAM display-offset register and
 * the PIA1 Port B mode-select bits (A/G, GM0-GM2, CSS). This is the chip's
 * own digital output only: decoded VRAM bits/codes turned into pixels at
 * the mode's native resolution, then scanned out to the physical 256x192
 * screen. Analog composite/RF signal conditioning (NTSC artifact coloring,
 * low-pass blur) happens downstream of the chip and is not this module's
 * concern - see colorizeRow in the options passed to create().
 *
 * Sources and References:
 * 1. MC6847 Video Display Generator (VDG) Mode Tables
 * 2. Tandy Color Computer 2 Hardware Reference Manual (Catalog No. 26-3136)
 */
(function (name, definition) {
  if (typeof module != "undefined") module.exports = definition();
  else if (typeof define == "function" && typeof define.amd == "object")
    define(definition);
  else this[name] = definition();
})("MC6847", function () {

  const TEXT_COLORS = [
    '#00ff00', // Green
    '#ffff00', // Yellow
    '#0000ff', // Blue
    '#ff0000', // Red
    '#ffffff', // Buff/White
    '#00ffff', // Cyan
    '#ff00ff', // Magenta
    '#ff8800'  // Orange
  ];

  function create(options) {
    options = options || {};
    const ram = options.ram; // Uint8Array backing store the VDG reads video memory from

    // colorizeRow(bits, width, css) turns one row of raw 1bpp VDG pixel
    // output (native mode resolution) into RGB. Owned by the caller so that
    // analog signal conditioning (NTSC artifact colors, composite blur)
    // lives outside the chip core. Falls back to plain digital on/off if
    // the caller doesn't supply one.
    const colorizeRow = options.colorizeRow || defaultColorizeRow;

    // blurRow(row, width, gm) optionally softens an already-decoded RGB row
    // (native mode resolution) for CG (2bpp) modes, which pick discrete
    // colors directly and so skip colorizeRow entirely. gm is the raw
    // GM0-GM2 mode index, letting the caller vary the effect per submode.
    // Purely cosmetic signal conditioning owned by the caller; no-op if not
    // supplied.
    const blurRow = options.blurRow || (row => row);

    const vdg = {
      // Renders the current frame. displayStart is the byte offset into ram
      // (from SAM.f), pia1PortB is PIA1's Port B register (GM0-GM2, A/G, CSS),
      // samV is the SAM's own V0-V2 VDG-mode-select bits.
      render(ctx, displayStart, pia1PortB, samV) {
        const css = (pia1PortB & 0x08) ? 1 : 0; // Color Set Select
        const ag = (pia1PortB & 0x80) ? 1 : 0;  // Alpha/Graphics mode select
        const gm = (pia1PortB & 0x70) >> 4;     // GM0-GM2: graphics resolution/color-depth select

        if (ag === 1) {
          renderGraphicsMode(ctx, displayStart, css, gm, samV);
        } else {
          renderTextMode(ctx, displayStart, css);
        }
      }
    };

    function defaultColorizeRow(bits, width, css) {
      const fgRGB = css ? [238, 238, 238] : [0, 255, 0];
      const bgRGB = [0, 17, 0];
      const row = new Uint8Array(width * 3);
      for (let x = 0; x < width; x++) {
        const rgb = bits[x] ? fgRGB : bgRGB;
        row[x * 3] = rgb[0]; row[x * 3 + 1] = rgb[1]; row[x * 3 + 2] = rgb[2];
      }
      return row;
    }

    // Text Mode render
    // Screen size: 32 columns * 16 rows. Cell resolution: 8 * 12.
    function renderTextMode(ctx, displayStart, css) {
      ctx.fillStyle = '#001100'; // Background border
      ctx.fillRect(0, 0, 256, 192);

      // Set up font for fillText
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (let row = 0; row < 16; row++) {
        for (let col = 0; col < 32; col++) {
          const addr = displayStart + row * 32 + col;
          const b = ram[addr];
          const x = col * 8;
          const y = row * 12;

          if (b < 128) {
            // Text character
            const isInverse = b >= 64;
            const charCode = isInverse ? (b - 64) : b;

            let charStr = ' ';
            if (charCode < 32) {
              charStr = String.fromCharCode(charCode + 64); // @, A-Z, etc.
            } else {
              charStr = String.fromCharCode(charCode);      // space, numbers, punctuation
            }

            // Define colors based on inverse flag and CSS color set
            let fgColor = css ? '#eeeeee' : '#00ff00';
            let bgColor = '#001100';

            if (isInverse) {
              // Swap background and foreground
              const temp = fgColor;
              fgColor = bgColor;
              bgColor = temp;
            }

            // Draw character background
            ctx.fillStyle = bgColor;
            ctx.fillRect(x, y, 8, 12);

            // Draw character text
            ctx.fillStyle = fgColor;
            ctx.fillText(charStr, x + 4, y + 6);
          } else {
            // Semigraphics 4 mode (SG4: 2x2 colored pixel block)
            const colorIdx = (b >> 4) & 0x07;
            const color = TEXT_COLORS[colorIdx];

            // 2x2 sub-pixel configurations (4 bits control each quadrant)
            const bit0 = b & 0x01; // top-left
            const bit1 = b & 0x02; // top-right
            const bit2 = b & 0x04; // bottom-left
            const bit3 = b & 0x08; // bottom-right

            ctx.fillStyle = '#001100'; // Default black background
            ctx.fillRect(x, y, 8, 12);

            ctx.fillStyle = color;
            if (bit0) ctx.fillRect(x, y, 4, 6);
            if (bit1) ctx.fillRect(x + 4, y, 4, 6);
            if (bit2) ctx.fillRect(x, y + 6, 4, 6);
            if (bit3) ctx.fillRect(x + 4, y + 6, 4, 6);
          }
        }
      }
    }

    // Graphics submode dimensions selected by PIA1 GM0-GM2 (MC6847 mode table).
    // Lower-resolution modes have fewer actual VRAM rows/columns than the
    // physical 256x192 screen; the VDG stretches each source pixel/row to
    // fill it (the CoCo's SAM otherwise handles this via scanline repetition).
    const GRAPHICS_MODES = [
      { width: 64,  rows: 64,  bpp: 2 }, // 000: CG1
      { width: 128, rows: 64,  bpp: 1 }, // 001: RG1
      { width: 128, rows: 64,  bpp: 2 }, // 010: CG2
      { width: 128, rows: 96,  bpp: 1 }, // 011: RG2
      { width: 128, rows: 96,  bpp: 2 }, // 100: CG3
      { width: 128, rows: 192, bpp: 1 }, // 101: RG3
      { width: 128, rows: 192, bpp: 2 }, // 110: CG6
      { width: 256, rows: 192, bpp: 1 }, // 111: RG6 (PMODE 4)
    ];

    // The SAM (not the VDG/PIA1) actually generates the video address
    // sequence, and its own V0-V2 mode bits independently set how many
    // scan lines each VRAM row is held for before the address advances -
    // i.e. the true unique row count. This is why G1C/G1R share a V value
    // (both 64 rows) and G6R/G6C share another (both 192 rows): the V bits
    // group by vertical timing only, orthogonal to the CG/RG pixel format
    // PIA1's GM bits select. Software is expected to keep both in sync, but
    // some games deliberately pair a fine-grained GM decode format with a
    // coarser SAM row count to halve their VRAM footprint (e.g. Megabug:
    // GM selects RG6's 256-wide decode while SAM.v selects G3C's 96-row
    // timing, doubling each real row to fill 192 lines) - so the row count
    // must come from here, not from GRAPHICS_MODES, whenever SAM.v is
    // available.
    const SAM_V_ROWS = [
      null, // 000: AI/AE/S4/S6 (alphanumeric/semigraphics - not a graphics row count)
      64,   // 001: G1C/G1R
      64,   // 010: G2C
      96,   // 011: G2R
      96,   // 100: G3C
      192,  // 101: G3R
      192,  // 110: G6R/G6C
      null, // 111: DMA (not a graphics row count)
    ];

    // Graphics Mode render. Decodes VRAM into raw pixel values at each
    // mode's native resolution, hands 1bpp (RG*) rows to colorizeRow for
    // coloring (digital on/off by default, or whatever signal conditioning
    // the caller supplies), and scans the result out to the physical
    // 256x192 screen. 4-color (CG*) modes pick their colors directly here
    // (that part is deterministic VDG chip behavior), then pass the result
    // through blurRow for the same optional cosmetic signal conditioning
    // as RG modes.
    function renderGraphicsMode(ctx, displayStart, css, gm, samV) {
      const { width, bpp } = GRAPHICS_MODES[gm];
      const rows = (samV != null && SAM_V_ROWS[samV] != null) ? SAM_V_ROWS[samV] : GRAPHICS_MODES[gm].rows;
      const bytesPerRow = (width * bpp) / 8;
      const hScale = 256 / width;
      const vScale = 192 / rows;

      const imgData = ctx.createImageData(256, 192);
      const data = imgData.data;

      // CG modes' direct 4-color set, selected by CSS
      const cgPalette = css
        ? [[238, 238, 238], [0, 255, 255], [255, 0, 255], [255, 136, 0]] // Buff, Cyan, Magenta, Orange
        : [[0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 0]];        // Green, Yellow, Blue, Red

      // Temporary buffers, all at native mode resolution except the final scanline
      const bits = bpp === 1 ? new Uint8Array(width) : null;
      const cgRow = bpp === 2 ? new Uint8Array(width * 3) : null;
      const scanline = new Uint8Array(256 * 3);

      for (let srcY = 0; srcY < rows; srcY++) {
        let coloredRow;

        // 1. Decode this source row at native mode resolution
        if (bpp === 1) {
          for (let xByte = 0; xByte < bytesPerRow; xByte++) {
            const addr = displayStart + srcY * bytesPerRow + xByte;
            const val = ram[addr];
            for (let bit = 0; bit < 8; bit++) {
              bits[xByte * 8 + bit] = (val & (0x80 >> bit)) ? 1 : 0;
            }
          }
          coloredRow = colorizeRow(bits, width, css);
        } else {
          for (let xByte = 0; xByte < bytesPerRow; xByte++) {
            const addr = displayStart + srcY * bytesPerRow + xByte;
            const val = ram[addr];

            for (let pix = 0; pix < 4; pix++) {
              const code = (val >> (6 - pix * 2)) & 0x03;
              const rgb = cgPalette[code];
              const x = xByte * 4 + pix;
              cgRow[x * 3] = rgb[0]; cgRow[x * 3 + 1] = rgb[1]; cgRow[x * 3 + 2] = rgb[2];
            }
          }
          coloredRow = blurRow(cgRow, width, gm);
        }

        // 2. Expand horizontally to the 256px-wide physical scanline
        for (let dx = 0; dx < 256; dx++) {
          const sx = (dx / hScale) | 0;
          scanline[dx * 3]     = coloredRow[sx * 3];
          scanline[dx * 3 + 1] = coloredRow[sx * 3 + 1];
          scanline[dx * 3 + 2] = coloredRow[sx * 3 + 2];
        }

        // 3. Repeat this scanline vertically to fill the 192-line physical screen
        for (let r = 0; r < vScale; r++) {
          const rowOffset = (srcY * vScale + r) * 256 * 4;
          for (let x = 0; x < 256; x++) {
            const idx = rowOffset + x * 4;
            data[idx]     = scanline[x * 3];
            data[idx + 1] = scanline[x * 3 + 1];
            data[idx + 2] = scanline[x * 3 + 2];
            data[idx + 3] = 255;
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }

    return vdg;
  }

  return { create: create };
});
