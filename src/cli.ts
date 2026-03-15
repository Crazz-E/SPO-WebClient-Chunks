#!/usr/bin/env node
/**
 * SPO Chunk Generator CLI
 *
 * Standalone tool to generate isometric terrain chunks and upload to Cloudflare R2.
 *
 * Usage:
 *   npx spo-chunks --map Shamba --skip-upload
 *   npx spo-chunks --r2-access-key KEY --r2-secret-key SECRET --r2-endpoint URL --r2-bucket BUCKET
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { CliConfig, createDefaultConfig } from './config';
import { ProgressManager } from './progress';
import { SyncService } from './pipeline/sync-service';
import { TextureExtractor } from './pipeline/texture-extractor';
import { MapDataService } from './pipeline/map-data-service';
import { ChunkRenderer } from './pipeline/chunk-renderer';
import { R2Uploader } from './upload/r2-uploader';

const VERSION = '1.0.0';

function parseArgs(): CliConfig {
  const config = createDefaultConfig();

  const program = new Command()
    .name('spo-chunks')
    .description('Generate isometric terrain chunks for Starpeace Online and upload to Cloudflare R2')
    .version(VERSION)
    .option('--map <name...>', 'Map(s) to generate (default: all maps in cache)')
    .option('--cache-dir <path>', 'Path to cache/ directory', './cache')
    .option('--output-dir <path>', 'Output directory for chunks', './webclient-cache')
    .option('--skip-sync', 'Skip downloading from update server')
    .option('--skip-upload', 'Generate only, do not upload to R2')
    .option('--workers <n>', 'Worker thread count (0 = auto)', '0')
    .option('--dry-run', 'Show what would be done without doing it')
    .option('--r2-access-key <key>', 'Cloudflare R2 access key ID')
    .option('--r2-secret-key <secret>', 'Cloudflare R2 secret access key')
    .option('--r2-endpoint <url>', 'R2 S3-compatible endpoint URL')
    .option('--r2-bucket <name>', 'R2 bucket name')
    .parse(process.argv);

  const opts = program.opts();

  config.maps = opts.map || [];
  config.cacheDir = path.resolve(opts.cacheDir);
  config.outputDir = path.resolve(opts.outputDir);
  config.skipSync = !!opts.skipSync;
  config.skipUpload = !!opts.skipUpload;
  config.workers = parseInt(opts.workers, 10) || 0;
  config.dryRun = !!opts.dryRun;

  if (opts.r2AccessKey) config.r2.accessKeyId = opts.r2AccessKey;
  if (opts.r2SecretKey) config.r2.secretAccessKey = opts.r2SecretKey;
  if (opts.r2Endpoint) config.r2.endpoint = opts.r2Endpoint;
  if (opts.r2Bucket) config.r2.bucket = opts.r2Bucket;

  return config;
}

function discoverMaps(cacheDir: string): string[] {
  const mapsDir = path.join(cacheDir, 'Maps');
  if (!fs.existsSync(mapsDir)) return [];

  return fs.readdirSync(mapsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => {
      // Only include maps that have either a BMP or an images.cab
      const mapDir = path.join(mapsDir, name);
      const hasBmp = fs.existsSync(path.join(mapDir, `${name}.bmp`));
      const hasCab = fs.existsSync(path.join(mapDir, 'images.cab'));
      return hasBmp || hasCab;
    })
    .sort();
}

async function main(): Promise<void> {
  const config = parseArgs();
  const startTime = Date.now();

  // Determine maps to process
  const hasR2 = config.r2.accessKeyId && config.r2.secretAccessKey && config.r2.endpoint && config.r2.bucket;
  const skipUpload = config.skipUpload || !hasR2;

  const steps = (config.skipSync ? 0 : 1) + 1 + 1 + (skipUpload ? 0 : 1);
  let currentStep = 0;

  // =========================================================================
  // Step 1: Sync assets from update server
  // =========================================================================
  if (!config.skipSync) {
    currentStep++;
    ProgressManager.header(`[${currentStep}/${steps}] Syncing assets from update server...`);

    if (config.dryRun) {
      console.log(chalk.yellow('  (dry run) Would sync from update.starpeaceonline.com'));
    } else {
      const syncService = new SyncService(config.cacheDir);
      await syncService.initialize();
      const stats = syncService.getStats();
      console.log(chalk.green(`  Done: ${stats.downloaded} downloaded, ${stats.extracted} extracted, ${stats.skipped} up-to-date`));
    }
  }

  // =========================================================================
  // Step 2: Extract textures + build atlases
  // =========================================================================
  currentStep++;
  ProgressManager.header(`[${currentStep}/${steps}] Extracting textures and building atlases...`);

  if (config.dryRun) {
    console.log(chalk.yellow('  (dry run) Would extract textures from CABs and build atlases'));
  } else {
    const textureExtractor = new TextureExtractor(config.cacheDir, config.outputDir);
    await textureExtractor.initialize();
  }

  // =========================================================================
  // Discover maps
  // =========================================================================
  let maps = config.maps.length > 0 ? config.maps : discoverMaps(config.cacheDir);
  if (maps.length === 0) {
    console.error(chalk.red('No maps found in cache directory. Run without --skip-sync first.'));
    process.exit(1);
  }

  // Extract CABs for all target maps
  const mapDataService = new MapDataService(config.cacheDir);
  for (const mapName of maps) {
    try {
      await mapDataService.extractCabFile(mapName);
    } catch (error: unknown) {
      console.warn(chalk.yellow(`  Warning: Could not extract map ${mapName}: ${error instanceof Error ? error.message : String(error)}`));
      maps = maps.filter(m => m !== mapName);
    }
  }

  // Get metadata to show terrain types
  const mapTerrainTypes = new Map<string, string>();
  for (const mapName of maps) {
    try {
      const metadata = await mapDataService.getMapMetadata(mapName);
      mapTerrainTypes.set(mapName, metadata.terrainType);
    } catch {
      mapTerrainTypes.set(mapName, 'Earth');
    }
  }

  // Show banner
  const terrainTypes = [...new Set(mapTerrainTypes.values())];
  ProgressManager.banner(VERSION, {
    'Maps': maps.join(', ') || 'all',
    'Terrain types': terrainTypes.join(', '),
    'Seasons': '4 (Winter, Spring, Summer, Autumn)',
    'Zoom levels': '4 (Z0-Z3)',
    'Upload': skipUpload ? 'disabled' : `R2 → ${config.r2.bucket}`,
  });

  // =========================================================================
  // Step 3: Generate chunks
  // =========================================================================
  currentStep++;
  ProgressManager.header(`[${currentStep}/${steps}] Generating terrain chunks...`);

  if (config.dryRun) {
    for (const mapName of maps) {
      const terrain = mapTerrainTypes.get(mapName) || 'Earth';
      console.log(chalk.yellow(`  (dry run) Would generate chunks for ${mapName} (${terrain})`));
    }
  } else {
    const progress = new ProgressManager();
    let totalChunksGenerated = 0;

    const renderer = new ChunkRenderer({
      cacheDir: config.outputDir,
      mapCacheDir: config.cacheDir,
      textureDir: path.join(config.outputDir, 'textures'),
      outputDir: config.outputDir,
      onProgress: (mapName, season, done, total) => {
        const barId = `${mapName}-${season}`;
        progress.update(barId, done);
        if (done === total) totalChunksGenerated += total;
      },
    });

    await renderer.initializeAtlases();

    // Create progress bars for each map/season combo
    for (const mapName of maps) {
      try {
        const metadata = await mapDataService.getMapMetadata(mapName);
        const chunksI = Math.ceil(metadata.width / 32);
        const chunksJ = Math.ceil(metadata.height / 32);
        const chunksPerSeason = chunksI * chunksJ;

        // We generate 4 zoom levels per chunk, but the renderer handles all zooms per chunk call
        for (let season = 0; season < 4; season++) {
          const barId = `${mapName}-${season}`;
          const seasonNames = ['Winter', 'Spring', 'Summer', 'Autumn'];
          progress.createBar(barId, `${mapName}/${seasonNames[season]}`, chunksPerSeason, 'chunks');
        }
      } catch {
        // Will fail during rendering
      }
    }

    await renderer.preGenerateAllChunks(maps.length > 0 ? maps : undefined);
    progress.stop();

    console.log(chalk.green(`  Done: ${totalChunksGenerated} chunks generated`));
  }

  // =========================================================================
  // Step 4: Upload to R2
  // =========================================================================
  if (!skipUpload) {
    currentStep++;
    ProgressManager.header(`[${currentStep}/${steps}] Uploading to Cloudflare R2...`);

    if (config.dryRun) {
      console.log(chalk.yellow(`  (dry run) Would upload chunks to R2 bucket: ${config.r2.bucket}`));
    } else {
      const chunksDir = path.join(config.outputDir, 'chunks');
      if (!fs.existsSync(chunksDir)) {
        console.error(chalk.red('  No chunks directory found. Nothing to upload.'));
      } else {
        const uploader = new R2Uploader(config.r2);
        const progress = new ProgressManager();

        // Count files to upload
        let fileCount = 0;
        const countFiles = (dir: string): void => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) countFiles(path.join(dir, entry.name));
            else fileCount++;
          }
        };
        countFiles(chunksDir);

        progress.createBar('upload', 'Uploading to R2', fileCount, 'files');
        uploader.onProgress = (done, total) => {
          progress.update('upload', done);
        };

        const result = await uploader.uploadChunks(chunksDir);
        progress.stop();

        const sizeMB = (result.totalBytes / (1024 * 1024)).toFixed(1);
        console.log(chalk.green(`  Done: ${result.uploaded} uploaded, ${result.skipped} skipped, ${result.failed} failed (${sizeMB} MB)`));
      }
    }
  }

  // =========================================================================
  // Final report
  // =========================================================================
  const elapsed = Date.now() - startTime;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);

  ProgressManager.report([
    chalk.bold.green('COMPLETE'),
    '',
    `Maps processed:    ${maps.length}`,
    `Elapsed:           ${minutes}m ${seconds}s`,
    ...(skipUpload ? [] : [`Upload target:     ${config.r2.bucket}`]),
  ]);
}

main().catch((err: unknown) => {
  console.error(chalk.red('Fatal error:'), err instanceof Error ? err.message : String(err));
  process.exit(1);
});
