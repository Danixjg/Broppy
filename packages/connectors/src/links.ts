import type { SourceDocument } from "@brain/types";
import { core } from "@brain/rust-core";

export type LinkOrigins = Partial<Record<SourceDocument["source"], readonly string[]>>;

export function linkFromUrl(value: string, origins: LinkOrigins = {}): string | undefined {
  return core<string | null>("links.fromUrl", { value, origins }) ?? undefined;
}

/** The items a text links to: the issue keys it names and the links it contains, sorted. */
export function linksIn(text: string, origins: LinkOrigins = {}): string[] {
  return core<string[]>("links.in", { text, origins });
}

/** The document with its full set of links: those its source declares plus those in its text, never itself. */
export function withLinks<T extends SourceDocument>(doc: T, origins?: LinkOrigins): T {
  return core<T>("links.withLinks", { doc, origins });
}
