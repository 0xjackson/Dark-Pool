declare module 'circomlibjs' {
  export function buildPoseidon(): Promise<{
    (inputs: (bigint | number | Uint8Array)[]): Uint8Array;
    F: {
      toString(val: Uint8Array, radix?: number): string;
    };
  }>;
}
