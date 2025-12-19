// Minimal AudioWorklet global typings shim for TypeScript/ESLint.
// This project compiles worklets via Vite bundling, but TS doesn't automatically
// include the `audioworklet` lib definitions in this repo.

declare const sampleRate: number;
declare const currentTime: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: typeof AudioWorkletProcessor
): void;


