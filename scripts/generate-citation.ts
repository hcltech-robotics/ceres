import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { softwareBibtex, softwareCitation as citation } from "../shared/software-citation.js";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const directory = path.resolve(outputIndex < 0 ? "." : args[outputIndex + 1]);
const check = args.includes("--check");
const quote = (value: string) => JSON.stringify(value);
const cff = [
  "cff-version: 1.2.0",
  "message: Please cite the version of CERES used in your work.",
  "type: software",
  `title: ${quote(citation.title)}`,
  `version: ${quote(citation.version)}`,
  `license: ${citation.licence}`,
  `repository-code: ${citation.repository}`,
  `url: ${citation.documentation}`,
  ...(citation.doi ? [`doi: ${citation.doi}`] : []),
  "authors:",
  ...citation.authors.flatMap(author => [`  - family-names: ${quote(author.family)}`, `    given-names: ${quote(author.given)}`]),
].join("\n") + "\n";
const zenodo = {
  title: citation.title,
  description: "CERES captures synchronised egocentric video, audio, head pose and hand tracking with task metadata on Meta Quest. The self-hosted application supports paired capture, Solo capture, Bridge streaming and LeRobot v3 dataset export.",
  upload_type: "software",
  access_right: "open",
  license: "mit",
  version: citation.version,
  creators: citation.authors.map(author => ({ name: `${author.family}, ${author.given}` })),
  keywords: ["egocentric capture", "robotics", "WebXR", "LeRobot", "self-hosting"],
  related_identifiers: [
    { identifier: citation.repository, relation: "isSupplementTo", scheme: "url" },
    { identifier: citation.documentation, relation: "isDocumentedBy", scheme: "url" },
  ],
};
for (const [name, text] of Object.entries({ "CITATION.cff": cff, "citation.bib": softwareBibtex() + "\n", ".zenodo.json": JSON.stringify(zenodo, null, 2) + "\n" })) {
  const file = path.join(directory, name);
  if (check) {
    if (await readFile(file, "utf8") !== text) throw new Error(`${name} does not match the software citation`);
  } else {
    await mkdir(directory, { recursive: true });
    await writeFile(file, text);
  }
}
