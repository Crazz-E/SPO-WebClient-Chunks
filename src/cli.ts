#!/usr/bin/env node
/**
 * SPO Chunk Generator CLI
 *
 * Standalone tool to generate all static terrain assets and upload to Cloudflare R2.
 *
 * Pipeline:
 *   1. Sync cache from update.starpeaceonline.com
 *   2. Extract textures, build terrain + object atlases
 *   3. Copy baked object textures to output directory
 *   4. Generate terrain chunks (all maps × seasons × zoom levels)
 *   5. Generate terrain previews (low-res map backdrops)
 *   6. Upload everything to Cloudflare R2
 *
 * Usage:
 *   npx spo-chunks --map Shamba Zorcon --skip-upload
 *   npx spo-chunks --map Shamba --r2-access-key KEY --r2-secret-key SECRET --r2-endpoint URL --r2-bucket BUCKET
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
    .description('Generate all static terrain assets for Starpeace Online and upload to Cloudflare R2')
    .version(VERSION)
    .option('--map <name...>', 'Map(s) to process (default: all maps in cache)')
    .option('--cache-dir <path>', 'Path to cache/ directory', './cache')
    .option('--output-dir <path>', 'Output directory for generated assets', './webclient-cache')
    .option('--skip-sync', 'Skip downloading from update server')
    .option('--skip-generate', 'Skip texture extraction and chunk generation (upload only)')
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
  config.skipGenerate = !!opts.skipGenerate;
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
      const mapDir = path.join(mapsDir, name);
      return fs.existsSync(path.join(mapDir, `${name}.bmp`)) ||
             fs.existsSync(path.join(mapDir, 'images.cab'));
    })
    .sort();
}

/**
 * Discover maps from the output chunks directory (for upload-only mode).
 */
function discoverMapsFromOutput(outputDir: string): string[] {
  const chunksDir = path.join(outputDir, 'chunks');
  if (!fs.existsSync(chunksDir)) return [];

  return fs.readdirSync(chunksDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

/**
 * Copy baked object textures (PNG/GIF) from cache/ source dirs into
 * webclient-cache/cache/ for R2 upload. Skips BMP originals.
 */
function copyBakedObjectTextures(cacheDir: string, outputDir: string): { copied: number; skipped: number } {
  const categories = ['RoadBlockImages', 'ConcreteImages', 'CarImages'];
  let copied = 0;
  let skipped = 0;

  for (const cat of categories) {
    const srcDir = path.join(cacheDir, cat);
    const dstDir = path.join(outputDir, 'cache', cat);

    if (!fs.existsSync(srcDir)) continue;
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
    }

    for (const file of fs.readdirSync(srcDir)) {
      const ext = path.extname(file).toLowerCase();
      if (ext !== '.png' && ext !== '.gif') continue;

      const srcPath = path.join(srcDir, file);
      const dstPath = path.join(dstDir, file);

      if (fs.existsSync(dstPath) && fs.statSync(srcPath).size === fs.statSync(dstPath).size) {
        skipped++;
        continue;
      }

      fs.copyFileSync(srcPath, dstPath);
      copied++;
    }
  }

  return { copied, skipped };
}

async function main(): Promise<void> {
  const config = parseArgs();
  const startTime = Date.now();

  const hasR2 = config.r2.accessKeyId && config.r2.secretAccessKey && config.r2.endpoint && config.r2.bucket;
  const skipUpload = config.skipUpload || !hasR2;
  const doSync = !config.skipSync && !config.skipGenerate;
  const doGenerate = !config.skipGenerate;
  const doUpload = !skipUpload;

  // Count active steps
  const stepCount =
    (doSync ? 1 : 0) +
    (doGenerate ? 4 : 0) +
    (doUpload ? 1 : 0);

  let currentStep = 0;
  const step = (label: string): void => {
    currentStep++;
    ProgressManager.header(`[${currentStep}/${stepCount}] ${label}`);
  };

  // =========================================================================
  // Step: Sync assets from update server
  // =========================================================================
  if (doSync) {
    step('Syncing assets from update server...');

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
  // Step: Extract textures + build atlases
  // =========================================================================
  if (doGenerate) {
    step('Extracting textures and building atlases...');

    if (config.dryRun) {
      console.log(chalk.yellow('  (dry run) Would extract textures from CABs and build atlases'));
    } else {
      const textureExtractor = new TextureExtractor(config.cacheDir, path.join(config.outputDir, 'textures'));
      await textureExtractor.initialize();
    }
  }

  // =========================================================================
  // Step: Copy baked object textures
  // =========================================================================
  if (doGenerate) {
    step('Copying baked object textures...');

    if (config.dryRun) {
      console.log(chalk.yellow('  (dry run) Would copy baked PNGs from cache/ to output/cache/'));
    } else {
      const { copied, skipped } = copyBakedObjectTextures(config.cacheDir, config.outputDir);
      console.log(chalk.green(`  Done: ${copied} copied, ${skipped} up-to-date`));
    }
  }

  // =========================================================================
  // Discover maps
  // =========================================================================
  let maps: string[];
  if (config.maps.length > 0) {
    maps = config.maps;
  } else if (doGenerate) {
    maps = discoverMaps(config.cacheDir);
  } else {
    maps = discoverMapsFromOutput(config.outputDir);
  }

  if (maps.length === 0) {
    console.error(chalk.red('No maps found. Specify --map or ensure cache/output directory has map data.'));
    process.exit(1);
  }

  // Get terrain types
  const mapTerrainTypes = new Map<string, string>();
  if (doGenerate) {
    const mapDataService = new MapDataService(config.cacheDir);
    for (const mapName of maps) {
      try {
        await mapDataService.extractCabFile(mapName);
        const metadata = await mapDataService.getMapMetadata(mapName);
        mapTerrainTypes.set(mapName, metadata.terrainType);
      } catch {
        mapTerrainTypes.set(mapName, 'Earth');
      }
    }
  } else {
    // Discover terrain types from chunk directory structure
    for (const mapName of maps) {
      const mapChunkDir = path.join(config.outputDir, 'chunks', mapName);
      if (fs.existsSync(mapChunkDir)) {
        const terrainDirs = fs.readdirSync(mapChunkDir, { withFileTypes: true })
          .filter(d => d.isDirectory()).map(d => d.name);
        mapTerrainTypes.set(mapName, terrainDirs[0] || 'Earth');
      } else {
        mapTerrainTypes.set(mapName, 'Earth');
      }
    }
  }

  const terrainTypes = [...new Set(mapTerrainTypes.values())];

  // Show banner
  ProgressManager.banner(VERSION, {
    'Maps': maps.join(', '),
    'Terrain types': terrainTypes.join(', '),
    'Seasons': '4 (Winter, Spring, Summer, Autumn)',
    'Zoom levels': '4 (Z0-Z3)',
    'Upload': skipUpload ? 'disabled' : `R2 → ${config.r2.bucket}`,
  });

  // =========================================================================
  // Step: Generate chunks
  // =========================================================================
  if (doGenerate) {
    step('Generating terrain chunks...');

    if (config.dryRun) {
      for (const mapName of maps) {
        console.log(chalk.yellow(`  (dry run) Would generate chunks for ${mapName} (${mapTerrainTypes.get(mapName)})`));
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
          progress.update(`${mapName}-${season}`, done);
          if (done === total) totalChunksGenerated += total;
        },
      });

      await renderer.initializeAtlases();

      // Create progress bars
      const mapDataService = new MapDataService(config.cacheDir);
      for (const mapName of maps) {
        try {
          const metadata = await mapDataService.getMapMetadata(mapName);
          const chunksPerSeason = Math.ceil(metadata.width / 32) * Math.ceil(metadata.height / 32);
          const seasonNames = ['Winter', 'Spring', 'Summer', 'Autumn'];
          for (let season = 0; season < 4; season++) {
            progress.createBar(`${mapName}-${season}`, `${mapName}/${seasonNames[season]}`, chunksPerSeason, 'chunks');
          }
        } catch { /* Will fail during rendering */ }
      }

      await renderer.preGenerateAllChunks(maps);
      progress.stop();
      console.log(chalk.green(`  Done: ${totalChunksGenerated} chunks generated`));

      // Generate previews
      step('Generating terrain previews...');
      let previewsGenerated = 0;
      let previewsCached = 0;

      for (const mapName of maps) {
        const terrainType = mapTerrainTypes.get(mapName) || 'Earth';
        for (let season = 0; season < 4; season++) {
          if (!renderer.hasAtlas(terrainType, season)) continue;
          const previewPath = renderer.getPreviewCachePath(mapName, terrainType, season);
          if (fs.existsSync(previewPath)) {
            previewsCached++;
            continue;
          }
          const preview = await renderer.getTerrainPreview(mapName, terrainType, season);
          if (preview) previewsGenerated++;
        }
      }
      console.log(chalk.green(`  Done: ${previewsGenerated} generated, ${previewsCached} cached`));
    }
  }

  // =========================================================================
  // Step: Upload to Cloudflare R2
  // =========================================================================
  if (doUpload) {
    step('Uploading all assets to Cloudflare R2...');

    if (config.dryRun) {
      console.log(chalk.yellow(`  (dry run) Would upload assets to R2 bucket: ${config.r2.bucket}`));
    } else {
      const uploader = new R2Uploader(config.r2);
      const mapFilter = maps.length > 0 ? new Set(maps.map(m => m.toLowerCase())) : null;
      const fileCount = uploader.countUploadableFiles(config.outputDir, mapFilter);

      if (fileCount === 0) {
        console.error(chalk.red('  No files found to upload.'));
      } else {
        console.log(chalk.gray(`  ${fileCount} files to process (upload new + skip existing)`));

        const progress = new ProgressManager();
        progress.createBar('upload', 'Uploading to R2', fileCount, 'files');

        uploader.onProgress = (done) => {
          progress.update('upload', done);
        };

        const result = await uploader.uploadAll(config.outputDir, mapFilter);
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
    `Maps:              ${maps.join(', ')}`,
    `Terrain types:     ${terrainTypes.join(', ')}`,
    `Elapsed:           ${minutes}m ${seconds}s`,
    ...(skipUpload ? [] : [`Upload target:     ${config.r2.bucket}`]),
  ]);
}

main().catch((err: unknown) => {
  console.error(chalk.red('Fatal error:'), err instanceof Error ? err.message : String(err));
  process.exit(1);
});
