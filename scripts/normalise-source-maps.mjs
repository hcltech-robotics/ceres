import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function normalise(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await normalise(file);
    else if (entry.name.endsWith(".map")) {
      const map = JSON.parse(await readFile(file, "utf8"));
      let changed = false;
      map.sourcesContent = map.sourcesContent?.map((content, index) => {
        if (typeof content !== "string" || !map.sources[index]?.endsWith("?url")) return content;
        const stable = createHash("sha256").update(map.sources[index]).digest("hex").slice(0, 8);
        const next = content.replace(/__VITE_ASSET__[\w$-]+__/gu, `__VITE_ASSET__${stable}__`);
        changed ||= next !== content;
        return next;
      });
      if (changed) await writeFile(file, JSON.stringify(map));
    }
  }
}

await normalise("dist");
