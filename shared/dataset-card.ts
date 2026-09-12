export const CERES_DATASET_CARD_START = "<!-- CERES_DATASET_CARD_START -->";
export const CERES_DATASET_CARD_END = "<!-- CERES_DATASET_CARD_END -->";
const datasetCardMetadataSchema = "ceres-dataset-card-metadata-v1";
const managedDatasetTags = ["CERES", "egocentric", "lerobot", "xr"] as const;
const managedObservationPath = "shards/episode-*/data/chunk-*/file-*.parquet";
const datasetCardMaxBytes = 1_048_576;
const datasetCardMaxRenderExpansionBytes = 64 * 1_024;
const datasetCardMaxAliases = 99;
const datasetCardTextEncoder = new TextEncoder();
const datasetViewerBaseUrl =
  "https://huggingface.co/spaces/chrisvoncsefalvay/ceres-dataset-viewer";

type DatasetCardYaml = Pick<
  typeof import("yaml"),
  "isMap" | "isScalar" | "isSeq" | "parseDocument" | "visit"
>;
let datasetCardYamlPromise: Promise<DatasetCardYaml> | null = null;

function loadDatasetCardYaml() {
  datasetCardYamlPromise ??= import("yaml").then(({
    isMap,
    isScalar,
    isSeq,
    parseDocument,
    visit,
  }) => ({
    isMap,
    isScalar,
    isSeq,
    parseDocument,
    visit,
  }));
  return datasetCardYamlPromise;
}

export class DatasetCardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetCardValidationError";
  }
}

interface DatasetCardEpisode {
  id: string;
  recorderSlots: number;
  gaps: number;
  rateHz: number | null;
  devices: string[];
}

interface DatasetCardMetadata {
  schema: typeof datasetCardMetadataSchema;
  version: 1;
  repository: string;
  episodes: DatasetCardEpisode[];
}

export interface DatasetCardUpdate {
  content: string;
  action: "create" | "update" | "preserve";
}

export async function updateCeresDatasetCard(
  existing: string | null,
  repository: string,
  episodeMetadata: readonly unknown[],
): Promise<DatasetCardUpdate> {
  assertDatasetCardInputSize(existing);
  const incoming = episodeMetadata
    .map(datasetCardEpisode)
    .filter((episode): episode is DatasetCardEpisode => episode !== null);
  const markers = datasetCardMarkers(existing);
  if (markers === null) {
    if (existing !== null && existing.trim().length > 0) {
      return validatedDatasetCardUpdate(existing, existing, "preserve");
    }
    const metadata = datasetCardMetadata(repository, incoming);
    return validatedDatasetCardUpdate(
      existing,
      renderDatasetCard(metadata, datasetCardLineEnding(existing ?? "")),
      "create",
    );
  }

  const yaml = await loadDatasetCardYaml();
  const repairedPrefix = repairLegacyDatasetCardPrefix(
    existing!.slice(0, markers.startStart),
    yaml,
  );
  const repaired = `${repairedPrefix}${existing!.slice(markers.startStart)}`;
  const repairedMarkers = datasetCardMarkers(repaired);
  if (repairedMarkers === null) {
    throw new DatasetCardValidationError("The CERES dataset card markers are missing");
  }
  const prior = parseDatasetCardMetadata(
    repaired.slice(repairedMarkers.startEnd, repairedMarkers.endStart),
  );
  const metadata = datasetCardMetadata(
    repository,
    mergeEpisodes(prior.episodes, incoming),
  );
  const newline = datasetCardLineEnding(repaired);
  const prefix = updateDatasetCardFrontMatter(
    repaired.slice(0, repairedMarkers.startStart),
    newline,
    yaml,
  );
  const block = renderManagedDatasetCard(metadata, newline);
  return validatedDatasetCardUpdate(
    existing,
    `${prefix}${block}${repaired.slice(repairedMarkers.endEnd)}`,
    "update",
  );
}

function assertDatasetCardInputSize(value: string | null) {
  if (value !== null && datasetCardBytes(value) > datasetCardMaxBytes) {
    throw new DatasetCardValidationError("The CERES dataset card exceeds the upload size limit");
  }
}

function validatedDatasetCardUpdate(
  existing: string | null,
  content: string,
  action: DatasetCardUpdate["action"],
): DatasetCardUpdate {
  const renderedBytes = datasetCardBytes(content);
  if (renderedBytes > datasetCardMaxBytes) {
    throw new DatasetCardValidationError("The CERES dataset card exceeds the upload size limit");
  }
  if (
    existing !== null
    && renderedBytes > datasetCardBytes(existing) + datasetCardMaxRenderExpansionBytes
  ) {
    throw new DatasetCardValidationError("The CERES dataset card render expansion is too large");
  }
  return { content, action };
}

function datasetCardBytes(value: string) {
  return datasetCardTextEncoder.encode(value).byteLength;
}

function datasetCardMarkers(value: string | null) {
  if (value === null) return null;
  const boundary = datasetCardMarkerScanBoundary(value);
  if (boundary.incomplete) {
    const standalone = datasetCardMarkdownLines(value, boundary.start)
      .some(({ text }) => datasetCardMarkerLine(text) !== null);
    if (standalone) {
      throw new DatasetCardValidationError("The CERES dataset card YAML frontmatter is incomplete");
    }
  }
  const { starts, ends, ambiguous } = scanDatasetCardMarkers(value, boundary.start);
  if (ambiguous) {
    throw new DatasetCardValidationError("The CERES dataset card marker context is ambiguous");
  }
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) {
    throw new DatasetCardValidationError("The CERES dataset card markers are duplicated or incomplete");
  }
  const startStart = starts[0]!;
  const startEnd = startStart + CERES_DATASET_CARD_START.length;
  const endStart = ends[0]!;
  if (endStart < startEnd) {
    throw new DatasetCardValidationError("The CERES dataset card markers are out of order");
  }
  const endEnd = endStart + CERES_DATASET_CARD_END.length;
  return { startStart, startEnd, endStart, endEnd };
}

interface DatasetCardMarkdownLine {
  start: number;
  next: number;
  text: string;
  inlineBoundary: boolean;
  protected: boolean;
}

interface DatasetCardOffsetRange {
  start: number;
  end: number;
}

function datasetCardMarkerScanBoundary(value: string) {
  const opening = /^---\r?\n/.exec(value);
  if (!opening) return { start: 0, incomplete: false };
  const closing = /^---(?=\r?$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(value);
  if (!match) return { start: opening[0].length, incomplete: true };
  const delimiterEnd = match.index + 3;
  const lineEnding = value.startsWith("\r\n", delimiterEnd)
    ? 2
    : value.charCodeAt(delimiterEnd) === 10 ? 1 : 0;
  return { start: delimiterEnd + lineEnding, incomplete: false };
}

function scanDatasetCardMarkers(value: string, start: number) {
  const lines = datasetCardMarkdownLines(value, start);
  let fence: { character: "`" | "~"; length: number } | null = null;
  let htmlComment = false;
  for (const line of lines) {
    if (fence !== null) {
      line.protected = true;
      if (datasetCardFenceClosing(line.text, fence)) fence = null;
      continue;
    }
    if (htmlComment) {
      line.protected = true;
      if (line.text.includes("-->")) htmlComment = false;
      continue;
    }
    if (datasetCardMarkerLine(line.text) !== null) {
      line.inlineBoundary = true;
      continue;
    }
    const opening = datasetCardFenceOpening(line.text);
    if (opening !== null) {
      line.protected = true;
      fence = opening;
    } else if (datasetCardHtmlCommentOpening(line.text)) {
      line.protected = true;
      htmlComment = !line.text.includes("-->");
    } else if (/^(?: {4}|\t)/.test(line.text)) {
      line.protected = true;
    } else if (datasetCardAtxHeading(line.text)) {
      line.inlineBoundary = true;
    }
  }

  const codeSpans: DatasetCardOffsetRange[] = [];
  const ambiguousSpans: DatasetCardOffsetRange[] = [];
  let regionStart: number | null = null;
  let regionEnd = start;
  const flushRegion = () => {
    if (regionStart === null) return;
    const spans = datasetCardCodeSpans(value, regionStart, regionEnd);
    codeSpans.push(...spans.matched);
    ambiguousSpans.push(...spans.unmatched);
    regionStart = null;
  };
  for (const line of lines) {
    if (line.protected || line.text.trim().length === 0) {
      flushRegion();
      continue;
    }
    if (line.inlineBoundary) {
      flushRegion();
      const spans = datasetCardCodeSpans(value, line.start, line.next);
      codeSpans.push(...spans.matched);
      ambiguousSpans.push(...spans.unmatched);
      continue;
    }
    regionStart ??= line.start;
    regionEnd = line.next;
  }
  flushRegion();

  const starts: number[] = [];
  const ends: number[] = [];
  let ambiguous = false;
  for (const line of lines) {
    const marker = datasetCardMarkerLine(line.text);
    if (marker === null) continue;
    if (line.protected || datasetCardOffsetInRanges(line.start, codeSpans)) continue;
    if (datasetCardOffsetInRanges(line.start, ambiguousSpans)) {
      ambiguous = true;
      continue;
    }
    if (marker === "start") starts.push(line.start);
    else ends.push(line.start);
  }
  return { starts, ends, ambiguous };
}

function datasetCardFenceOpening(line: string) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match?.[1]) return null;
  const character = match[1][0] as "`" | "~";
  if (character === "`" && match[2]?.includes("`")) return null;
  return { character, length: match[1].length };
}

function datasetCardFenceClosing(
  line: string,
  fence: { character: "`" | "~"; length: number },
) {
  const escaped = fence.character === "`" ? "`" : "~";
  return new RegExp(`^ {0,3}${escaped}{${fence.length},}[\\t ]*$`).test(line);
}

function datasetCardHtmlCommentOpening(line: string) {
  return /^ {0,3}<!--/.test(line);
}

function datasetCardAtxHeading(line: string) {
  return /^ {0,3}#{1,6}(?:[\t ]+|$)/.test(line);
}

function datasetCardMarkdownLines(value: string, start: number) {
  const lines: DatasetCardMarkdownLine[] = [];
  let lineStart = start;
  while (lineStart <= value.length) {
    const nextLine = value.indexOf("\n", lineStart);
    const lineEnd = nextLine < 0 ? value.length : nextLine;
    const rawLine = value.slice(lineStart, lineEnd);
    lines.push({
      start: lineStart,
      next: nextLine < 0 ? value.length : nextLine + 1,
      text: rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine,
      inlineBoundary: false,
      protected: false,
    });
    if (nextLine < 0) break;
    lineStart = nextLine + 1;
  }
  return lines;
}

function datasetCardCodeSpans(value: string, start: number, end: number) {
  const matched: DatasetCardOffsetRange[] = [];
  const unmatched: DatasetCardOffsetRange[] = [];
  const runs = datasetCardBacktickRuns(value, start, end);
  const nextSameLength = new Array<number | undefined>(runs.length);
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    nextSameLength[index] = nextByLength.get(run.length);
    nextByLength.set(run.length, index);
  }
  let index = 0;
  while (index < runs.length) {
    const opening = runs[index]!;
    if (opening.escaped) {
      index += 1;
      continue;
    }
    const closingIndex = nextSameLength[index];
    if (closingIndex === undefined) {
      unmatched.push({ start: opening.start, end });
      index += 1;
      continue;
    }
    const closing = runs[closingIndex]!;
    matched.push({ start: opening.start, end: closing.end });
    index = closingIndex + 1;
  }
  return { matched, unmatched };
}

function datasetCardBacktickRuns(value: string, start: number, end: number) {
  const runs: Array<DatasetCardOffsetRange & { escaped: boolean; length: number }> = [];
  let cursor = start;
  while (cursor < end) {
    const runStart = value.indexOf("`", cursor);
    if (runStart < 0 || runStart >= end) break;
    let runEnd = runStart + 1;
    while (runEnd < end && value.charCodeAt(runEnd) === 96) runEnd += 1;
    runs.push({
      start: runStart,
      end: runEnd,
      escaped: datasetCardBacktickEscaped(value, runStart, start),
      length: runEnd - runStart,
    });
    cursor = runEnd;
  }
  return runs;
}

function datasetCardBacktickEscaped(value: string, offset: number, boundary: number) {
  let slashes = 0;
  for (let cursor = offset - 1; cursor >= boundary && value.charCodeAt(cursor) === 92; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function datasetCardOffsetInRanges(offset: number, ranges: readonly DatasetCardOffsetRange[]) {
  return ranges.some((range) => offset > range.start && offset < range.end);
}

function datasetCardMarkerLine(value: string) {
  if (value === CERES_DATASET_CARD_START) return "start" as const;
  if (value === CERES_DATASET_CARD_END) return "end" as const;
  return null;
}

type DatasetCardDocument = ReturnType<DatasetCardYaml["parseDocument"]>;
type DatasetCardMap = import("yaml").YAMLMap<unknown, unknown>;
type DatasetCardNode = import("yaml").Node;
type DatasetCardScalar = import("yaml").Scalar<unknown>;

interface ParsedDatasetCardFrontMatter {
  end: number;
  document: DatasetCardDocument;
}

function datasetCardLineEnding(value: string) {
  return value.includes("\r\n") ? "\r\n" : "\n";
}

function legacyDatasetCardFrontMatter(newline: "\n" | "\r\n") {
  return [
    "---",
    "tags:",
    "- CERES",
    "- egocentric",
    "- lerobot",
    "- xr",
    "---",
  ].join(newline);
}

function repairLegacyDatasetCardPrefix(value: string, yaml: DatasetCardYaml) {
  const leading = parseLeadingDatasetCardFrontMatter(value, yaml);
  if (leading === null) return value;
  let offset = skipDatasetCardWhitespaceBackwards(value, value.length);
  let firstGeneratedStart: number | null = null;
  while (offset > leading.end) {
    const generatedStart = generatedDatasetCardFrontMatterStart(value, offset);
    if (
      generatedStart === null
      || generatedStart < leading.end
      || (generatedStart !== leading.end && value.charCodeAt(generatedStart - 1) !== 10)
    ) break;
    firstGeneratedStart = generatedStart;
    offset = skipDatasetCardWhitespaceBackwards(value, generatedStart);
  }
  if (firstGeneratedStart === null) return value;

  const retained = value.slice(0, firstGeneratedStart);
  if (retained.endsWith("\n")) return retained;
  const newline = datasetCardLineEnding(value);
  return `${retained.replace(/[\t ]+$/, "")}${newline}${newline}`;
}

function generatedDatasetCardFrontMatterStart(value: string, offset: number) {
  const lf = legacyDatasetCardFrontMatter("\n");
  if (value.lastIndexOf(lf, offset - lf.length) === offset - lf.length) {
    return offset - lf.length;
  }
  const crlf = legacyDatasetCardFrontMatter("\r\n");
  if (value.lastIndexOf(crlf, offset - crlf.length) === offset - crlf.length) {
    return offset - crlf.length;
  }
  return null;
}

function skipDatasetCardWhitespaceBackwards(value: string, offset: number) {
  let cursor = offset;
  while (cursor > 0) {
    const code = value.charCodeAt(cursor - 1);
    if (code !== 9 && code !== 10 && code !== 13 && code !== 32) break;
    cursor -= 1;
  }
  return cursor;
}

function updateDatasetCardFrontMatter(
  prefix: string,
  newline: "\n" | "\r\n",
  yaml: DatasetCardYaml,
) {
  const parsed = parseLeadingDatasetCardFrontMatter(prefix, yaml);
  if (parsed === null) {
    return `${renderNewDatasetCardFrontMatter(newline)}${newline}${newline}${prefix}`;
  }
  if (!mergeDatasetCardFrontMatter(parsed.document, yaml)) return prefix;
  const rendered = renderDatasetCardFrontMatter(parsed.document, newline);
  return `${rendered}${prefix.slice(parsed.end)}`;
}

function parseLeadingDatasetCardFrontMatter(
  value: string,
  yaml: DatasetCardYaml,
): ParsedDatasetCardFrontMatter | null {
  const opening = value.match(/^---\r?\n/);
  if (!opening) return null;
  const closing = /^---(?=\r?$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(value);
  if (!match) {
    throw new DatasetCardValidationError("The CERES dataset card YAML frontmatter is incomplete");
  }
  const source = value.slice(opening[0].length, match.index);
  try {
    const document = yaml.parseDocument(source, {
      intAsBigInt: true,
      keepSourceTokens: true,
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new DatasetCardValidationError("The CERES dataset card YAML frontmatter is invalid");
    }
    if (!yaml.isMap(document.contents)) {
      throw new DatasetCardValidationError("The CERES dataset card YAML frontmatter must be a mapping");
    }
    let aliases = 0;
    yaml.visit(document, {
      Alias() {
        aliases += 1;
      },
    });
    if (aliases > datasetCardMaxAliases) {
      throw new DatasetCardValidationError("The CERES dataset card YAML frontmatter has too many aliases");
    }
    return { end: match.index + 3, document };
  } catch (error) {
    if (error instanceof DatasetCardValidationError) throw error;
    throw new DatasetCardValidationError("The CERES dataset card YAML frontmatter is invalid");
  }
}

function mergeDatasetCardFrontMatter(document: DatasetCardDocument, yaml: DatasetCardYaml) {
  const root = document.contents;
  if (!yaml.isMap(root)) {
    throw new DatasetCardValidationError("The CERES dataset card YAML frontmatter must be a mapping");
  }
  const tagsChanged = mergeDatasetCardTags(root, document, yaml);
  const configsChanged = mergeDatasetCardConfigs(root, document, yaml);
  return tagsChanged || configsChanged;
}

function mergeDatasetCardTags(
  root: DatasetCardMap,
  document: DatasetCardDocument,
  yaml: DatasetCardYaml,
) {
  if (!root.has("tags")) {
    root.set("tags", document.createNode([...managedDatasetTags]));
    return true;
  }
  const tags = root.get("tags", true) as unknown;
  if (!yaml.isSeq(tags)) {
    throw new DatasetCardValidationError("The CERES dataset card tags must be a sequence of strings");
  }
  rejectDatasetCardAliases(tags, yaml, "The CERES dataset card tags cannot use aliases");
  let changed = false;
  const seenManaged = new Set<string>();
  const retained: unknown[] = [];
  for (const tag of tags.items) {
    if (!yaml.isScalar(tag) || typeof tag.value !== "string" || tag.value.length === 0) {
      throw new DatasetCardValidationError("The CERES dataset card tags must be a sequence of strings");
    }
    if (managedDatasetTags.includes(tag.value as typeof managedDatasetTags[number])) {
      if (seenManaged.has(tag.value)) {
        assertDatasetCardNodeRemovalSafe(
          tag,
          yaml,
          "A duplicate managed CERES dataset tag cannot be removed losslessly",
        );
        changed = true;
        continue;
      }
      seenManaged.add(tag.value);
    }
    retained.push(tag);
  }
  for (const tag of managedDatasetTags) {
    if (seenManaged.has(tag)) continue;
    retained.push(document.createNode(tag));
    changed = true;
  }
  if (changed) tags.items = retained;
  return changed;
}

function mergeDatasetCardConfigs(
  root: DatasetCardMap,
  document: DatasetCardDocument,
  yaml: DatasetCardYaml,
) {
  if (!root.has("configs")) {
    root.set("configs", document.createNode([managedDatasetConfig()]));
    return true;
  }
  const configs = root.get("configs", true) as unknown;
  if (!yaml.isSeq(configs)) {
    throw new DatasetCardValidationError("The CERES dataset card configs must be a sequence");
  }
  const names = new Set<string>();
  let changed = false;
  let managedFound = false;
  for (const config of configs.items) {
    if (!yaml.isMap(config)) {
      throw new DatasetCardValidationError("Each CERES dataset card config must be a mapping");
    }
    const name = datasetCardConfigName(config, yaml);
    if (names.has(name)) {
      throw new DatasetCardValidationError("The CERES dataset card contains duplicate config names");
    }
    names.add(name);
    const defaultValue = datasetCardDefaultValue(config, yaml);
    if (name === "default") {
      managedFound = true;
      if (defaultValue !== true) {
        if (defaultValue === false) {
          const defaultNode = config.get("default", true) as DatasetCardScalar;
          defaultNode.value = true;
        } else {
          config.set("default", true);
        }
        changed = true;
      }
      changed = repairManagedDatasetFiles(config, document, yaml) || changed;
    } else if (defaultValue === true) {
      const defaultPair = datasetCardMapPair(config, "default", yaml);
      if (defaultPair === null) {
        throw new DatasetCardValidationError("A named CERES dataset card default flag is invalid");
      }
      assertDatasetCardPairRemovalSafe(
        defaultPair,
        yaml,
        "A named CERES dataset card default flag cannot be removed losslessly",
      );
      config.delete("default");
      changed = true;
    }
  }
  if (!managedFound) {
    configs.items.unshift(document.createNode(managedDatasetConfig()));
    changed = true;
  }
  return changed;
}

function datasetCardConfigName(config: DatasetCardMap, yaml: DatasetCardYaml) {
  const value = config.get("config_name", true) as unknown;
  if (
    !yaml.isScalar(value)
    || typeof value.value !== "string"
    || value.value.trim().length === 0
    || value.value !== value.value.trim()
  ) {
    throw new DatasetCardValidationError("Each CERES dataset card config needs a valid config_name");
  }
  return value.value;
}

function datasetCardMapPair(map: DatasetCardMap, key: string, yaml: DatasetCardYaml) {
  return map.items.find((pair) => (
    yaml.isScalar(pair.key) && pair.key.value === key
  )) ?? null;
}

function datasetCardDefaultValue(config: DatasetCardMap, yaml: DatasetCardYaml) {
  if (!config.has("default")) return undefined;
  const value = config.get("default", true) as unknown;
  if (!yaml.isScalar(value) || typeof value.value !== "boolean") {
    throw new DatasetCardValidationError("A CERES dataset card config has an invalid default flag");
  }
  return value.value;
}

function repairManagedDatasetFiles(
  config: DatasetCardMap,
  document: DatasetCardDocument,
  yaml: DatasetCardYaml,
) {
  if (!config.has("data_files")) {
    config.set("data_files", document.createNode(managedDatasetConfig().data_files));
    return true;
  }
  const dataFiles = config.get("data_files", true) as unknown;
  if (!yaml.isSeq(dataFiles)) {
    throw new DatasetCardValidationError("The managed CERES data_files value is invalid");
  }
  rejectDatasetCardAliases(
    dataFiles,
    yaml,
    "The managed CERES data_files value cannot use aliases",
  );
  const retainedIndex = managedDatasetFileEntryIndex(dataFiles.items, yaml);
  if (retainedIndex < 0) {
    for (const item of dataFiles.items) {
      assertDatasetCardNodeRemovalSafe(
        item as DatasetCardNode,
        yaml,
        "The managed CERES data_files entries cannot be replaced losslessly",
      );
    }
    dataFiles.items = [document.createNode(managedDatasetConfig().data_files[0])];
    return true;
  }

  const retained = dataFiles.items[retainedIndex];
  if (!yaml.isMap(retained)) {
    throw new DatasetCardValidationError("The managed CERES data_files entry is invalid");
  }
  for (const [index, item] of dataFiles.items.entries()) {
    if (index === retainedIndex) continue;
    assertDatasetCardNodeRemovalSafe(
      item as DatasetCardNode,
      yaml,
      "A managed CERES data_files entry cannot be removed losslessly",
    );
  }
  const entryChanged = repairManagedDatasetFileEntry(retained, document, yaml);
  if (dataFiles.items.length === 1) return entryChanged;
  dataFiles.items = [retained];
  return true;
}

function managedDatasetFileEntryIndex(items: readonly unknown[], yaml: DatasetCardYaml) {
  let firstMap = -1;
  for (const [index, item] of items.entries()) {
    if (!yaml.isMap(item)) continue;
    if (firstMap < 0) firstMap = index;
    const path = item.get("path", true) as unknown;
    if (yaml.isScalar(path) && path.value === managedObservationPath) return index;
  }
  return firstMap;
}

function repairManagedDatasetFileEntry(
  entry: DatasetCardMap,
  document: DatasetCardDocument,
  yaml: DatasetCardYaml,
) {
  const retainedPairs = [] as typeof entry.items;
  const managedKeys = new Set(["split", "path"]);
  for (const pair of entry.items) {
    const key = pair.key;
    if (!yaml.isScalar(key) || typeof key.value !== "string") {
      throw new DatasetCardValidationError("The managed CERES data_files entry has an invalid key");
    }
    if (managedKeys.has(key.value)) {
      retainedPairs.push(pair);
      continue;
    }
    assertDatasetCardPairRemovalSafe(
      pair,
      yaml,
      "A managed CERES data_files field cannot be removed losslessly",
    );
  }

  let changed = retainedPairs.length !== entry.items.length;
  const split = entry.get("split", true) as unknown;
  const path = entry.get("path", true) as unknown;
  if (split !== undefined && !yaml.isScalar(split)) {
    throw new DatasetCardValidationError("The managed CERES data_files split is invalid");
  }
  if (path !== undefined && !yaml.isScalar(path)) {
    throw new DatasetCardValidationError("The managed CERES data_files path is invalid");
  }
  entry.items = retainedPairs;
  changed = repairManagedDatasetScalar(entry, "split", split, "train", document) || changed;
  changed = repairManagedDatasetScalar(
    entry,
    "path",
    path,
    managedObservationPath,
    document,
  ) || changed;
  return changed;
}

function repairManagedDatasetScalar(
  entry: DatasetCardMap,
  key: string,
  existing: unknown,
  value: string,
  document: DatasetCardDocument,
) {
  if (existing === undefined) {
    entry.set(key, document.createNode(value));
    return true;
  }
  const scalar = existing as DatasetCardScalar;
  if (scalar.value === value) return false;
  scalar.value = value;
  return true;
}

function assertDatasetCardPairRemovalSafe(
  pair: import("yaml").Pair<unknown, unknown>,
  yaml: DatasetCardYaml,
  message: string,
) {
  assertDatasetCardNodeRemovalSafe(pair.key as DatasetCardNode, yaml, message);
  if (pair.value !== null) {
    assertDatasetCardNodeRemovalSafe(pair.value as DatasetCardNode, yaml, message);
  }
}

function assertDatasetCardNodeRemovalSafe(
  node: DatasetCardNode,
  yaml: DatasetCardYaml,
  message: string,
) {
  let unsafe = false;
  yaml.visit(node, {
    Alias() {
      unsafe = true;
    },
    Node(_key, candidate) {
      const anchor = "anchor" in candidate ? candidate.anchor : undefined;
      if (
        typeof anchor === "string"
        || candidate.comment !== undefined
        || candidate.commentBefore !== undefined
        || candidate.spaceBefore === true
        || candidate.tag !== undefined
      ) {
        unsafe = true;
      }
    },
  });
  if (unsafe) throw new DatasetCardValidationError(message);
}

function rejectDatasetCardAliases(node: import("yaml").Node, yaml: DatasetCardYaml, message: string) {
  let aliases = false;
  yaml.visit(node, {
    Alias() {
      aliases = true;
    },
  });
  if (aliases) throw new DatasetCardValidationError(message);
}

function managedDatasetConfig() {
  return {
    config_name: "default",
    default: true,
    data_files: [{ split: "train", path: managedObservationPath }],
  };
}

function renderNewDatasetCardFrontMatter(newline: "\n" | "\r\n") {
  return [
    "---",
    "tags:",
    ...managedDatasetTags.map((tag) => `- ${tag}`),
    "configs:",
    "- config_name: default",
    "  default: true",
    "  data_files:",
    "  - split: train",
    `    path: ${managedObservationPath}`,
    "---",
  ].join(newline);
}

function renderDatasetCardFrontMatter(
  document: DatasetCardDocument,
  newline: "\n" | "\r\n",
) {
  try {
    const rendered = document.toString({ lineWidth: 0 });
    const withoutTrailingLineFeed = rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
    const withLineEnding = withoutTrailingLineFeed.replace(/\r\n|\n/g, newline);
    return `---${newline}${withLineEnding}${newline}---`;
  } catch {
    throw new DatasetCardValidationError("The CERES dataset card YAML frontmatter could not be rendered");
  }
}

function datasetCardMetadata(repository: string, episodes: DatasetCardEpisode[]): DatasetCardMetadata {
  return {
    schema: datasetCardMetadataSchema,
    version: 1,
    repository,
    episodes: episodes.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function parseDatasetCardMetadata(value: string): DatasetCardMetadata {
  const match = value.match(/<!--\s*(\{[\s\S]*?\})\s*-->/);
  if (!match?.[1]) {
    throw new DatasetCardValidationError("The CERES dataset card metadata is missing");
  }
  try {
    const parsed = JSON.parse(match[1]) as Partial<DatasetCardMetadata>;
    if (
      parsed.schema !== datasetCardMetadataSchema
      || parsed.version !== 1
      || typeof parsed.repository !== "string"
      || !Array.isArray(parsed.episodes)
    ) {
      throw new DatasetCardValidationError("The CERES dataset card metadata is invalid");
    }
    const parsedEpisodes = parsed.episodes.map(datasetCardEpisode);
    if (parsedEpisodes.some((episode) => episode === null)) {
      throw new DatasetCardValidationError("The CERES dataset card episode metadata is invalid");
    }
    const episodes = parsedEpisodes as DatasetCardEpisode[];
    return { schema: datasetCardMetadataSchema, version: 1, repository: parsed.repository, episodes };
  } catch (error) {
    if (error instanceof DatasetCardValidationError) throw error;
    throw new DatasetCardValidationError("The CERES dataset card metadata is invalid");
  }
}

function datasetCardEpisode(value: unknown): DatasetCardEpisode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const id = text(candidate.episodeId) ?? text(candidate.id);
  if (!id || id.length > 128) return null;
  if ("recorderSlots" in candidate && "devices" in candidate) {
    const recorderSlots = nonNegativeInteger(candidate.recorderSlots);
    const gaps = nonNegativeInteger(candidate.gaps);
    const rateHz = positiveNumberOrNull(candidate.rateHz);
    const devices = Array.isArray(candidate.devices)
      ? [...new Set(candidate.devices.flatMap((device) => text(device) ? [text(device)!] : []))].sort()
      : [];
    return recorderSlots === null || gaps === null ? null : { id, recorderSlots, gaps, rateHz, devices };
  }
  const segments = Array.isArray(candidate.segments) ? candidate.segments : [];
  let recorderSlots = 0;
  let gaps = 0;
  for (const segment of segments) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) continue;
    const entry = segment as Record<string, unknown>;
    if (entry.outcome === "retry") continue;
    recorderSlots += nonNegativeInteger(entry.recorderSlotCount) ?? 0;
    gaps += nonNegativeInteger(entry.gapCount) ?? 0;
  }
  const captureMetadata = candidate.captureMetadata;
  const capture = captureMetadata && typeof captureMetadata === "object" && !Array.isArray(captureMetadata)
    ? captureMetadata as Record<string, unknown>
    : null;
  const recorder = capture?.recorder && typeof capture.recorder === "object"
    ? capture.recorder as Record<string, unknown>
    : null;
  const rateHz = knownNumber(recorder?.rateHz);
  const device = capture?.device && typeof capture.device === "object"
    ? capture.device as Record<string, unknown>
    : null;
  const headsetModel = knownText(device?.headsetModel);
  const questBrowser = knownBoolean(device?.questBrowser);
  const sensorSource = knownText(device?.sensorSource);
  const devices = [
    headsetModel ?? (questBrowser ? "Meta Quest headset" : null),
    sensorSource ? sensorSourceLabel(sensorSource) : null,
  ].flatMap((item) => item ? [item] : []);
  return { id, recorderSlots, gaps, rateHz, devices: [...new Set(devices)].sort() };
}

function mergeEpisodes(previous: readonly DatasetCardEpisode[], incoming: readonly DatasetCardEpisode[]) {
  const merged = new Map<string, DatasetCardEpisode>();
  for (const episode of previous) merged.set(episode.id, episode);
  for (const episode of incoming) merged.set(episode.id, episode);
  return [...merged.values()];
}

function renderDatasetCard(metadata: DatasetCardMetadata, newline: "\n" | "\r\n") {
  const frontMatter = renderNewDatasetCardFrontMatter(newline);
  return `${frontMatter}${newline}${newline}${renderManagedDatasetCard(metadata, newline)}${newline}`;
}

function datasetViewerUrl(repository: string) {
  const url = new URL(datasetViewerBaseUrl);
  url.search = new URLSearchParams({ repo: repository }).toString();
  return url.href;
}

function renderManagedDatasetCard(
  metadata: DatasetCardMetadata,
  newline: "\n" | "\r\n",
) {
  const episodes = metadata.episodes.length;
  const recorderSlots = metadata.episodes.reduce((total, episode) => total + episode.recorderSlots, 0);
  const gaps = metadata.episodes.reduce((total, episode) => total + episode.gaps, 0);
  const rates = [...new Set(metadata.episodes.flatMap((episode) => episode.rateHz === null ? [] : [episode.rateHz]))].sort((left, right) => left - right);
  const devices = [...new Set(metadata.episodes.flatMap((episode) => episode.devices))].sort();
  const durationS = rates.length === 1 && rates[0] ? recorderSlots / rates[0] : null;
  const metadataComment = JSON.stringify(metadata);
  return [
    CERES_DATASET_CARD_START,
    `<!-- ${metadataComment} -->`,
    "# CERES capture dataset",
    "",
    "LeRobot v3 episodes captured with CERES.",
    "",
    `[Open in the CERES dataset viewer](${datasetViewerUrl(metadata.repository)})`,
    "",
    "## Acquisition statistics",
    "",
    `- Episodes: ${episodes}`,
    `- Retained recorder slots: ${recorderSlots}`,
    `- Explicit tracking gaps: ${gaps}`,
    ...(durationS === null ? [] : [`- Captured duration: ${formatDuration(durationS)}`]),
    ...(rates.length === 0 ? [] : [`- Recorder rate: ${rates.map((rate) => `${rate} Hz`).join(", ")}`]),
    ...(devices.length === 0 ? [] : [`- Device: ${devices.join("; ")}`]),
    "",
    "Captured with [CERES](https://ceres.cam).",
    "",
    CERES_DATASET_CARD_END,
  ].join(newline);
}

function formatDuration(value: number) {
  if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes} min ${seconds} s`;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 256
    ? value.trim()
    : null;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveNumberOrNull(value: unknown) {
  return value === null ? null : typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function knownText(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return candidate.availability === "known" ? text(candidate.value) : null;
}

function knownNumber(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return candidate.availability === "known" ? positiveNumberOrNull(candidate.value) : null;
}

function knownBoolean(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.availability === "known" && candidate.value === true;
}

function sensorSourceLabel(value: string) {
  if (value === "native-webxr") return "Native WebXR";
  if (value === "iwer") return "IWER";
  if (value === "synthetic") return "Synthetic sensor source";
  return value;
}
