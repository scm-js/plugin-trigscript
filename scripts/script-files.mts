/**
 * A script on disk as the compiler takes it: the file itself as main.ts (or main.tsx), and every file it imports by a
 * relative path, followed from file to file, under the path it has from the script's folder — videos, images, sounds and notes too. For the
 * probes, whose libraries sit beside them (probes/lib/…).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export function scriptFiles(path: string): Record<string, string> {
  const root = dirname(resolve(path));
  const files: Record<string, string> = {};
  const visit = (file: string, as: string) => {
    if (as in files) return;
    const text = readFileSync(file, "utf8");
    files[as] = text;
    for (const m of text.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = resolve(dirname(file), m[1]);
      const found = [base, `${base}.ts`, `${base}.tsx`].find((f) => existsSync(f) && /\.(tsx?|video|image|sound|notes)$/.test(f));
      if (!found) continue;
      // A video, an image, a sound or notes (compiler/media.ts) is taken as it is; nothing in it imports anything.
      if (/\.(?:video|image|sound|notes)$/.test(found)) files[relative(root, found).split("\\").join("/")] = readFileSync(found, "utf8");
      else visit(found, relative(root, found).split("\\").join("/"));
    }
  };
  visit(resolve(path), path.endsWith(".tsx") ? "main.tsx" : "main.ts");
  return files;
}
