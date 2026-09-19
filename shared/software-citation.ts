export const softwareCitation = {
  key: "hcltech_robotics_ceres_2026",
  title: "CERES: Capturing Egocentric Recordings with Ease and Speed",
  authors: [
    { family: "Foldi", given: "Tamas" },
    { family: "von Csefalvay", given: "Chris" },
    { family: "Unni Krishnan", given: "Achyuthan" },
  ],
  year: 2026,
  version: "1.1.2",
  licence: "MIT",
  repository: "https://github.com/hcltech-robotics/ceres",
  documentation: "https://ceres.cam/documentation/",
  doi: "10.5281/zenodo.22729061",
} as const;

export function softwareBibtex() {
  const citation = softwareCitation;
  const fields = [
    `  author  = {${citation.authors.map(author => `${author.family}, ${author.given}`).join(" and ")}}`,
    `  title   = {{${citation.title}}}`,
    `  year    = {${citation.year}}`,
    `  version = {${citation.version}}`,
    ...(citation.doi ? [`  doi     = {${citation.doi}}`] : []),
    `  url     = {${citation.repository}}`,
    `  license = {${citation.licence}}`,
  ];
  return `@software{${citation.key},\n${fields.join(",\n")}\n}`;
}
