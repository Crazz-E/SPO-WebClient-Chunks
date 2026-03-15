/**
 * Land Utilities - Decoding and querying landId values from BMP map files
 *
 * LandId Encoding Structure (8-bit byte):
 * Bit:  7   6   5   4   3   2   1   0
 *       └───┴───┘   └───┴───┴───┴───┘   └───┴───┘
 *       LandClass   LandType            LandVar
 *       (2 bits)    (4 bits)            (2 bits)
 *
 * Converted from Delphi source: Land.pas, LocalCacheManager.pas
 */

/** Bit mask for LandClass (bits 7-6) */
export const LND_CLASS_MASK = 0xC0;

/** Bit mask for LandType (bits 5-2) */
export const LND_TYPE_MASK = 0x3C;

/** Bit mask for LandVar (bits 1-0) */
export const LND_VAR_MASK = 0x03;

/** Bit shift for LandClass */
export const LND_CLASS_SHIFT = 6;

/** Bit shift for LandType */
export const LND_TYPE_SHIFT = 2;

export enum LandClass {
  ZoneA = 0,
  ZoneB = 1,
  ZoneC = 2,
  ZoneD = 3,
}

export enum LandType {
  Center = 0,
  N = 1, E = 2, S = 3, W = 4,
  NEo = 5, SEo = 6, SWo = 7, NWo = 8,
  NEi = 9, SEi = 10, SWi = 11, NWi = 12,
  Special = 13,
}

export function landClassOf(landId: number): LandClass {
  return ((landId & LND_CLASS_MASK) >> LND_CLASS_SHIFT) as LandClass;
}

export function landTypeOf(landId: number): LandType {
  const typeIdx = (landId & LND_TYPE_MASK) >> LND_TYPE_SHIFT;
  return (typeIdx <= LandType.Special ? typeIdx : LandType.Special) as LandType;
}

export function landVarOf(landId: number): number {
  return landId & LND_VAR_MASK;
}

export function isSpecialTile(landId: number): boolean {
  return landTypeOf(landId) === LandType.Special;
}
