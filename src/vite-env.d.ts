/// <reference types="vite/client" />

declare module '*.dbml?raw' {
  const content: string;
  export default content;
}

declare module '*.css';
