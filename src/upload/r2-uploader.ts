/**
 * R2 Uploader — uploads all static assets to Cloudflare R2 (S3-compatible).
 *
 * Uploads:
 * - chunks/     → terrain chunk WebP images + preview PNGs (filtered by map)
 * - textures/   → terrain atlases (PNG + JSON) + individual textures
 * - objects/    → road/concrete/car atlases (PNG + JSON)
 * - cache/      → baked object textures (PNG/GIF)
 *
 * Handles parallel uploads with concurrency control, idempotency (skip existing),
 * and retry with exponential backoff.
 */

import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

export interface R2Config {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
}

export interface UploadResult {
  uploaded: number;
  skipped: number;
  failed: number;
  totalBytes: number;
}

interface UploadJob {
  localPath: string;
  key: string;
  contentType: string;
}

export class R2Uploader {
  private client: S3Client;
  private bucket: string;
  private concurrency: number;
  public onProgress?: (uploaded: number, total: number) => void;

  constructor(config: R2Config, concurrency: number = 20) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.bucket = config.bucket;
    this.concurrency = concurrency;
  }

  /**
   * Upload all static assets from the output directory to R2.
   *
   * @param outputDir  Root output directory (webclient-cache/)
   * @param mapFilter  Optional set of map names (lowercase) to filter chunks.
   *                   When provided, only chunks for those maps are uploaded.
   *                   Textures, objects, and cache are always uploaded (shared).
   */
  async uploadAll(outputDir: string, mapFilter?: Set<string> | null): Promise<UploadResult> {
    const jobs: UploadJob[] = [];

    // 1. Chunks (filtered by map)
    const chunksDir = path.join(outputDir, 'chunks');
    if (fs.existsSync(chunksDir)) {
      if (mapFilter && mapFilter.size > 0) {
        for (const entry of fs.readdirSync(chunksDir, { withFileTypes: true })) {
          if (entry.isDirectory() && mapFilter.has(entry.name.toLowerCase())) {
            const mapDir = path.join(chunksDir, entry.name);
            jobs.push(...this.collectJobs(mapDir, `chunks/${entry.name}`));
          }
        }
      } else {
        jobs.push(...this.collectJobs(chunksDir, 'chunks'));
      }
    }

    // 2. Textures (always — shared across maps)
    const texturesDir = path.join(outputDir, 'textures');
    if (fs.existsSync(texturesDir)) {
      jobs.push(...this.collectJobs(texturesDir, 'textures'));
    }

    // 3. Objects (always — shared)
    const objectsDir = path.join(outputDir, 'objects');
    if (fs.existsSync(objectsDir)) {
      jobs.push(...this.collectJobs(objectsDir, 'objects'));
    }

    // 4. Cache (always — shared)
    const cacheDir = path.join(outputDir, 'cache');
    if (fs.existsSync(cacheDir)) {
      jobs.push(...this.collectJobs(cacheDir, 'cache'));
    }

    if (jobs.length === 0) {
      return { uploaded: 0, skipped: 0, failed: 0, totalBytes: 0 };
    }

    return this.executeJobs(jobs);
  }

  /**
   * Count uploadable files (for progress bar setup).
   */
  countUploadableFiles(outputDir: string, mapFilter?: Set<string> | null): number {
    let count = 0;

    // Chunks (filtered)
    const chunksDir = path.join(outputDir, 'chunks');
    if (fs.existsSync(chunksDir)) {
      if (mapFilter && mapFilter.size > 0) {
        for (const entry of fs.readdirSync(chunksDir, { withFileTypes: true })) {
          if (entry.isDirectory() && mapFilter.has(entry.name.toLowerCase())) {
            count += this.countFilesRecursive(path.join(chunksDir, entry.name));
          }
        }
      } else {
        count += this.countFilesRecursive(chunksDir);
      }
    }

    // Shared dirs (always counted)
    for (const dir of ['textures', 'objects', 'cache']) {
      const fullPath = path.join(outputDir, dir);
      if (fs.existsSync(fullPath)) {
        count += this.countFilesRecursive(fullPath);
      }
    }

    return count;
  }

  private countFilesRecursive(dir: string): number {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) count += this.countFilesRecursive(path.join(dir, entry.name));
      else if (entry.isFile()) {
        if (entry.name === 'index.json' || entry.name.endsWith('.bmp')) continue;
        count++;
      }
    }
    return count;
  }

  /**
   * Collect all files to upload from a directory, preserving relative structure.
   */
  private collectJobs(localDir: string, keyPrefix: string): UploadJob[] {
    const jobs: UploadJob[] = [];
    if (!fs.existsSync(localDir)) return jobs;

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          // Skip internal metadata and BMP originals
          if (entry.name === 'index.json') continue;
          if (entry.name.endsWith('.bmp')) continue;

          const relativePath = path.relative(localDir, fullPath).replace(/\\/g, '/');
          const key = `${keyPrefix}/${relativePath}`;

          let contentType = 'application/octet-stream';
          if (entry.name.endsWith('.webp')) contentType = 'image/webp';
          else if (entry.name.endsWith('.json')) contentType = 'application/json';
          else if (entry.name.endsWith('.png')) contentType = 'image/png';
          else if (entry.name.endsWith('.gif')) contentType = 'image/gif';

          jobs.push({ localPath: fullPath, key, contentType });
        }
      }
    };

    walk(localDir);
    return jobs;
  }

  /**
   * Execute upload jobs with concurrency control.
   */
  private async executeJobs(jobs: UploadJob[]): Promise<UploadResult> {
    const result: UploadResult = { uploaded: 0, skipped: 0, failed: 0, totalBytes: 0 };
    let completed = 0;

    const queue = [...jobs];

    const processJob = async (job: UploadJob): Promise<void> => {
      try {
        const fileSize = fs.statSync(job.localPath).size;

        // Check if object already exists with same size (idempotency)
        const exists = await this.objectExists(job.key, fileSize);
        if (exists) {
          result.skipped++;
          completed++;
          this.onProgress?.(completed, jobs.length);
          return;
        }

        const body = fs.readFileSync(job.localPath);
        await this.uploadWithRetry(job.key, body, job.contentType);

        result.uploaded++;
        result.totalBytes += fileSize;
      } catch (error: unknown) {
        result.failed++;
        console.error(`[R2] Failed to upload ${job.key}:`, error instanceof Error ? error.message : String(error));
      }

      completed++;
      this.onProgress?.(completed, jobs.length);
    };

    // Process with concurrency control
    const workers: Promise<void>[] = [];
    for (let i = 0; i < this.concurrency; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const job = queue.shift();
          if (job) await processJob(job);
        }
      })());
    }

    await Promise.all(workers);
    return result;
  }

  /**
   * Check if an object exists in R2 with matching size.
   */
  private async objectExists(key: string, expectedSize: number): Promise<boolean> {
    try {
      const response = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return response.ContentLength === expectedSize;
    } catch {
      return false;
    }
  }

  /**
   * Upload with retry (3 attempts, exponential backoff).
   */
  private async uploadWithRetry(key: string, body: Buffer, contentType: string): Promise<void> {
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.client.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }));
        return;
      } catch (error: unknown) {
        if (attempt === maxRetries - 1) throw error;
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}
