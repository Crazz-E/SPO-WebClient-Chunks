# SPO-WebClient-Chunks

Standalone asset pipeline for **Starpeace Online**. Syncs game assets, generates isometric terrain chunks, texture atlases, and object sprites, then uploads everything to Cloudflare R2 CDN.

## Architecture

```
SPO-WebClient-Chunks (this tool, runs on Linux/WSL)
┌──────────────────────────────────────┐
│ 1. Sync assets from update server    │
│ 2. Extract textures + build atlases  │     Cloudflare R2
│ 3. Bake object textures (alpha)      │ ──── uploads ────> spo.zz.works (CDN)
│ 4. Generate terrain chunks (WebP)    │
│ 5. Generate terrain previews         │
│ 6. Upload all static assets to R2    │
└──────────────────────────────────────┘

SPO-WebClient (game client)
┌──────────────────────────────────────┐
│ Fetches all static assets from CDN   │ <── https://spo.zz.works/...
│ No local generation needed           │
└──────────────────────────────────────┘
```

**Designed for Linux** — uses Sharp (native image processing, 5-10x faster than WASM on Linux).

## Quick Start

```bash
# Clone and install (in WSL or native Linux)
git clone https://github.com/Crazz-E/SPO-WebClient-Chunks.git
cd SPO-WebClient-Chunks
npm install
npm run build

# Full pipeline: sync + generate + upload (Shamba & Zorcon maps)
node dist/cli.js \
  --map Shamba Zorcon \
  --r2-access-key YOUR_KEY \
  --r2-secret-key YOUR_SECRET \
  --r2-endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com \
  --r2-bucket spo-chunks

# Generate only, no upload
node dist/cli.js --map Shamba --skip-upload

# Upload only (assets already generated)
node dist/cli.js \
  --map Shamba Zorcon \
  --skip-generate \
  --r2-access-key YOUR_KEY \
  --r2-secret-key YOUR_SECRET \
  --r2-endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com \
  --r2-bucket spo-chunks
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--map <name...>` | Maps to process (space-separated) | All maps in cache |
| `--cache-dir <path>` | Path to cache/ directory (synced assets) | `./cache` |
| `--output-dir <path>` | Output directory for generated assets | `./webclient-cache` |
| `--skip-sync` | Skip asset sync from update server | false |
| `--skip-generate` | Skip generation, upload only | false |
| `--skip-upload` | Generate only, no R2 upload | false |
| `--workers <n>` | Worker threads (0 = auto) | 0 (auto) |
| `--dry-run` | Preview without executing | false |
| `--r2-access-key` | R2 access key ID | `$R2_ACCESS_KEY_ID` |
| `--r2-secret-key` | R2 secret access key | `$R2_SECRET_ACCESS_KEY` |
| `--r2-endpoint` | R2 endpoint URL | `$R2_ENDPOINT` |
| `--r2-bucket` | R2 bucket name | `$R2_BUCKET` |

## Pipeline

| Step | Description | Skippable |
|------|-------------|-----------|
| **1. Sync** | Downloads game assets from `update.starpeaceonline.com` (CAB archives) | `--skip-sync` |
| **2. Extract** | Extracts textures from CABs, bakes alpha transparency, builds terrain + object atlases | `--skip-generate` |
| **3. Copy** | Copies baked object textures (roads, concrete, cars) to output directory | `--skip-generate` |
| **4. Generate** | Renders 32×32-tile isometric chunks at 4 zoom levels using worker thread pool | `--skip-generate` |
| **5. Preview** | Composites all Z0 chunks into low-res map backdrop PNGs | `--skip-generate` |
| **6. Upload** | Pushes all assets to Cloudflare R2 with 1-year immutable cache headers | `--skip-upload` |

### R2 Key Structure (CDN paths)

```
spo-chunks/                                  (R2 bucket → spo.zz.works)
├── chunks/
│   └── {map}/{terrain}/{season}/
│       ├── z0/chunk_{i}_{j}.webp            Zoom level 0 (260×132px)
│       ├── z1/chunk_{i}_{j}.webp            Zoom level 1 (520×264px)
│       ├── z2/chunk_{i}_{j}.webp            Zoom level 2 (1040×528px)
│       ├── z3/chunk_{i}_{j}.webp            Zoom level 3 (2080×1056px)
│       └── preview.png                      Low-res map backdrop
├── textures/
│   └── {terrain}/{season}/
│       ├── atlas.png                        Terrain sprite sheet (1024×1536)
│       ├── atlas.json                       Atlas manifest (tile → rect)
│       └── {paletteIndex}.png               Individual textures (fallback)
├── objects/
│   ├── road-atlas.png                       Road sprite sheet
│   ├── road-atlas.json                      Road atlas manifest
│   ├── concrete-atlas.png                   Concrete sprite sheet
│   ├── concrete-atlas.json                  Concrete atlas manifest
│   ├── car-atlas.png                        Car sprite sheet
│   └── car-atlas.json                       Car atlas manifest
└── cache/
    ├── RoadBlockImages/{name}.png           Baked road textures
    ├── ConcreteImages/{name}.png            Baked concrete textures
    └── CarImages/{name}.png                 Baked car textures
```

## Cloudflare R2 + CDN Setup

### 1. Move DNS to Cloudflare

R2 custom domains **require** Cloudflare-managed DNS.

1. Cloudflare Dashboard → **Add a site** → enter your domain → select **Free** plan
2. Update nameservers at your registrar to Cloudflare's assigned pair
3. Re-create existing DNS records in Cloudflare (A, CNAME, MX, etc.)
4. Set non-proxied records to **DNS only** (gray cloud)

### 2. Create R2 Bucket

1. Cloudflare Dashboard → **R2 Object Storage** → **Create bucket**
2. Bucket name: `spo-chunks`
3. Location: Automatic

### 3. Connect Custom Domain

1. R2 → `spo-chunks` → **Settings** → **Custom Domains** → **Connect Domain**
2. Enter: `spo.zz.works`
3. Cloudflare auto-creates CNAME + SSL certificate
4. Wait for status: **Active**

### 4. Create R2 API Token

1. R2 Overview → **Manage R2 API Tokens** → **Create Account API token**
2. Token name: `spo-chunks-upload`
3. Permissions: **Object Read & Write**
4. Bucket scope: **Apply to specific buckets only** → `spo-chunks`
5. Save the **Access Key ID** and **Secret Access Key**

### 5. Add Cache Rule

R2 custom domains need an explicit cache rule for edge caching:

1. Cloudflare Dashboard → select `zz.works` → **Caching** → **Cache Rules**
2. **Create rule**: name `Cache R2 assets`
3. **When**: Hostname equals `spo.zz.works`
4. **Then**: Eligible for cache, Edge TTL override = 1 year
5. **Deploy**

### 6. CORS Configuration

R2 → `spo-chunks` → **Settings** → **CORS Policy**:

```json
[
  {
    "AllowedOrigins": ["https://your-domain.com", "http://localhost:8080"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]
```

### 7. SPO-WebClient Configuration

```bash
CHUNK_CDN_URL=https://spo.zz.works npm run dev
```

## Development

```bash
npm run build    # Compile TypeScript
npm run clean    # Remove dist/
npm start        # Run CLI (after build)
```

### Project Structure

```
src/
├── cli.ts                    Entry point + pipeline orchestration
├── config.ts                 CLI config resolution
├── progress.ts               Animated multi-bar progress (chalk + cli-progress)
├── pipeline/
│   ├── sync-service.ts       Asset sync from update.starpeaceonline.com
│   ├── texture-extractor.ts  CAB extraction → alpha bake → atlas generation
│   ├── map-data-service.ts   Map INI/BMP parsing
│   ├── chunk-renderer.ts     RGBA chunk compositing + worker pool + preview
│   └── chunk-worker.ts       Worker thread rendering kernel
├── codecs/
│   ├── texture-alpha-baker.ts  BMP/PNG/WebP codec wrappers (Sharp)
│   ├── atlas-generator.ts     Texture atlas bin-packing
│   └── cab-extractor.ts       CAB archive extraction (7zip-min)
├── upload/
│   └── r2-uploader.ts        Cloudflare R2 upload (S3 SDK, 20 concurrent, retry)
└── shared/
    ├── types.ts               Season enum, MapMetadata, MapTownInfo
    ├── constants.ts           CHUNK_SIZE, zoom dimensions, UPDATE_SERVER
    ├── land-utils.ts          LandId bit decoding (class/type/var)
    └── error-utils.ts         Safe unknown error handling
```

## License

MIT
