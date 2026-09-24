/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the FMS Operations API when hosted separately, e.g. https://fms-api.example.com */
  readonly VITE_API_URL?: string;
}
