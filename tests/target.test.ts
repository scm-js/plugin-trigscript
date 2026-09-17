/**
 * The build target: kept in `build.json` with or without a block, read by the state,
 * written by the service, carried through a build.
 */
import { describe, expect, it } from "vitest";
import { MANIFEST_MEMBER, readManifest, readTarget, scriptState, withManifest, withTarget, type ScriptManifest } from "../script";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("the build target in build.json", () => {
  it("is classic when the member is absent or says nothing", () => {
    expect(readTarget(new Map())).toBe("classic");
    expect(readTarget(new Map([[MANIFEST_MEMBER, enc.encode("{}")]]))).toBe("classic");
    expect(readTarget(new Map([[MANIFEST_MEMBER, enc.encode("not json")]]))).toBe("classic");
  });
  it("is written before any block exists, and read back without one", () => {
    const extras = withTarget(new Map(), "remastered");
    expect(readTarget(extras)).toBe("remastered");
    expect(readManifest(extras)).toBeNull();
    expect(scriptState([], extras)).toMatchObject({ target: "remastered", block: null, stale: false });
    // Back to classic: the member goes, since it held nothing else.
    expect(withTarget(extras, "classic").has(MANIFEST_MEMBER)).toBe(false);
  });
  it("rides on a block's manifest without touching the block", () => {
    const manifest: ScriptManifest = { version: 2, start: 3, count: 0, hash: "x", sources: [], files: ["main.ts"], sourceHash: "h" };
    const extras = withTarget(withManifest(new Map(), manifest), "remastered");
    expect(readManifest(extras)).toMatchObject({ start: 3, target: "remastered" });
    expect(JSON.parse(dec.decode(extras.get(MANIFEST_MEMBER)!))).toMatchObject({ version: 2, target: "remastered", start: 3 });
    expect(readManifest(withTarget(extras, "classic"))).not.toHaveProperty("target");
    expect(scriptState([], extras).target).toBe("remastered");
  });
});
