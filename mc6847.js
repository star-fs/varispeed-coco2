/**
 * MC6847 Video Display Generator (VDG) Emulator Core
 *
 * Renders the CoCo 2's Text/Semigraphics 4 and PMODE 4 high-res graphics
 * modes to a 2D canvas context, based on the current SAM display-offset
 * register and the PIA1 Port B mode-select bits (A/G, CSS).
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

    const vdg = {
      // 'monochrome', 'phase0', 'phase1' NTSC artifact coloring mode
      ntscMode: 'monochrome',

      // Renders the current frame. displayStart is the byte offset into ram
      // (from SAM.f), pia1PortB is PIA1's Port B register (GM0-GM2, A/G, CSS).
      render(ctx, displayStart, pia1PortB) {
        const css = (pia1PortB & 0x08) ? 1 : 0; // Color Set Select
        const ag = (pia1PortB & 0x80) ? 1 : 0;  // Alpha/Graphics mode select
        const gm = (pia1PortB & 0x70) >> 4;     // GM0-GM2: graphics resolution/color-depth select

        if (ag === 1) {
          renderGraphicsMode(this, ctx, displayStart, css, gm);
        } else {
          renderTextMode(this, ctx, displayStart, css);
        }
      }
    };

    // Text Mode render
    // Screen size: 32 columns * 16 rows. Cell resolution: 8 * 12.
    function renderTextMode(vdg, ctx, displayStart, css) {
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
      { width: 128, rows: 96,  bpp: 2 }, // 010: CG2
      { width: 128, rows: 96,  bpp: 1 }, // 011: RG2
      { width: 128, rows: 192, bpp: 2 }, // 100: CG3
      { width: 128, rows: 192, bpp: 1 }, // 101: RG3
      { width: 256, rows: 192, bpp: 2 }, // 110: CG6
      { width: 256, rows: 192, bpp: 1 }, // 111: RG6 (PMODE 4)
    ];

    // Graphics Mode render. 2-color (RG*) modes emulate analog NTSC RF /
    // composite artifacts via horizontal Gaussian blur over pixel-pair
    // artifact generation. 4-color (CG*) modes use the VDG's direct color
    // set instead, since they don't need artifact-based faking.
    function renderGraphicsMode(vdg, ctx, displayStart, css, gm) {
      const { width, rows, bpp } = GRAPHICS_MODES[gm];
      const bytesPerRow = (width * bpp) / 8;
      const hScale = 256 / width;
      const vScale = 192 / rows;
      const ntscMode = vdg.ntscMode;

      const imgData = ctx.createImageData(256, 192);
      const data = imgData.data;

      const fgRGB = css ? [238, 238, 238] : [0, 255, 0];
      const bgRGB = [0, 17, 0];

      // Authentic NTSC Chrominance artifacts (RG modes only)
      const blueRGB = [40, 100, 255];
      const orangeRGB = [255, 100, 0];

      // CG modes' direct 4-color set, selected by CSS
      const cgPalette = css
        ? [[238, 238, 238], [0, 255, 255], [255, 0, 255], [255, 136, 0]] // Buff, Cyan, Magenta, Orange
        : [[0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 0]];        // Green, Yellow, Blue, Red

      // Temporary buffers, all at native mode resolution except the final scanline
      const srcRow = new Uint8Array(width * 3);
      const blurredRow = new Uint8Array(width * 3);
      const scanline = new Uint8Array(256 * 3);

      for (let srcY = 0; srcY < rows; srcY++) {
        // 1. Decode this source row's RGB values at native mode resolution
        if (bpp === 1) {
          for (let xByte = 0; xByte < bytesPerRow; xByte++) {
            const addr = displayStart + srcY * bytesPerRow + xByte;
            const val = ram[addr];

            for (let bit = 0; bit < 8; bit += 2) {
              const x0 = xByte * 8 + bit;
              const x1 = x0 + 1;

              const p0 = (val & (0x80 >> bit)) !== 0;
              const p1 = (val & (0x80 >> (bit + 1))) !== 0;

              let rgb0, rgb1;
              if (ntscMode === 'monochrome') {
                rgb0 = p0 ? fgRGB : bgRGB;
                rgb1 = p1 ? fgRGB : bgRGB;
              } else {
                // NTSC Artifact mode: combine adjacent bits into artifact colors (2-pixel blocks)
                const code = (p0 ? 2 : 0) | (p1 ? 1 : 0);
                let rgb;
                if (code === 0) rgb = bgRGB;
                else if (code === 3) rgb = fgRGB;
                else if (code === 2) rgb = (ntscMode === 'phase0') ? blueRGB : orangeRGB;
                else rgb = (ntscMode === 'phase0') ? orangeRGB : blueRGB;
                rgb0 = rgb1 = rgb;
              }

              srcRow[x0 * 3] = rgb0[0]; srcRow[x0 * 3 + 1] = rgb0[1]; srcRow[x0 * 3 + 2] = rgb0[2];
              srcRow[x1 * 3] = rgb1[0]; srcRow[x1 * 3 + 1] = rgb1[1]; srcRow[x1 * 3 + 2] = rgb1[2];
            }
          }
        } else {
          for (let xByte = 0; xByte < bytesPerRow; xByte++) {
            const addr = displayStart + srcY * bytesPerRow + xByte;
            const val = ram[addr];

            for (let pix = 0; pix < 4; pix++) {
              const code = (val >> (6 - pix * 2)) & 0x03;
              const rgb = cgPalette[code];
              const x = xByte * 4 + pix;
              srcRow[x * 3] = rgb[0]; srcRow[x * 3 + 1] = rgb[1]; srcRow[x * 3 + 2] = rgb[2];
            }
          }
        }

        // 2. Apply the horizontal analog low-pass filter, only meaningful for RG artifact colors
        const applyBlur = (bpp === 1 && ntscMode !== 'monochrome');
        for (let x = 0; x < width; x++) {
          const xc = x * 3;
          if (!applyBlur) {
            blurredRow[xc] = srcRow[xc];
            blurredRow[xc + 1] = srcRow[xc + 1];
            blurredRow[xc + 2] = srcRow[xc + 2];
            continue;
          }
          // 3-tap horizontal Gaussian filter [0.25, 0.50, 0.25] to simulate RF composite video warmth
          const xm1 = (x > 0 ? x - 1 : x) * 3;
          const xp1 = (x < width - 1 ? x + 1 : x) * 3;
          blurredRow[xc]     = (0.25 * srcRow[xm1]     + 0.5 * srcRow[xc]     + 0.25 * srcRow[xp1])     | 0;
          blurredRow[xc + 1] = (0.25 * srcRow[xm1 + 1] + 0.5 * srcRow[xc + 1] + 0.25 * srcRow[xp1 + 1]) | 0;
          blurredRow[xc + 2] = (0.25 * srcRow[xm1 + 2] + 0.5 * srcRow[xc + 2] + 0.25 * srcRow[xp1 + 2]) | 0;
        }

        // 3. Expand horizontally to the 256px-wide physical scanline
        for (let dx = 0; dx < 256; dx++) {
          const sx = (dx / hScale) | 0;
          scanline[dx * 3]     = blurredRow[sx * 3];
          scanline[dx * 3 + 1] = blurredRow[sx * 3 + 1];
          scanline[dx * 3 + 2] = blurredRow[sx * 3 + 2];
        }

        // 4. Repeat this scanline vertically to fill the 192-line physical screen
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
