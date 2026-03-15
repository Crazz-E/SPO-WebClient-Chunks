/**
 * Shared types for the chunk generation pipeline.
 * Ported from SPO-WebClient src/shared/map-config.ts
 */

export interface MapMetadata {
  name: string;
  width: number;
  height: number;
  groundHref: string;
  terrainType: string;
  towns: MapTownInfo[];
  clusters: string[];
}

export interface MapTownInfo {
  name: string;
  cluster: string;
  x: number;
  y: number;
}

export enum Season {
  WINTER = 0,
  SPRING = 1,
  SUMMER = 2,
  AUTUMN = 3,
}

export const SEASON_NAMES: Record<Season, string> = {
  [Season.WINTER]: 'Winter',
  [Season.SPRING]: 'Spring',
  [Season.SUMMER]: 'Summer',
  [Season.AUTUMN]: 'Autumn',
};

export const ALL_SEASONS = [Season.WINTER, Season.SPRING, Season.SUMMER, Season.AUTUMN];
