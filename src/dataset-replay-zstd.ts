import type { Compressors } from "hyparquet";
import { decompressZstd } from "hyparquet-compressors";

const decodeZstd = decompressZstd as unknown as (input: Uint8Array) => Uint8Array;

export const replayParquetCompressors = {
  ZSTD: (input) => decodeZstd(input),
} satisfies Compressors;
