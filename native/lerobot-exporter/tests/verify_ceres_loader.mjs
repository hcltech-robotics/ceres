// Run an unchanged, bundled CERES HF Space loader against a local export.
// Bundle the pinned Space's src/lib/dataset.ts with esbuild before invoking this.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [loaderPath, datasetPath] = process.argv.slice(2);
assert(loaderPath && datasetPath, 'usage: node verify_ceres_loader.mjs <loader.mjs> <dataset>');
const loader = await import(pathToFileURL(path.resolve(loaderPath)));
async function filesIn(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(path.join(directory, entry.name), relative + '/'));
    else files.push({ path: relative, type: 'file', size: (await stat(path.join(directory, entry.name))).size });
  }
  return files;
}
const source = {
  async readJson(_tree, relative) { return JSON.parse(await readFile(path.join(datasetPath, relative), 'utf8')); },
  async readParquet(_tree, relative) {
    const data = await readFile(path.join(datasetPath, relative));
    const file = { byteLength: data.byteLength, slice: (start, end) => data.buffer.slice(data.byteOffset + start, data.byteOffset + (end ?? data.byteLength)) };
    return loader.readParquetRows(file);
  },
};
const info = await source.readJson(null, 'meta/info.json');
assert.equal(info.ceres_profile, 'ceres-bridge-lerobot3-v1');
// The local source never fetches the generated URLs. The loader still requires a pinned revision.
const tree = { repoId: 'ceres/native-export-conformance', revision: '0'.repeat(40), files: await filesIn(datasetPath) };
const episodes = loader.discoverEpisodes(tree);
assert.equal(episodes.length, info.total_episodes);
assert(episodes.length >= 2, 'conformance requires at least two episodes');
let count = 0;
const result = [];
for (const files of episodes) {
  const episode = await loader.loadEpisode(tree, files, { source });
  const first = episode.frames[0];
  assert.equal(first.index, count);
  assert.equal(first.frameIndex, 0);
  assert.equal(first.episodeIndex, files.episodeIndex);
  assert.equal(first.timestamp, 0);
  assert.equal(episode.summary.metadata.datasetFromIndex, count);
  assert.equal(episode.videos.length, 1);
  assert.equal(episode.summary.exportMetadata.captureMetadata.camera.width.value, info.features['observation.images.passthrough'].shape[1]);
  let actionCount = 0;
  for (const frame of episode.frames) {
    assert.equal(frame.index, count++);
    assert.equal(frame.action.length, 2);
    assert.equal(frame.state.length, 410);
    assert(Math.abs(frame.timestamp - frame.frameIndex / info.fps) < 1e-5);
    if (frame.action.some(value => value > 0)) actionCount++;
    const task = episode.summary.tasks.find(task => task.index === frame.taskIndex);
    assert(task && episode.summary.metadata.tasks.includes(task.text));
  }
  result.push({ episode: files.episodeIndex, rows: episode.frames.length, tasks: episode.summary.metadata.tasks, actions: actionCount,
    source_gaps: episode.frames.filter(frame => frame.sourceGap).length, first_source_timestamp: first.sourceTimestamp,
    duration_seconds: episode.durationSeconds, video: episode.videos[0].path });
}
assert.equal(count, info.total_frames);
console.log(JSON.stringify({ status: 'passed', reader: 'unchanged CERES HF dataset loader', dataset: path.resolve(datasetPath), rows: count, episodes: result }, null, 2));
