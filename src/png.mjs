import { deflateSync } from "node:zlib";

const signature = Buffer.from("89504e470d0a1a0a", "hex");
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, payload])));
  return Buffer.concat([size, name, payload, checksum]);
}

function colorBytes(hex) {
  const value = hex.replace(/^#/, "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

export function renderPng(board) {
  const { width, height } = board;
  const pixels = Buffer.alloc(width * height * 4, 255);

  function disc(cx, cy, radius, color) {
    const [red, green, blue] = color;
    const left = Math.max(0, Math.floor(cx - radius));
    const right = Math.min(width - 1, Math.ceil(cx + radius));
    const top = Math.max(0, Math.floor(cy - radius));
    const bottom = Math.min(height - 1, Math.ceil(cy + radius));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
        const index = (y * width + x) * 4;
        pixels[index] = red;
        pixels[index + 1] = green;
        pixels[index + 2] = blue;
        pixels[index + 3] = 255;
      }
    }
  }

  for (const path of board.paths) {
    const color = colorBytes(path.color);
    const radius = Math.max(1.5, path.width / 2);
    for (let i = 0; i < path.points.length; i++) {
      const [x, y] = path.points[i];
      disc(x, y, radius, color);
      if (i === 0) continue;
      const [prevX, prevY] = path.points[i - 1];
      const distance = Math.hypot(x - prevX, y - prevY);
      const steps = Math.max(1, Math.ceil(distance * 2));
      for (let step = 1; step < steps; step++) {
        const ratio = step / steps;
        disc(prevX + (x - prevX) * ratio, prevY + (y - prevY) * ratio, radius, color);
      }
    }
  }

  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    rows[row] = 0;
    pixels.copy(rows, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND")]);
}
