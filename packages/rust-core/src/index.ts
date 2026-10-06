import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface NativeCore {
  invoke(operation: string, input: string): string;
  NativeIndex: new () => NativeSearchStore;
  NativePolicy: new () => NativeStore;
}

interface NativeStore {
  execute(operation: string, input: string): string;
}

interface NativeSearchStore extends NativeStore {
  searchAsync(input: string): Promise<string>;
}

let native: NativeCore;
try {
  native = require("../brain-core.node") as NativeCore;
} catch (cause) {
  throw new Error("Rust core is missing or incompatible. Run pnpm rust:build before starting Broppy.", { cause });
}

export function core<T>(operation: string, input: unknown): T {
  return JSON.parse(native.invoke(operation, JSON.stringify(input))) as T;
}

export class NativeIndex {
  private readonly store = new native.NativeIndex();

  execute<T>(operation: string, input: unknown = null): T {
    return JSON.parse(this.store.execute(operation, JSON.stringify(input))) as T;
  }

  async search<T>(input: unknown): Promise<T> {
    return JSON.parse(await this.store.searchAsync(JSON.stringify(input))) as T;
  }
}

export class NativePolicy {
  private readonly store = new native.NativePolicy();

  execute<T>(operation: string, input: unknown = null): T {
    return JSON.parse(this.store.execute(operation, JSON.stringify(input))) as T;
  }
}
