# SPO-WebClient-Chunks

Standalone terrain chunk generator for **Starpeace Online**. Generates isometric map chunks from game assets and uploads them to Cloudflare R2 CDN.

## Architecture

```
SPO-WebClient-Chunks (this tool)               SPO-WebClient (game client)
┌─────────────────────────────┐                ┌──────────────────────────┐
│ 1. Sync assets from server  │                │                          │
│ 2. Extract textures + atlas │  ──uploads──>  │ Client fetches chunks    │
│ 3. Generate terrain chunks  │  Cloudflare R2 │ from CDN URL instead of  │
│ 4. Upload to R2 CDN         │                │ local server             │
└─────────────────────────────┘                └──────────────────────────┘
```

**Designed for Linux** — uses Sharp (native image processing, 5-10x faster than WASM).

## Quick Start

```bash
# Clone and install (in WSL or Linux)
git clone https://github.com/Crazz-E/SPO-WebClient-Chunks.git
cd SPO-WebClient-Chunks
npm install
npm run build

# Generate chunks for one map (no upload)
node dist/cli.js --map Shamba --skip-upload \
  --cache-dir /path/to/SPO-WebClient/cache

# Generate all maps and upload to R2
node dist/cli.js \
  --cache-dir /path/to/SPO-WebClient/cache \
  --r2-access-key YOUR_KEY \
  --r2-secret-key YOUR_SECRET \
  --r2-endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com \
  --r2-bucket spo-chunks
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--map <name...>` | Maps to generate (repeatable) | All maps |
| `--cache-dir <path>` | Path to cache/ directory | `./cache` |
| `--output-dir <path>` | Output directory | `./webclient-cache` |
| `--skip-sync` | Skip asset sync from update server | false |
| `--skip-upload` | Generate only, no R2 upload | false |
| `--workers <n>` | Worker threads (0 = auto) | 0 |
| `--dry-run` | Preview without executing | false |
| `--r2-access-key` | R2 access key ID | `$R2_ACCESS_KEY_ID` |
| `--r2-secret-key` | R2 secret access key | `$R2_SECRET_ACCESS_KEY` |
| `--r2-endpoint` | R2 endpoint URL | `$R2_ENDPOINT` |
| `--r2-bucket` | R2 bucket name | `$R2_BUCKET` |

## Pipeline

1. **Sync** — Downloads game assets from `update.starpeaceonline.com` (CAB archives)
2. **Extract** — Extracts textures from CABs, bakes alpha transparency, builds 1024x1536 atlases
3. **Generate** — Renders 32x32-tile isometric chunks at 4 zoom levels (Z0-Z3) using worker pool
4. **Upload** — Pushes WebP chunks to Cloudflare R2 with 1-year cache headers

### Output Structure

```
webclient-cache/chunks/
  {mapName}/
    {terrainType}/
      {season}/          (0=Winter, 1=Spring, 2=Summer, 3=Autumn)
        z0/chunk_{i}_{j}.webp   (260×130px)
        z1/chunk_{i}_{j}.webp   (520×260px)
        z2/chunk_{i}_{j}.webp   (1040×520px)
        z3/chunk_{i}_{j}.webp   (2080×1040px)
        manifest.json
```

## Cloudflare R2 + DNS Setup

### 1. Create R2 Bucket

1. Cloudflare Dashboard → R2 Object Storage → **Create bucket**
2. Name: `spo-chunks`
3. Location: Auto

### 2. Create API Token

1. R2 → **Manage R2 API Tokens** → Create API token
2. Permissions: **Object Read & Write**
3. Scope: `spo-chunks` bucket only
4. Save the Access Key ID and Secret Access Key

### 3. Custom Domain (spo.zz.works)

#### Option A: Add zz.works to Cloudflare DNS (Recommended)

This gives you `spo.zz.works` with automatic SSL and edge caching:

1. **Add `zz.works` as a site** in Cloudflare Dashboard (Free plan)
2. **Update nameservers** at your registrar to Cloudflare's assigned nameservers
3. **Re-create existing DNS records** (A, CNAME, MX, etc.) in Cloudflare
4. **R2 custom domain**: R2 → `spo-chunks` → Settings → Custom Domains → Add `spo.zz.works`
5. Cloudflare auto-creates the CNAME and SSL certificate

> Your existing site's DNS records will work identically — you're just changing who manages the nameservers. Set non-SPO records to "DNS only" (gray cloud) if you don't want Cloudflare proxying them.

#### Option B: Use R2 Public URL Directly

If you can't move DNS:

1. R2 → `spo-chunks` → Settings → **Public access** → Enable
2. Use the provided URL: `https://pub-{hash}.r2.dev`
3. Set `CHUNK_CDN_URL=https://pub-{hash}.r2.dev` in SPO-WebClient

### 4. CORS Configuration

R2 → `spo-chunks` → Settings → CORS:

```json
[
  {
    "AllowedOrigins": ["https://your-webclient-domain.com", "http://localhost:8080"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]
```

### 5. SPO-WebClient Configuration

Set the environment variable before starting the game server:

```bash
CHUNK_CDN_URL=https://spo.zz.works node dist/server/server.js
```

The client automatically fetches chunks from the CDN URL when configured.

## Development

```bash
npm run build    # Compile TypeScript
npm run clean    # Remove dist/
npm start        # Run CLI (after build)
```

### Project Structure

```
src/
├── cli.ts                 # Entry point + orchestration
├── config.ts              # CLI config resolution
├── progress.ts            # Animated progress bars
├── pipeline/
│   ├── sync-service.ts    # Asset sync from update server
│   ├── texture-extractor.ts  # CAB → texture → atlas
│   ├── map-data-service.ts   # Map INI/BMP loading
│   ├── chunk-renderer.ts     # RGBA chunk generation + worker pool
│   └── chunk-worker.ts       # Worker thread kernel
├── codecs/
│   ├── texture-alpha-baker.ts  # BMP/PNG/WebP codecs (Sharp)
│   ├── atlas-generator.ts     # Texture atlas packing
│   └── cab-extractor.ts       # CAB archive extraction
├── upload/
│   └── r2-uploader.ts    # Cloudflare R2 upload (S3-compatible)
└── shared/
    ├── types.ts           # Season, MapMetadata
    ├── constants.ts       # Chunk size, zoom levels
    ├── land-utils.ts      # Terrain tile decoding
    └── error-utils.ts     # Safe error handling
```

## License

MIT
