/**
 * CAB Extractor - Cross-platform Microsoft Cabinet archive extraction
 *
 * Uses the '7zip-min' npm package (v2) for CAB extraction.
 * No external tools required - 7zip-min includes precompiled 7za binaries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { toErrorMessage } from '../shared/error-utils';
import type { ListItem } from '7zip-min';
import * as _7z from '7zip-min';

export interface CabFileInfo {
  name: string;
  size: number;
  offset: number;
}

export interface CabExtractionResult {
  success: boolean;
  extractedFiles: string[];
  errors: string[];
}

function parse7zList(output: ListItem[]): CabFileInfo[] {
  const files: CabFileInfo[] = [];
  if (!Array.isArray(output)) return files;

  for (const item of output) {
    if (item && item.name) {
      files.push({
        name: item.name.replace(/\\/g, '/'),
        size: parseInt(item.size || '0', 10),
        offset: 0,
      });
    }
  }
  return files;
}

function getExtractedFiles(targetDir: string, baseDir: string = targetDir): string[] {
  const files: string[] = [];
  if (!fs.existsSync(targetDir)) return files;

  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      files.push(...getExtractedFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

export async function extractCabArchive(
  cabPath: string,
  targetDir: string
): Promise<CabExtractionResult> {
  const result: CabExtractionResult = {
    success: false,
    extractedFiles: [],
    errors: [],
  };

  if (!fs.existsSync(cabPath)) {
    result.errors.push(`CAB file not found: ${cabPath}`);
    return result;
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  try {
    await _7z.unpack(cabPath, targetDir);

    const cabBaseName = path.basename(cabPath).toLowerCase();
    const extractedFiles = getExtractedFiles(targetDir).filter(
      f => f.toLowerCase() !== cabBaseName
    );

    if (extractedFiles.length === 0) {
      result.errors.push(`No files extracted from CAB archive: ${cabPath}`);
      return result;
    }

    result.extractedFiles = extractedFiles;
    result.success = true;
  } catch (error: unknown) {
    result.errors.push(`Extraction error: ${toErrorMessage(error)}`);
  }

  return result;
}

export async function listCabContents(cabPath: string): Promise<CabFileInfo[] | null> {
  if (!fs.existsSync(cabPath)) return null;
  try {
    const output = await _7z.list(cabPath);
    return parse7zList(output);
  } catch {
    return null;
  }
}

export async function isCabExtractorAvailable(): Promise<boolean> {
  try {
    return !!_7z && typeof _7z.unpack === 'function';
  } catch {
    return false;
  }
}
