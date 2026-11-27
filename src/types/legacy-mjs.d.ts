declare module '*/score-pdf.mjs' {
  export function renderScorePdf(song: {
    title: string;
    composer: string;
    timeSignature: [number, number];
    totalMeasures: number;
    events: Array<{
      id: string;
      pitch: number;
      step: string;
      alter: number;
      octave: number;
      onset: number;
      duration: number;
      measure: number;
      beat: number;
      hand: 'R' | 'L';
    }>;
  }): Uint8Array;
}

declare module '*/staff-layout.mjs' {
  export interface StaffInputNote {
    id: string;
    hand: 'R' | 'L';
    onset: number;
    pitch: number;
    stepOffset: number;
    alter: number;
    [key: string]: unknown;
  }

  export interface StaffGroup<T> {
    hand: 'R' | 'L';
    onset: number;
    notes: T[];
  }

  export function chordColumns(stepOffsets: number[], stemUp: boolean): number[];
  export function stemGoesUp(stepOffsets: number[]): boolean;
  export function groupStaffEvents<T extends { hand: 'R' | 'L'; onset: number; pitch: number }>(
    events: T[],
    onsetSlack?: number,
  ): StaffGroup<T>[];
  export function layoutStaffGroup<T extends { id: string; stepOffset: number; alter: number }>(
    notes: T[],
  ): {
    stemUp: boolean;
    stemX: number;
    notes: Array<T & { dx: number; accidentalLane: number }>;
  };
}

declare module '*/musescore-contract.mjs' {
  export const APP_BASE: string;
  export const HELPER_PATH: string;
  export const LIBRARY_PATH: string;
  export const HELPER_MARK: string;
  export const HELPER_ERRORS: string[];
  export const PAGES_ORIGIN: string;
  export const SCORE_ORIGIN: string;
  export function parseScoreUrl(raw: unknown): string | null;
}
