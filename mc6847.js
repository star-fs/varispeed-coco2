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

        if (ag === 1) {
          renderGraphicsMode(this, ctx, displayStart, css);
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

    // Graphics Mode render (256x192 monochrome PMODE 4)
    // Emulates analog NTSC RF / composite artifacts via horizontal Gaussian blur over pixel-pair artifact generation
    function renderGraphicsMode(vdg, ctx, displayStart, css) {
      const imgData = ctx.createImageData(256, 192);
      const data = imgData.data;
      const ntscMode = vdg.ntscMode;

      const fgRGB = css ? [238, 238, 238] : [0, 255, 0];
      const bgRGB = [0, 17, 0];

      // Authentic NTSC Chrominance artifacts
      const blueRGB = [40, 100, 255];
      const orangeRGB = [255, 100, 0];

      // Temporary buffer for the scanline RGB values
      const scanline = new Uint8Array(256 * 3);

      for (let y = 0; y < 192; y++) {
        // 1. Generate the raw RGB values for this scanline using pixel-pair mapping
        for (let xByte = 0; xByte < 32; xByte++) {
          const addr = displayStart + y * 32 + xByte;
          const val = ram[addr];

          for (let bit = 0; bit < 8; bit += 2) {
            const pixelX0 = xByte * 8 + bit;
            const pixelX1 = pixelX0 + 1;

            const p0 = (val & (0x80 >> bit)) !== 0;
            const p1 = (val & (0x80 >> (bit + 1))) !== 0;

            let rgb;
            if (ntscMode === 'monochrome') {
              // In monochrome mode, we render each pixel individually at full resolution
              const rgb0 = p0 ? fgRGB : bgRGB;
              const rgb1 = p1 ? fgRGB : bgRGB;

              const offset0 = pixelX0 * 3;
              scanline[offset0]     = rgb0[0];
              scanline[offset0 + 1] = rgb0[1];
              scanline[offset0 + 2] = rgb0[2];

              const offset1 = pixelX1 * 3;
              scanline[offset1]     = rgb1[0];
              scanline[offset1 + 1] = rgb1[1];
              scanline[offset1 + 2] = rgb1[2];
              continue;
            } else {
              // NTSC Artifact mode: combine adjacent bits into artifact colors (2-pixel blocks)
              const code = (p0 ? 2 : 0) | (p1 ? 1 : 0);
              if (code === 0) {
                rgb = bgRGB;
              } else if (code === 3) {
                rgb = fgRGB;
              } else if (code === 2) {
                rgb = (ntscMode === 'phase0') ? blueRGB : orangeRGB;
              } else {
                rgb = (ntscMode === 'phase0') ? orangeRGB : blueRGB;
              }
            }

            const offset0 = pixelX0 * 3;
            scanline[offset0]     = rgb[0];
            scanline[offset0 + 1] = rgb[1];
            scanline[offset0 + 2] = rgb[2];

            const offset1 = pixelX1 * 3;
            scanline[offset1]     = rgb[0];
            scanline[offset1 + 1] = rgb[1];
            scanline[offset1 + 2] = rgb[2];
          }
        }

        // 2. Output to ImageData, applying a horizontal analog low-pass filter if NTSC is active
        for (let x = 0; x < 256; x++) {
          const idx = (y * 256 + x) * 4;

          if (ntscMode === 'monochrome') {
            const offset = x * 3;
            data[idx]     = scanline[offset];
            data[idx + 1] = scanline[offset + 1];
            data[idx + 2] = scanline[offset + 2];
            data[idx + 3] = 255;
          } else {
            // Apply 3-tap horizontal Gaussian filter [0.25, 0.50, 0.25] to simulate RF composite video warmth
            const xm1 = (x > 0) ? (x - 1) * 3 : x * 3;
            const xc  = x * 3;
            const xp1 = (x < 255) ? (x + 1) * 3 : x * 3;

            data[idx]     = (0.25 * scanline[xm1]     + 0.5 * scanline[xc]     + 0.25 * scanline[xp1])     | 0;
            data[idx + 1] = (0.25 * scanline[xm1 + 1] + 0.5 * scanline[xc + 1] + 0.25 * scanline[xp1 + 1]) | 0;
            data[idx + 2] = (0.25 * scanline[xm1 + 2] + 0.5 * scanline[xc + 2] + 0.25 * scanline[xp1 + 2]) | 0;
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
