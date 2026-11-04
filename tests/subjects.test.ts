import { describe, it, expect } from "vitest";
import {
  clampModifiedAt,
  decideSubjectVersion,
  isSubjectPdfUrl,
  normalizeSubjectUrl,
  ongoingProjectSlugs,
  subjectRecipients,
  wantsSubjectNotification,
} from "../src/handlers/subjects";
import type { UserData } from "../src/types";

const NOW = new Date("2026-10-23T12:00:00.000Z").getTime();
const PDF = "https://cdn.intra.42.fr/pdf/pdf/123/en.subject.pdf";

describe("isSubjectPdfUrl", () => {
  it("accepts intra-hosted PDF links", () => {
    expect(isSubjectPdfUrl(PDF)).toBe(true);
    expect(
      isSubjectPdfUrl("https://projects.intra.42.fr/uploads/files/libft.pdf"),
    ).toBe(true);
  });

  it("rejects other hosts, protocols and extensions", () => {
    expect(isSubjectPdfUrl("https://example.com/subject.pdf")).toBe(false);
    expect(isSubjectPdfUrl("http://cdn.intra.42.fr/pdf/pdf/1/x.pdf")).toBe(
      false,
    );
    expect(isSubjectPdfUrl("https://cdn.intra.42.fr/pdf/pdf/1/x.pdf?x=1")).toBe(
      true,
    );
    expect(isSubjectPdfUrl("https://cdn.intra.42.fr/pdf/pdf/1/x.html")).toBe(
      false,
    );
    expect(isSubjectPdfUrl(42)).toBe(false);
    expect(isSubjectPdfUrl("")).toBe(false);
  });
});

describe("clampModifiedAt", () => {
  it("accepts a plausible PDF date", () => {
    expect(clampModifiedAt(NOW - 1000, NOW)).toBe(NOW - 1000);
  });

  it("rejects invalid, ancient and far-future values", () => {
    expect(clampModifiedAt(Number.NaN, NOW)).toBeNull();
    expect(clampModifiedAt("2026-01-01", NOW)).toBeNull();
    expect(clampModifiedAt(0, NOW)).toBeNull();
    expect(clampModifiedAt(NOW + 48 * 60 * 60 * 1000, NOW)).toBeNull();
  });
});

describe("normalizeSubjectUrl", () => {
  it("drops the fragment and normalises the origin", () => {
    expect(normalizeSubjectUrl(`${PDF}#page=2`)).toBe(PDF);
  });
});

describe("decideSubjectVersion", () => {
  const stored = { url: PDF, modified_at: NOW };

  it("establishes a baseline on the first report", () => {
    expect(decideSubjectVersion(null, { url: PDF, modifiedAt: NOW }, NOW)).toEqual(
      { status: "first", url: PDF, modifiedAt: NOW },
    );
  });

  it("is a no-op for the same version", () => {
    expect(
      decideSubjectVersion(stored, { url: PDF, modifiedAt: NOW }, NOW),
    ).toEqual({ status: "known", url: PDF, modifiedAt: NOW });
  });

  it("detects a newer PDF date", () => {
    expect(
      decideSubjectVersion(
        stored,
        { url: PDF, modifiedAt: NOW + 60_000 },
        NOW,
      ),
    ).toEqual({
      status: "changed",
      url: PDF,
      modifiedAt: NOW + 60_000,
    });
  });

  it("never regresses the known date", () => {
    expect(
      decideSubjectVersion(
        stored,
        { url: PDF, modifiedAt: NOW - 60_000 },
        NOW,
      ),
    ).toEqual({ status: "known", url: PDF, modifiedAt: NOW });
  });

  it("adopts a variant link quietly when the date is unchanged", () => {
    const variant = "https://cdn.intra.42.fr/pdf/pdf/456/en.subject.pdf";
    expect(
      decideSubjectVersion(stored, { url: variant, modifiedAt: NOW }, NOW),
    ).toEqual({ status: "known", url: variant, modifiedAt: NOW });
  });

  it("keeps the stored link when a stale date arrives from another link", () => {
    const stale = "https://cdn.intra.42.fr/pdf/pdf/000/en.subject.pdf";
    expect(
      decideSubjectVersion(
        stored,
        { url: stale, modifiedAt: NOW - 60_000 },
        NOW,
      ),
    ).toEqual({ status: "known", url: PDF, modifiedAt: NOW });
  });

  it("backfills a missing date without notifying", () => {
    expect(
      decideSubjectVersion(
        { url: PDF, modified_at: null },
        { url: PDF, modifiedAt: NOW },
        NOW,
      ),
    ).toEqual({ status: "known", url: PDF, modifiedAt: NOW });
  });
});

describe("ongoingProjectSlugs", () => {
  it("reads the JSON written by /me", () => {
    expect(
      ongoingProjectSlugs(
        JSON.stringify([{ slug: "libft" }, { slug: "minishell" }]),
      ),
    ).toEqual(["libft", "minishell"]);
  });

  it("ignores malformed rows and entries", () => {
    expect(ongoingProjectSlugs("not json")).toEqual([]);
    expect(ongoingProjectSlugs(JSON.stringify({ slug: "libft" }))).toEqual([]);
    expect(
      ongoingProjectSlugs(JSON.stringify([{ slug: 1 }, null, { slug: "ok" }])),
    ).toEqual(["ok"]);
    expect(ongoingProjectSlugs(undefined)).toEqual([]);
  });
});

describe("wantsSubjectNotification", () => {
  const user = (settings: Record<string, unknown>): UserData => ({
    settings,
    pushSubscriptions: [
      { endpoint: "https://push.example/1", p256dh: "x", auth: "y", addedAt: 1 },
    ],
  });

  it("accepts users who did not opt out", () => {
    expect(wantsSubjectNotification(user({}))).toBe(true);
    expect(wantsSubjectNotification(user({ PUSH_ENABLED: true }))).toBe(true);
  });

  it("honours the project toggle and the push master switch", () => {
    expect(
      wantsSubjectNotification(user({ SUBJECT_NOTIFY_UPDATED: false })),
    ).toBe(false);
    expect(wantsSubjectNotification(user({ PUSH_ENABLED: false }))).toBe(false);
  });

  it("requires at least one device", () => {
    expect(
      wantsSubjectNotification({ settings: {}, pushSubscriptions: [] }),
    ).toBe(false);
  });
});

describe("subjectRecipients", () => {
  const rows = [
    { hash: "a", projects: JSON.stringify([{ slug: "libft" }]) },
    {
      hash: "b",
      projects: JSON.stringify([{ slug: "minishell" }, { slug: "libft" }]),
    },
    { hash: "c", projects: "[]" },
    { hash: "d", projects: "not json" },
  ];

  it("returns every user doing the project", () => {
    expect(subjectRecipients(rows, "libft")).toEqual(["a", "b"]);
  });

  it("returns nobody when the project is not ongoing", () => {
    expect(subjectRecipients(rows, "push_swap")).toEqual([]);
  });
});
