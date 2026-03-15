/**
 * CLI configuration — resolved from command-line arguments.
 */

export interface CliConfig {
  /** Maps to process (empty = all maps in cache) */
  maps: string[];

  /** Path to cache/ directory (synced assets) */
  cacheDir: string;

  /** Path for generated output (chunks, textures) */
  outputDir: string;

  /** Skip asset sync from update server */
  skipSync: boolean;

  /** Skip texture extraction and chunk generation (upload only) */
  skipGenerate: boolean;

  /** Skip upload to R2 */
  skipUpload: boolean;

  /** Number of worker threads (0 = auto) */
  workers: number;

  /** Dry run — show what would be done */
  dryRun: boolean;

  /** Cloudflare R2 credentials */
  r2: {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    bucket: string;
  };
}

export function createDefaultConfig(): CliConfig {
  return {
    maps: [],
    cacheDir: './cache',
    outputDir: './webclient-cache',
    skipSync: false,
    skipGenerate: false,
    skipUpload: false,
    workers: 0,
    dryRun: false,
    r2: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      endpoint: process.env.R2_ENDPOINT || '',
      bucket: process.env.R2_BUCKET || '',
    },
  };
}
