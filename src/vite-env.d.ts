/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.dbml?raw' {
  const content: string;
  export default content;
}

declare module '*.css';
