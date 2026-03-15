/**
 * TextureAlphaBaker
 *
 * Converts BMP images with color key transparency to PNG images with alpha channel.
 * BMP format handled: 8-bit indexed and 24-bit uncompressed.
 * PNG output: 32-bit RGBA with pre-computed alpha channel.
 *
 * WebP encoding/decoding uses Sharp (native, 5-10x faster than WASM on Linux).
 * BMP/PNG codecs are pure Node.js (no external deps).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import sharp from 'sharp';

export interface ColorKey { r: number; g: number; b: number }

export interface BakeResult {
  success: boolean;
  inputPath: string;
  outputPath: string;
  width: number;
  height: number;
  colorKey: ColorKey;
  transparentPixels: number;
  totalPixels: number;
  error?: string;
}

interface BmpData {
  width: number;
  height: number;
  pixels: Buffer;
}

// ============================================================================
// CRC32 for PNG chunk checksums
// ============================================================================

const CRC_TABLE: Uint32Array = new Uint32Array(256);
(function initCrcTable() {
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xEDB88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    CRC_TABLE[n] = c >>> 0;
  }
})();

function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================================
// BMP Decoder (8-bit indexed and 24-bit uncompressed)
// ============================================================================

export function decodeBmp(buffer: Buffer): BmpData {
  if (buffer.length < 54) throw new Error('BMP file too small (< 54 bytes)');

  const signature = buffer.readUInt16LE(0);
  if (signature !== 0x4D42) throw new Error(`Invalid BMP signature: 0x${signature.toString(16)}`);

  const dataOffset = buffer.readUInt32LE(10);
  const headerSize = buffer.readUInt32LE(14);
  if (headerSize < 40) throw new Error(`Unsupported BMP header size: ${headerSize}`);

  const width = buffer.readInt32LE(18);
  const height = buffer.readInt32LE(22);
  const bitsPerPixel = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);

  if (bitsPerPixel !== 8 && bitsPerPixel !== 24) {
    throw new Error(`Unsupported BMP bit depth: ${bitsPerPixel}`);
  }
  if (compression !== 0) throw new Error(`Unsupported BMP compression: ${compression}`);

  const isBottomUp = height > 0;
  const absHeight = Math.abs(height);
  const pixels = Buffer.alloc(width * absHeight * 4);

  if (bitsPerPixel === 8) {
    const paletteOffset = 14 + headerSize;
    const numColors = buffer.readUInt32LE(46) || 256;
    const palette: Array<{ r: number; g: number; b: number }> = [];

    for (let i = 0; i < numColors; i++) {
      const off = paletteOffset + i * 4;
      palette.push({ r: buffer[off + 2], g: buffer[off + 1], b: buffer[off] });
    }

    const rowSize = Math.ceil(width / 4) * 4;
    for (let y = 0; y < absHeight; y++) {
      const srcRow = isBottomUp ? (absHeight - 1 - y) : y;
      const srcOffset = dataOffset + srcRow * rowSize;
      for (let x = 0; x < width; x++) {
        const paletteIndex = buffer[srcOffset + x];
        const color = palette[paletteIndex] || { r: 0, g: 0, b: 0 };
        const dstIdx = (y * width + x) * 4;
        pixels[dstIdx] = color.r;
        pixels[dstIdx + 1] = color.g;
        pixels[dstIdx + 2] = color.b;
        pixels[dstIdx + 3] = 255;
      }
    }
  } else {
    const rowSize = Math.ceil((width * 3) / 4) * 4;
    for (let y = 0; y < absHeight; y++) {
      const srcRow = isBottomUp ? (absHeight - 1 - y) : y;
      const srcOffset = dataOffset + srcRow * rowSize;
      for (let x = 0; x < width; x++) {
        const srcIdx = srcOffset + x * 3;
        const dstIdx = (y * width + x) * 4;
        pixels[dstIdx] = buffer[srcIdx + 2];
        pixels[dstIdx + 1] = buffer[srcIdx + 1];
        pixels[dstIdx + 2] = buffer[srcIdx];
        pixels[dstIdx + 3] = 255;
      }
    }
  }

  return { width, height: absHeight, pixels };
}

// ============================================================================
// PNG Encoder (minimal, RGBA only)
// ============================================================================

function createPngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crcValue = crc32(crcInput);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crcValue, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

export function encodePng(width: number, height: number, rgbaPixels: Buffer): Buffer {
  const rowBytes = width * 4;
  const rawData = Buffer.alloc(height * (1 + rowBytes));

  for (let y = 0; y < height; y++) {
    const rawOffset = y * (1 + rowBytes);
    rawData[rawOffset] = 2; // Up filter
    const currRow = y * rowBytes;
    const prevRow = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const curr = rgbaPixels[currRow + x];
      const above = y > 0 ? rgbaPixels[prevRow + x] : 0;
      rawData[rawOffset + 1 + x] = (curr - above) & 0xFF;
    }
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const chunks: Buffer[] = [];

  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); // PNG signature

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(createPngChunk('IHDR', ihdr));
  chunks.push(createPngChunk('IDAT', compressed));
  chunks.push(createPngChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

// ============================================================================
// Alpha Baking
// ============================================================================

export function applyColorKey(
  pixels: Buffer, width: number, height: number,
  colorKey: ColorKey, tolerance: number = 5
): number {
  let transparentCount = 0;
  const totalPixels = width * height;

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * 4;
    if (
      Math.abs(pixels[offset] - colorKey.r) <= tolerance &&
      Math.abs(pixels[offset + 1] - colorKey.g) <= tolerance &&
      Math.abs(pixels[offset + 2] - colorKey.b) <= tolerance
    ) {
      pixels[offset + 3] = 0;
      transparentCount++;
    }
  }
  return transparentCount;
}

export function detectColorKey(pixels: Buffer): ColorKey {
  return { r: pixels[0], g: pixels[1], b: pixels[2] };
}

export function bakeAlpha(
  inputPath: string, outputPath?: string,
  staticColorKey?: ColorKey | null, tolerance: number = 5
): BakeResult {
  const outPath = outputPath || inputPath.replace(/\.bmp$/i, '.png');
  try {
    const bmpBuffer = fs.readFileSync(inputPath);
    const bmpData = decodeBmp(bmpBuffer);
    const colorKey = staticColorKey || detectColorKey(bmpData.pixels);
    const transparentPixels = applyColorKey(bmpData.pixels, bmpData.width, bmpData.height, colorKey, tolerance);
    const pngBuffer = encodePng(bmpData.width, bmpData.height, bmpData.pixels);

    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, pngBuffer);

    return {
      success: true, inputPath, outputPath: outPath,
      width: bmpData.width, height: bmpData.height, colorKey,
      transparentPixels, totalPixels: bmpData.width * bmpData.height,
    };
  } catch (error: unknown) {
    return {
      success: false, inputPath, outputPath: outPath,
      width: 0, height: 0, colorKey: { r: 0, g: 0, b: 0 },
      transparentPixels: 0, totalPixels: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// RGBA Downscaler (2× box filter for chunk zoom levels)
// ============================================================================

export function downscaleRGBA2x(
  src: Buffer, srcW: number, srcH: number
): { pixels: Buffer; width: number; height: number } {
  const dstW = Math.floor(srcW / 2);
  const dstH = Math.floor(srcH / 2);
  const dst = Buffer.alloc(dstW * dstH * 4, 0);

  for (let dy = 0; dy < dstH; dy++) {
    const sy = dy * 2;
    for (let dx = 0; dx < dstW; dx++) {
      const sx = dx * 2;
      const i00 = (sy * srcW + sx) * 4;
      const i10 = (sy * srcW + sx + 1) * 4;
      const i01 = ((sy + 1) * srcW + sx) * 4;
      const i11 = ((sy + 1) * srcW + sx + 1) * 4;

      const dstIdx = (dy * dstW + dx) * 4;
      const a00 = src[i00 + 3], a10 = src[i10 + 3], a01 = src[i01 + 3], a11 = src[i11 + 3];
      const sumA = a00 + a10 + a01 + a11;

      if (sumA > 0) {
        dst[dstIdx]     = ((src[i00] * a00 + src[i10] * a10 + src[i01] * a01 + src[i11] * a11) / sumA + 0.5) | 0;
        dst[dstIdx + 1] = ((src[i00 + 1] * a00 + src[i10 + 1] * a10 + src[i01 + 1] * a01 + src[i11 + 1] * a11) / sumA + 0.5) | 0;
        dst[dstIdx + 2] = ((src[i00 + 2] * a00 + src[i10 + 2] * a10 + src[i01 + 2] * a01 + src[i11 + 2] * a11) / sumA + 0.5) | 0;
        dst[dstIdx + 3] = Math.max(a00, a10, a01, a11);
      }
    }
  }

  return { pixels: dst, width: dstW, height: dstH };
}

// ============================================================================
// WebP Encoder/Decoder (via Sharp — native, fast on Linux)
// ============================================================================

export async function encodeWebP(width: number, height: number, rgbaPixels: Buffer): Promise<Buffer> {
  return sharp(rgbaPixels, { raw: { width, height, channels: 4 } })
    .webp({ lossless: true, quality: 100, effort: 6 })
    .toBuffer();
}

export async function decodeWebP(buffer: Buffer): Promise<PngData> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width: info.width,
    height: info.height,
    pixels: Buffer.from(data),
  };
}

// ============================================================================
// PNG Decoder (minimal, RGBA only)
// ============================================================================

export interface PngData {
  width: number;
  height: number;
  pixels: Buffer;
}

export function decodePng(buffer: Buffer): PngData {
  const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0, height = 0;
  const idatChunks: Buffer[] = [];
  let offset = 8;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const chunkData = buffer.subarray(offset + 8, offset + 8 + chunkLength);

    if (chunkType === 'IHDR') {
      if (chunkLength < 13) throw new Error('Invalid IHDR chunk');
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      if (chunkData[8] !== 8) throw new Error(`Unsupported PNG bit depth: ${chunkData[8]}`);
      if (chunkData[9] !== 6) throw new Error(`Unsupported PNG color type: ${chunkData[9]}`);
      if (chunkData[12] !== 0) throw new Error('Interlaced PNGs not supported');
    } else if (chunkType === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (chunkType === 'IEND') {
      break;
    }

    offset += 4 + 4 + chunkLength + 4;
  }

  if (width === 0 || height === 0) throw new Error('Missing IHDR chunk in PNG');
  if (idatChunks.length === 0) throw new Error('Missing IDAT chunk in PNG');

  const compressedData = Buffer.concat(idatChunks);
  const rawData = zlib.inflateSync(compressedData);

  const rowBytes = width * 4;
  const expectedSize = height * (1 + rowBytes);
  if (rawData.length !== expectedSize) {
    throw new Error(`PNG data size mismatch: expected ${expectedSize}, got ${rawData.length}`);
  }

  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filterByte = rawData[y * (1 + rowBytes)];
    const rowStart = y * (1 + rowBytes) + 1;
    const dstStart = y * rowBytes;

    if (filterByte === 0) {
      rawData.copy(pixels, dstStart, rowStart, rowStart + rowBytes);
    } else if (filterByte === 2) {
      for (let x = 0; x < rowBytes; x++) {
        const above = y > 0 ? pixels[dstStart - rowBytes + x] : 0;
        pixels[dstStart + x] = (rawData[rowStart + x] + above) & 0xFF;
      }
    } else {
      throw new Error(`Unsupported PNG filter type: ${filterByte}`);
    }
  }

  return { width, height, pixels };
}

// ============================================================================
// BMP Index Decoder (8-bit indexed only — returns raw palette indices)
// ============================================================================

export interface BmpIndexData {
  width: number;
  height: number;
  indices: Uint8Array;
}

export function decodeBmpIndices(buffer: Buffer): BmpIndexData {
  if (buffer.length < 54) throw new Error('BMP file too small (< 54 bytes)');

  const signature = buffer.readUInt16LE(0);
  if (signature !== 0x4D42) throw new Error(`Invalid BMP signature: 0x${signature.toString(16)}`);

  const dataOffset = buffer.readUInt32LE(10);
  const headerSize = buffer.readUInt32LE(14);
  if (headerSize < 40) throw new Error(`Unsupported BMP header size: ${headerSize}`);

  const width = buffer.readInt32LE(18);
  const height = buffer.readInt32LE(22);
  const bitsPerPixel = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);

  if (bitsPerPixel !== 8) throw new Error(`decodeBmpIndices only supports 8-bit indexed BMP, got ${bitsPerPixel}-bit`);
  if (compression !== 0) throw new Error(`Unsupported BMP compression: ${compression}`);

  const isBottomUp = height > 0;
  const absHeight = Math.abs(height);
  const rowSize = Math.ceil(width / 4) * 4;
  const indices = new Uint8Array(width * absHeight);

  for (let y = 0; y < absHeight; y++) {
    const srcRow = isBottomUp ? (absHeight - 1 - y) : y;
    const srcOffset = dataOffset + srcRow * rowSize;
    for (let x = 0; x < width; x++) {
      indices[y * width + x] = buffer[srcOffset + x];
    }
  }

  return { width, height: absHeight, indices };
}

export function bakeDirectory(
  directory: string, staticColorKey?: ColorKey | null, tolerance: number = 5
): BakeResult[] {
  const results: BakeResult[] = [];
  if (!fs.existsSync(directory)) return results;

  const bmpFiles = fs.readdirSync(directory).filter(f => f.toLowerCase().endsWith('.bmp'));

  for (const file of bmpFiles) {
    const inputPath = path.join(directory, file);
    const outputPath = path.join(directory, file.replace(/\.bmp$/i, '.png'));

    if (fs.existsSync(outputPath)) {
      const bmpStat = fs.statSync(inputPath);
      const pngStat = fs.statSync(outputPath);
      if (pngStat.mtimeMs > bmpStat.mtimeMs) {
        results.push({
          success: true, inputPath, outputPath, width: 0, height: 0,
          colorKey: { r: 0, g: 0, b: 0 }, transparentPixels: 0, totalPixels: 0,
        });
        continue;
      }
    }

    results.push(bakeAlpha(inputPath, outputPath, staticColorKey, tolerance));
  }

  return results;
}
