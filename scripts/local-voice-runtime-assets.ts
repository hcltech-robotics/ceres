import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Plugin } from "vite";
import runtime from "../shared/local-voice-runtime.json";

const upstreamModuleSha256 = "a4b40a7cf7a810e3cdbe8c12f3dd47598900566117b824da690585deb79c59e2";

// Emscripten's non-dynamic invokers marshal the same Wasm ABI without Function.
// Keep arrays local to each call so native callbacks may re-enter an invoker.
// https://github.com/emscripten-core/emscripten/blob/4.0.10/src/lib/libembind.js#L751
const staticEmbindInvoker = `function (...args) {
  var destructors = needsDestructorStack ? [] : null;
  var argsWired = [];
  var invokerFuncArgs = [cppTargetFunc];
  var thisWired;
  if (isClassMethodFunc) {
    thisWired = argTypes[1].toWireType(destructors, this);
    invokerFuncArgs.push(thisWired);
  }
  for (var i = 0; i < argTypes.length - 2; ++i) {
    argsWired[i] = argTypes[i + 2].toWireType(destructors, args[i]);
    invokerFuncArgs.push(argsWired[i]);
  }
  var rv = cppInvokerFunc(...invokerFuncArgs);
  if (needsDestructorStack) {
    runDestructors(destructors);
  } else {
    for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; ++i) {
      var param = i === 1 ? thisWired : argsWired[i - 2];
      if (argTypes[i].destructorFunction !== null) {
        argTypes[i].destructorFunction(param);
      }
    }
  }
  if (returns) return argTypes[0].fromWireType(rv);
}`;

// https://github.com/emscripten-core/emscripten/blob/4.0.10/src/lib/libemval.js#L317
const staticEmvalInvoker = `function (obj, func, destructorsRef, args) {
  var argN = [];
  var offset = 0;
  for (var i = 0; i < argCount; ++i) {
    argN.push(types[i].readValueFromPointer(args + offset));
    offset += types[i].argPackAdvance;
  }
  var rv = kind === 1 ? Reflect.construct(func, argN) : func.call(obj, ...argN);
  if (!retType.isVoid) return emval_returnValue(retType, destructorsRef, rv);
}`;

function replaceOnce(source: string, original: string, replacement: string) {
  if (source.split(original).length !== 2) {
    throw new Error("Moonshine runtime adjustment does not match exactly one reviewed site");
  }
  return source.replace(original, replacement);
}

/** Bounds native threads and preserves CSP without changing the model or Wasm. */
export function prepareMoonshineModule(source: Buffer) {
  if (createHash("sha256").update(source).digest("hex") !== upstreamModuleSha256) {
    throw new Error("Moonshine module differs from the reviewed 0.1.5 runtime");
  }
  // The released loader does not expose ENV or its helper pool as options.
  // The native runtime honours MOONSHINE_ORT_SINGLE_THREAD for all five model
  // sessions. Keep this reproducible loader adjustment pinned to the npm bytes.
  // https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/core/ort-utils/ort-utils.cpp#L113
  let prepared = replaceOnce(source.toString("utf8"),
    "var pthreadPoolSize=navigator.hardwareConcurrency;", "var pthreadPoolSize=1;");
  prepared = replaceOnce(prepared, "var ENV={};", 'var ENV={MOONSHINE_ORT_SINGLE_THREAD:"1"};');
  prepared = replaceOnce(prepared,
    "new Function(...args,invokerFnBody)(...closureArgs)", staticEmbindInvoker);
  prepared = replaceOnce(prepared,
    "new Function(...params,functionBody)(...args)", staticEmvalInvoker);
  return Buffer.from(prepared);
}

/** Keeps the Emscripten module, its pthread entry and Wasm at one origin. */
export function localVoiceRuntimeAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const directory = path.dirname(require.resolve(`${runtime.package}/moonshine.wasm`));
  let files: Map<string, Buffer> | undefined;
  async function assets() {
    if (files) return files;
    const metadata = JSON.parse(await readFile(path.join(directory, "../package.json"), "utf8"));
    if (metadata.version !== runtime.version) throw new Error("Moonshine runtime version does not match the pinned assets");
    const names = (await readdir(directory)).filter(name => /^[a-z0-9-]+\.(?:js|mjs|wasm)$/.test(name));
    files = new Map(await Promise.all(names.map(async name => [name, await readFile(path.join(directory, name))] as const)));
    for (const required of ["index.js", "transcriber.js", "module.js", "moonshine.mjs", "moonshine.wasm"]) {
      if (!files.has(required)) throw new Error(`Moonshine runtime asset is missing: ${required}`);
    }
    files.set("moonshine.mjs", prepareMoonshineModule(files.get("moonshine.mjs")!));
    return files;
  }
  return {
    name: "ceres-local-voice-runtime",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (!pathname.startsWith(runtime.basePath)) return next();
        try {
          const name = pathname.slice(runtime.basePath.length);
          const bytes = (await assets()).get(name);
          if (!bytes || !["GET", "HEAD"].includes(request.method ?? "GET")) {
            response.statusCode = 404;
            response.end();
            return;
          }
          response.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
          response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
          response.setHeader("Cache-Control", "no-cache");
          response.end(request.method === "HEAD" ? undefined : bytes);
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      for (const [name, source] of await assets()) {
        this.emitFile({ type: "asset", fileName: `${runtime.basePath.slice(1)}${name}`, source });
      }
    },
  };
}
