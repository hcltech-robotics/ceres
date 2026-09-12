import { copyFileSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const wasmBindgenVersion = "0.2.127";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = realpathSync(path.resolve(scriptDirectory, ".."));
const [cratePath, outputName, publicPath] = process.argv.slice(2);

if (!cratePath || !outputName || !publicPath) {
  throw new Error("Usage: node scripts/build-wasm-package.mjs <crate-path> <output-name> <public-path>");
}

const crateRoot = realpathSync(path.resolve(projectRoot, cratePath));
const publicRoot = path.resolve(projectRoot, publicPath);

function run(command, argumentsForCommand, options = {}) {
  const result = spawnSync(command, argumentsForCommand, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `: ${(result.stderr || result.stdout).trim()}` : "";
    throw new Error(`${command} failed with exit code ${result.status}${detail}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

const bindgenVersionOutput = run("wasm-bindgen", ["--version"], { capture: true });
if (!new RegExp(`\\b${wasmBindgenVersion.replaceAll(".", "\\.")}\\b`).test(bindgenVersionOutput)) {
  throw new Error(`wasm-bindgen ${wasmBindgenVersion} is required, found: ${bindgenVersionOutput}`);
}

const installedTargets = run("rustup", ["target", "list", "--installed"], { capture: true })
  .split(/\r?\n/u);
if (!installedTargets.includes("wasm32-unknown-unknown")) {
  throw new Error("The wasm32-unknown-unknown Rust target is required.");
}

const userHome = os.homedir();
const remaps = [
  ...(userHome ? [[realpathSync(userHome), "/user-home"]] : []),
  [path.resolve(process.env.CARGO_HOME || path.join(userHome, ".cargo")), "/cargo-home"],
  [path.resolve(process.env.RUSTUP_HOME || path.join(userHome, ".rustup")), "/rustup-home"],
  [projectRoot, "/ceres-source"],
];

function rustEnvironment(targetDirectory, targetFeature) {
  const rustArguments = ["-C", `target-feature=${targetFeature}`];
  for (const [source, target] of remaps) {
    rustArguments.push("--remap-path-prefix", `${source}=${target}`);
  }
  const environment = {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: rustArguments.join("\x1f"),
    CARGO_TARGET_DIR: targetDirectory,
  };
  delete environment.RUSTFLAGS;
  return environment;
}

function buildVariant(variant, targetFeature) {
  const targetDirectory = path.join(crateRoot, "target", variant);
  const outputDirectory = path.join(crateRoot, `pkg-${variant}`);
  run("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown"], {
    cwd: crateRoot,
    env: rustEnvironment(targetDirectory, targetFeature),
  });
  run("wasm-bindgen", [
    "--target", "web",
    "--out-dir", outputDirectory,
    "--out-name", outputName,
    path.join(targetDirectory, "wasm32-unknown-unknown", "release", `${outputName}.wasm`),
  ], { cwd: crateRoot });

  const publicVariant = path.join(publicRoot, `pkg-${variant}`);
  mkdirSync(publicVariant, { recursive: true });
  copyFileSync(path.join(outputDirectory, `${outputName}.js`), path.join(publicVariant, `${outputName}.js`));
  copyFileSync(path.join(outputDirectory, `${outputName}_bg.wasm`), path.join(publicVariant, `${outputName}_bg.wasm`));
}

buildVariant("scalar", "-simd128");
buildVariant("simd", "+simd128");
