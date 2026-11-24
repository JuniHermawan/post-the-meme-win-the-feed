// Post the Meme, Win the Feed — meme generator + post linker.
// Pure Node 22, no third-party packages, fully deterministic:
// same input bytes -> same output bytes on every run.
//   1. Renders the meme as a 1080x1080 PNG (hand-rolled PNG encoder
//      + a 5x7 pixel font drawn straight from code) into the output dir.
//   2. Copies POST.json (the X post this entry names) into the output dir.
// The house reads the post itself; the program never touches the network,
// the clock, or any randomness.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const W = 1080;
const H = 1080;

// ---- palette ----
const BG = [13, 17, 23];
const PANEL = [22, 27, 34];
const CYAN = [34, 211, 238];
const YELLOW = [250, 204, 21];
const WHITE = [248, 250, 252];
const MUTED = [139, 148, 158];

// ---- 5x7 pixel font ("#" = on). Only the glyphs the meme needs. ----
const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "3": ["11111", "00001", "00001", "01110", "00001", "00001", "11111"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  $: ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

// ---- raster canvas (RGBA, row-major) ----
const px = Buffer.alloc(W * H * 4, 255);
function fillRect(x: number, y: number, w: number, h: number, c: number[]): void {
  for (let j = y; j < y + h; j++) {
    if (j < 0 || j >= H) continue;
    for (let i = x; i < x + w; i++) {
      if (i < 0 || i >= W) continue;
      const o = (j * W + i) * 4;
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
      px[o + 3] = 255;
    }
  }
}
function drawText(text: string, cx: number, y: number, scale: number, c: number[]): void {
  const adv = 6 * scale;
  const total = text.length * adv - scale;
  let x = Math.round(cx - total / 2);
  for (const ch of text) {
    const g = FONT[ch] ?? FONT[" "];
    for (let r = 0; r < 7; r++) {
      for (let col = 0; col < 5; col++) {
        if (g[r][col] === "1") fillRect(x + col * scale, y + r * scale, scale, scale, c);
      }
    }
    x += adv;
  }
}

// ---- minimal PNG encoder (zlib is a Node builtin; CRC32 table inline) ----
const CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let j = 0; j < H; j++) {
    raw[j * (1 + W * 4)] = 0; // filter: none
    px.copy(raw, j * (1 + W * 4) + 1, j * W * 4, (j + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- the meme itself ----
// A little robot at 3AM: 148 bounties entered, $0.00 won, still grinding.
function renderMeme(): Buffer {
  fillRect(0, 0, W, H, BG);
  fillRect(0, 0, W, 12, CYAN); // top accent strip
  drawText("MAKE.FUN", W / 2, 56, 7, CYAN);
  drawText("AI AGENTS COMPETE FOR REAL MONEY", W / 2, 122, 4, MUTED);

  // robot head
  fillRect(370, 328, 20, 52, CYAN); // left ear
  fillRect(690, 328, 20, 52, CYAN); // right ear
  fillRect(534, 204, 12, 36, CYAN); // antenna stem
  fillRect(522, 168, 36, 36, YELLOW); // antenna light
  fillRect(390, 240, 300, 240, PANEL); // head
  fillRect(390, 240, 300, 8, CYAN); // head top edge
  fillRect(390, 240, 8, 240, CYAN); // head left edge
  fillRect(682, 240, 8, 240, CYAN); // head right edge
  fillRect(390, 472, 300, 8, CYAN); // head bottom edge
  fillRect(440, 308, 56, 64, WHITE); // left eye
  fillRect(584, 308, 56, 64, WHITE); // right eye
  fillRect(458, 326, 20, 28, BG); // left pupil
  fillRect(602, 326, 20, 28, BG); // right pupil
  fillRect(470, 408, 140, 8, CYAN); // mouth grille
  fillRect(470, 426, 140, 8, CYAN);
  fillRect(470, 444, 140, 8, CYAN);

  // the punchline, big and centered
  drawText("148 BOUNTIES", W / 2, 520, 13, WHITE);
  drawText("$0.00 WON", W / 2, 640, 13, YELLOW);
  drawText("STILL GRINDING", W / 2, 756, 11, WHITE);

  // footer
  drawText("3AM. STILL SUBMITTING.", W / 2, 930, 5, MUTED);
  return encodePng();
}

// ---- entrypoint: deterministic outputs, no network, no clock ----
function pickOutputDir(): string {
  const envDir = process.env.MAKEFUN_OUTPUT_DIR;
  if (envDir) return envDir;
  try {
    mkdirSync("/output", { recursive: true });
    return "/output";
  } catch {
    return join(ROOT, "output");
  }
}

const outDir = pickOutputDir();
mkdirSync(outDir, { recursive: true });
const meme = renderMeme();
writeFileSync(join(outDir, "meme.png"), meme);
const post = readFileSync(join(ROOT, "POST.json"));
writeFileSync(join(outDir, "POST.json"), post);
console.log("wrote " + join(outDir, "meme.png") + " (" + meme.length + " bytes)");
console.log("copied POST.json to " + outDir);
