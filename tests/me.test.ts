import { describe, it, expect } from "vitest";
import { pickBestCursus } from "../src/handlers/me";
import type { CursusInfo } from "../src/utils";

const cursusMap: Record<number, CursusInfo> = {
  21: { name: "42cursus", slug: "42cursus", kind: "main" },
  9: { name: "C Piscine", slug: "c-piscine", kind: "piscine" },
  28: { name: "Reloaded", slug: "reloaded", kind: "piscine_community" },
  5: { name: "Old main", slug: "old-main", kind: "main_deprecated" },
};

/** A cursus_user as `/v2/me` returns it: the embedded cursus has no `kind`. */
const cursusUser = (cursusId: number, level: number) => ({
  cursus_id: cursusId,
  level,
  grade: null,
  cursus: { id: cursusId, name: "embedded", slug: "embedded" },
});

describe("pickBestCursus", () => {
  it("returns null when the payload has no cursus", () => {
    expect(pickBestCursus([], cursusMap)).toBeNull();
  });

  it("returns the only entry", () => {
    const only = cursusUser(21, 3);
    expect(pickBestCursus([only], cursusMap)).toBe(only);
  });

  it("prefers the main cursus over a higher-level piscine", () => {
    const main = cursusUser(21, 1);
    const piscine = cursusUser(9, 12);
    expect(pickBestCursus([piscine, main], cursusMap)).toBe(main);
  });

  it("ranks piscines above deprecated mains", () => {
    const deprecated = cursusUser(5, 15);
    const reloaded = cursusUser(28, 1);
    expect(pickBestCursus([deprecated, reloaded], cursusMap)).toBe(reloaded);
  });

  it("breaks ties on level", () => {
    const low = cursusUser(9, 2);
    const high = cursusUser(28, 7);
    expect(pickBestCursus([low, high], cursusMap)).toBe(high);
  });

  it("ranks using the map's kind even though the payload omits it", () => {
    const main = cursusUser(21, 0.5);
    const piscine = cursusUser(9, 20);
    expect(cursusUser(21, 0.5).cursus).not.toHaveProperty("kind");
    expect(pickBestCursus([piscine, main], cursusMap)).toBe(main);
  });

  it("still picks something when the cursus is unknown", () => {
    const unknownLow = cursusUser(999, 1);
    const unknownHigh = cursusUser(998, 9);
    expect(pickBestCursus([unknownLow, unknownHigh], cursusMap)).toBe(
      unknownHigh,
    );
  });

  it("prefers a known deprecated main over an unknown cursus", () => {
    const deprecated = cursusUser(5, 1);
    const unknown = cursusUser(999, 40);
    expect(pickBestCursus([unknown, deprecated], cursusMap)).toBe(deprecated);
  });
});
