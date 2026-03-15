/**
 * AtlasGenerator
 *
 * Packs terrain textures into a single atlas PNG + JSON manifest.
 * Atlas layout: 16×16 grid = 256 slots, 64×96 cells → 1024×1536 pixels.
 *
 * No external dependencies — uses BMP decoder + PNG encoder from texture-alpha-baker.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodeBmp, encodePng, applyColorKey, detectColorKey } from './texture-alpha-baker';

export interface AtlasManifest {
  version: number;
  terrainType: string;
  season: number;
  tileWidth: number;
  tileHeight: number;
  cellHeight: number;
  atlasWidth: number;
  atlasHeight: number;
  columns: number;
  rows: number;
  tiles: Record<string, TileEntry>;
}

export interface TileEntry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TextureInput {
  paletteIndex: number;
  filePath: string;
}

export interface AtlasResult {
  success: boolean;
  atlasPath: string;
  manifestPath: string;
  tileCount: number;
  atlasWidth: number;
  atlasHeight: number;
  error?: string;
}

const TILE_WIDTH = 64;
const STANDARD_TILE_HEIGHT = 32;
const CELL_HEIGHT = 96;
const ATLAS_COLUMNS = 16;
const ATLAS_ROWS = 16;

export function generateTerrainAtlas(
  textures: TextureInput[], outputDir: string,
  terrainType: string, season: number
): AtlasResult {
  const atlasPath = path.join(outputDir, 'atlas.png');
  const manifestPath = path.join(outputDir, 'atlas.json');

  try {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const atlasWidth = ATLAS_COLUMNS * TILE_WIDTH;
    const atlasHeight = ATLAS_ROWS * CELL_HEIGHT;
    const atlasPixels = Buffer.alloc(atlasWidth * atlasHeight * 4, 0);
    const tileEntries: Record<string, TileEntry> = {};
    let tileCount = 0;

    for (const tex of textures) {
      const { paletteIndex, filePath } = tex;
      if (!fs.existsSync(filePath)) continue;

      try {
        // Always read BMP source and apply color key
        const bmpPath = filePath.replace(/\.png$/i, '.bmp');
        const sourcePath = fs.existsSync(bmpPath) ? bmpPath : filePath;
        if (!sourcePath.toLowerCase().endsWith('.bmp') && !fs.existsSync(bmpPath)) continue;

        const bmpBuffer = fs.readFileSync(sourcePath.toLowerCase().endsWith('.bmp') ? sourcePath : bmpPath);
        const bmpData = decodeBmp(bmpBuffer);
        const colorKey = detectColorKey(bmpData.pixels);
        applyColorKey(bmpData.pixels, bmpData.width, bmpData.height, colorKey);
        const pixels = bmpData.pixels;
        const texWidth = bmpData.width;
        const texHeight = bmpData.height;

        const col = paletteIndex % ATLAS_COLUMNS;
        const row = Math.floor(paletteIndex / ATLAS_COLUMNS);
        if (row >= ATLAS_ROWS) continue;

        const cellX = col * TILE_WIDTH;
        const cellY = row * CELL_HEIGHT;
        const yOffset = CELL_HEIGHT - texHeight;

        for (let y = 0; y < texHeight; y++) {
          for (let x = 0; x < Math.min(texWidth, TILE_WIDTH); x++) {
            const srcIdx = (y * texWidth + x) * 4;
            const dstX = cellX + x;
            const dstY = cellY + yOffset + y;
            if (dstX < atlasWidth && dstY < atlasHeight) {
              const dstIdx = (dstY * atlasWidth + dstX) * 4;
              atlasPixels[dstIdx] = pixels[srcIdx];
              atlasPixels[dstIdx + 1] = pixels[srcIdx + 1];
              atlasPixels[dstIdx + 2] = pixels[srcIdx + 2];
              atlasPixels[dstIdx + 3] = pixels[srcIdx + 3];
            }
          }
        }

        tileEntries[String(paletteIndex)] = {
          x: cellX, y: cellY + yOffset,
          width: Math.min(texWidth, TILE_WIDTH), height: texHeight,
        };
        tileCount++;
      } catch (texError: unknown) {
        console.warn(`[AtlasGenerator] Failed to process texture ${paletteIndex}:`, texError);
      }
    }

    const atlasPng = encodePng(atlasWidth, atlasHeight, atlasPixels);
    fs.writeFileSync(atlasPath, atlasPng);

    const manifest: AtlasManifest = {
      version: 1, terrainType, season,
      tileWidth: TILE_WIDTH, tileHeight: STANDARD_TILE_HEIGHT, cellHeight: CELL_HEIGHT,
      atlasWidth, atlasHeight, columns: ATLAS_COLUMNS, rows: ATLAS_ROWS,
      tiles: tileEntries,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return { success: true, atlasPath, manifestPath, tileCount, atlasWidth, atlasHeight };
  } catch (error: unknown) {
    return {
      success: false, atlasPath, manifestPath, tileCount: 0, atlasWidth: 0, atlasHeight: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function generateObjectAtlas(
  sourceDir: string, outputPath: string, manifestPath: string, category: string
): AtlasResult {
  try {
    if (!fs.existsSync(sourceDir)) {
      return { success: false, atlasPath: outputPath, manifestPath, tileCount: 0, atlasWidth: 0, atlasHeight: 0, error: `Source directory not found: ${sourceDir}` };
    }

    const bmpFiles = fs.readdirSync(sourceDir).filter(f => f.toLowerCase().endsWith('.bmp')).sort();
    if (bmpFiles.length === 0) {
      return { success: false, atlasPath: outputPath, manifestPath, tileCount: 0, atlasWidth: 0, atlasHeight: 0, error: 'No BMP files found' };
    }

    let cellWidth = TILE_WIDTH;
    let cellHeight = STANDARD_TILE_HEIGHT;
    for (const file of bmpFiles) {
      try {
        const buf = fs.readFileSync(path.join(sourceDir, file));
        const bmp = decodeBmp(buf);
        if (bmp.width > cellWidth) cellWidth = bmp.width;
        if (bmp.height > cellHeight) cellHeight = bmp.height;
      } catch { /* skip */ }
    }

    const cols = Math.ceil(Math.sqrt(bmpFiles.length));
    const rows = Math.ceil(bmpFiles.length / cols);
    const atlasWidth = cols * cellWidth;
    const atlasHeight = rows * cellHeight;
    const atlasPixels = Buffer.alloc(atlasWidth * atlasHeight * 4, 0);
    const tileEntries: Record<string, TileEntry> = {};
    let tileCount = 0;

    for (let idx = 0; idx < bmpFiles.length; idx++) {
      const file = bmpFiles[idx];
      try {
        const bmpBuffer = fs.readFileSync(path.join(sourceDir, file));
        const bmpData = decodeBmp(bmpBuffer);
        const colorKey = detectColorKey(bmpData.pixels);
        applyColorKey(bmpData.pixels, bmpData.width, bmpData.height, colorKey);

        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const cellX = col * cellWidth;
        const cellY = row * cellHeight;
        const yOffset = cellHeight - bmpData.height;

        for (let y = 0; y < bmpData.height; y++) {
          for (let x = 0; x < Math.min(bmpData.width, cellWidth); x++) {
            const srcIdx = (y * bmpData.width + x) * 4;
            const dstIdx = ((cellY + yOffset + y) * atlasWidth + cellX + x) * 4;
            atlasPixels[dstIdx] = bmpData.pixels[srcIdx];
            atlasPixels[dstIdx + 1] = bmpData.pixels[srcIdx + 1];
            atlasPixels[dstIdx + 2] = bmpData.pixels[srcIdx + 2];
            atlasPixels[dstIdx + 3] = bmpData.pixels[srcIdx + 3];
          }
        }

        const name = file.replace(/\.bmp$/i, '');
        tileEntries[name] = { x: cellX, y: cellY + yOffset, width: Math.min(bmpData.width, cellWidth), height: bmpData.height };
        tileCount++;
      } catch (texError: unknown) {
        console.warn(`[AtlasGenerator] Failed to process ${file}:`, texError);
      }
    }

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(outputPath, encodePng(atlasWidth, atlasHeight, atlasPixels));
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: 1, category, tileWidth: TILE_WIDTH, tileHeight: STANDARD_TILE_HEIGHT,
      cellWidth, cellHeight, atlasWidth, atlasHeight, columns: cols, rows, tiles: tileEntries,
    }, null, 2));

    return { success: true, atlasPath: outputPath, manifestPath, tileCount, atlasWidth, atlasHeight };
  } catch (error: unknown) {
    return {
      success: false, atlasPath: outputPath, manifestPath, tileCount: 0, atlasWidth: 0, atlasHeight: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
