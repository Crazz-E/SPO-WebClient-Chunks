/**
 * R2 Uploader — uploads generated chunks to Cloudflare R2 (S3-compatible).
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
   * Upload all chunk files from outputDir to R2.
   * Structure: chunks/{mapName}/{terrainType}/{season}/z{zoom}/chunk_{i}_{j}.webp
   */
  async uploadChunks(chunksDir: string): Promise<UploadResult> {
    const jobs = this.collectJobs(chunksDir, 'chunks');
    return this.executeJobs(jobs);
  }

  /**
   * Collect all files to upload from a directory, preserving relative structure.
   */
  private collectJobs(localDir: string, keyPrefix: string): UploadJob[] {
    const jobs: UploadJob[] = [];
    if (!fs.existsSync(localDir)) return jobs;

    const walk = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const relativePath = path.relative(localDir, fullPath).replace(/\\/g, '/');
          const key = `${keyPrefix}/${relativePath}`;

          let contentType = 'application/octet-stream';
          if (entry.name.endsWith('.webp')) contentType = 'image/webp';
          else if (entry.name.endsWith('.json')) contentType = 'application/json';
          else if (entry.name.endsWith('.png')) contentType = 'image/png';

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

    const semaphore = { running: 0 };
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
