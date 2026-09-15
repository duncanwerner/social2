// Minimal ambient declarations for the handful of Node APIs the validation
// script uses. The frontend tsconfig deliberately keeps `types: ["vite/client"]`
// because everything under `src/` is browser code, and @types/node is not a
// dependency — so rather than widen the app's globals, the script's Node surface
// is declared here and only here.

declare const process: {
  argv: string[];
  exitCode: number | undefined;
  stdout: { write(text: string): void; isTTY?: boolean };
  stderr: { write(text: string): void };
};

// `import.meta.dirname` (Node >= 20.11). Declared for the bundled-module target,
// which only knows about `import.meta.url`.
interface ImportMeta {
  readonly dirname: string;
  readonly filename: string;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
