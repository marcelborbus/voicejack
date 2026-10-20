export declare class GranularShifter {
  constructor(sampleRate: number, windowSec?: number);
  process(input: Float32Array | undefined, output: Float32Array, semitones: number): void;
}
export declare class Crusher {
  constructor();
  process(input: Float32Array | undefined, output: Float32Array, bits: number, hold: number): void;
}
