/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CERES_HOSTED_ATTESTATION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
