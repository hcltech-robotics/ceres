export interface OrderedBatchProcessingOptions<TInput, TOutput> {
  readonly values: readonly TInput[];
  readonly batchSize: number;
  readonly read: (value: TInput, index: number) => Promise<TOutput>;
  readonly consume: (value: TOutput, index: number) => void;
  readonly checkpoint: () => void;
  readonly yieldBetweenBatches: () => Promise<void>;
}

export async function processOrderedBatches<TInput, TOutput>(
  options: OrderedBatchProcessingOptions<TInput, TOutput>,
) {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error("Ordered batch size must be a positive safe integer");
  }
  for (let index = 0; index < options.values.length; index += options.batchSize) {
    options.checkpoint();
    const batchEnd = Math.min(options.values.length, index + options.batchSize);
    const reads: Array<Promise<TOutput>> = [];
    for (let batchIndex = index; batchIndex < batchEnd; batchIndex += 1) {
      reads.push(options.read(options.values[batchIndex]!, batchIndex));
    }
    const values = await Promise.all(reads);
    options.checkpoint();
    for (let batchIndex = 0; batchIndex < values.length; batchIndex += 1) {
      options.consume(values[batchIndex]!, index + batchIndex);
    }
    await options.yieldBetweenBatches();
  }
  options.checkpoint();
}
