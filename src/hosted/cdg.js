// CD+G packets run at 300 packets/second, synchronized to the media clock.
export class Cdg {
  constructor(buffer, canvas) {
    this.data = new Uint8Array(buffer); this.canvas = canvas;
    canvas.width = 300; canvas.height = 216;
    this.context = canvas.getContext("2d");
    this.reset();
  }
  reset() {
    this.pixels = new Uint8Array(300 * 216); this.palette = new Uint32Array(16);
    this.packet = 0; this.transparent = -1; this.x = 0; this.y = 0;
  }
  render(time) {
    const target = Math.min(Math.floor(time * 300), Math.floor(this.data.length / 24));
    if (target < this.packet) this.reset();
    while (this.packet < target) {
      const offset = this.packet++ * 24;
      if ((this.data[offset] & 63) !== 9) continue;
      const command = this.data[offset + 1] & 63, d = this.data.subarray(offset + 4, offset + 20);
      if (command === 1 && !(d[1] & 15)) this.pixels.fill(d[0] & 15);
      if (command === 2) {
        for (let y = 0; y < 216; y++) for (let x = 0; x < 300; x++)
          if (y < 12 || y >= 204 || x < 6 || x >= 294) this.pixels[y * 300 + x] = d[0] & 15;
      }
      if (command === 6 || command === 38) {
        const row = (d[2] & 31) * 12, col = (d[3] & 63) * 6;
        if (row >= 216 || col >= 300) continue;
        for (let y = 0; y < 12; y++) for (let x = 0; x < 6; x++) {
          const i = (row + y) * 300 + col + x, color = d[4 + y] & (1 << (5 - x)) ? d[1] & 15 : d[0] & 15;
          this.pixels[i] = command === 38 ? this.pixels[i] ^ color : color;
        }
      }
      if (command === 30 || command === 31) {
        for (let i = 0; i < 8; i++) {
          const color = (d[i * 2] & 63) * 64 + (d[i * 2 + 1] & 63);
          this.palette[(command === 31 ? 8 : 0) + i] = ((color >> 8) & 15) * 17 * 65536 + ((color >> 4) & 15) * 17 * 256 + (color & 15) * 17;
        }
      }
      if (command === 28) this.transparent = d[0] & 15;
      if (command === 20 || command === 24) {
        this.x = Math.min(d[1] & 7, 5); this.y = Math.min(d[2] & 15, 11);
        const dx = (d[1] & 48) === 16 ? 6 : (d[1] & 48) === 32 ? -6 : 0;
        const dy = (d[2] & 48) === 16 ? 12 : (d[2] & 48) === 32 ? -12 : 0;
        if (dx || dy) {
          const old = this.pixels.slice();
          for (let y = 0; y < 216; y++) for (let x = 0; x < 300; x++) {
            const sx = x - dx, sy = y - dy;
            this.pixels[y * 300 + x] = command === 20 && (sx < 0 || sx >= 300 || sy < 0 || sy >= 216) ? d[0] & 15 : old[((sy + 216) % 216) * 300 + (sx + 300) % 300];
          }
        }
      }
    }
    const image = this.context.createImageData(300, 216);
    for (let y = 0; y < 216; y++) for (let x = 0; x < 300; x++) {
      const i = y * 300 + x, colorIndex = this.pixels[((y + this.y) % 216) * 300 + (x + this.x) % 300], color = this.palette[colorIndex];
      image.data[i * 4] = color >> 16; image.data[i * 4 + 1] = (color >> 8) & 255;
      image.data[i * 4 + 2] = color & 255; image.data[i * 4 + 3] = colorIndex === this.transparent ? 0 : 255;
    }
    this.context.putImageData(image, 0, 0);
  }
}
