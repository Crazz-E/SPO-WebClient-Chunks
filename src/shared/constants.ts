/**
 * Constants shared across the chunk generation pipeline.
 */

/** Tiles per chunk dimension */
export const CHUNK_SIZE = 32;

/** Maximum zoom level (base resolution) */
export const MAX_ZOOM = 3;

/** Zoom level 3 configuration (base resolution) */
export const ZOOM3_U = 32;
export const ZOOM3_TILE_WIDTH = 64;
export const ZOOM3_TILE_HEIGHT = 32;
export const ZOOM3_HALF_WIDTH = ZOOM3_TILE_WIDTH / 2; // 32

/** Chunk canvas dimensions at zoom level 3 */
export const CHUNK_CANVAS_WIDTH = ZOOM3_U * (2 * CHUNK_SIZE - 1) + ZOOM3_TILE_WIDTH;   // 2080
export const CHUNK_CANVAS_HEIGHT = ZOOM3_U * CHUNK_SIZE + ZOOM3_TILE_HEIGHT;            // 1056

/** Vegetation flattening mask (strips LandType + LandVar, keeps LandClass) */
export const FLAT_MASK = 0xC0;

/** Update server base URL */
export const UPDATE_SERVER = 'http://update.starpeaceonline.com/five/client/cache/';

/** Cache directory names */
export const CACHE_DIRS = {
  maps: 'Maps',
  landClasses: 'LandClasses',
  landImages: 'landimages',
  textures: 'textures',
  chunks: 'chunks',
  objects: 'objects',
} as const;
