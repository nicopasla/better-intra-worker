import { describe, it, expect } from "vitest";
import {
  buildProfilePayload,
  buildProjects,
  pickBestCursus,
  pickGroups,
  pickLogtimeConfig,
  pickVisuals,
} from "../src/handlers/profile";

describe("pickBestCursus", () => {
  it("prefers the main cursus over piscine and other kinds", () => {
    const best = pickBestCursus([
      { cursus_id: 4, level: 20, cursus: { kind: "piscine" } },
      { cursus_id: 21, level: 9.5, cursus: { kind: "main" } },
      { cursus_id: 1, level: 3, cursus: { kind: "main_deprecated" } },
    ]);
    expect(best?.cursus_id).toBe(21);
  });

  it("keeps the highest level when the kind is the same", () => {
    const best = pickBestCursus([
      { cursus_id: 21, level: 4.2, cursus: { kind: "main" } },
      { cursus_id: 22, level: 12.8, cursus: { kind: "main" } },
    ]);
    expect(best?.cursus_id).toBe(22);
  });

  it("returns null for an empty list", () => {
    expect(pickBestCursus([])).toBeNull();
  });
});

describe("buildProjects", () => {
  const projects = [
    {
      id: 1,
      occurrence: 0,
      status: "in_progress",
      cursus_ids: [21],
      project: { name: "Fly-in", slug: "fly-in" },
    },
    {
      id: 2,
      occurrence: 1,
      status: "finished",
      "validated?": true,
      final_mark: 100,
      marked_at: "2026-01-02T10:00:00.000Z",
      cursus_ids: [21],
      project: { name: "Born2beroot", slug: "born2beroot" },
    },
    {
      id: 3,
      occurrence: 0,
      status: "finished",
      "validated?": false,
      final_mark: 30,
      marked_at: "2026-03-02T10:00:00.000Z",
      cursus_ids: [21],
      project: { name: "Libft", slug: "libft" },
    },
    {
      id: 4,
      occurrence: 0,
      status: "finished",
      "validated?": true,
      final_mark: 100,
      marked_at: "2026-02-02T10:00:00.000Z",
      cursus_ids: [4],
      project: { name: "Piscine", slug: "piscine" },
    },
    {
      id: 5,
      occurrence: 0,
      status: "finished",
      "validated?": true,
      final_mark: 100,
      cursus_ids: [21],
      project: { name: "No mark yet", slug: "no-mark" },
    },
  ];

  it("scopes projects to the main cursus", () => {
    const p = buildProjects(projects, 21);
    expect(p.total).toBe(4);
    expect(p.recent.map((r) => r.name)).not.toContain("Piscine");
  });

  it("counts validated, failed and in-progress projects", () => {
    const p = buildProjects(projects, 21);
    expect(p.validated).toBe(2);
    expect(p.failed).toBe(1);
    expect(p.inProgress).toBe(1);
    expect(p.active.map((a) => a.name)).toEqual(["Fly-in"]);
  });

  it("keeps finished projects without a mark date out of the recent list", () => {
    const p = buildProjects(projects, 21);
    expect(p.recent.map((r) => r.name)).not.toContain("No mark yet");
  });

  it("sorts finished projects by mark date, newest first", () => {
    const p = buildProjects(projects, 21);
    expect(p.recent.map((r) => r.name)).toEqual(["Libft", "Born2beroot"]);
  });

  it("keeps every project when there is no main cursus", () => {
    expect(buildProjects(projects, null).total).toBe(5);
  });

  it("tolerates a missing projects_users array", () => {
    const p = buildProjects(undefined, 21);
    expect(p.total).toBe(0);
    expect(p.active).toEqual([]);
    expect(p.recent).toEqual([]);
  });
});

describe("pickVisuals", () => {
  it("exposes only the whitelisted profile visuals", () => {
    const visuals = pickVisuals({
      PROFILE_IMAGE_URL: "https://api.betterintra.com/api/v1/public/images/abc",
      PROFILE_AVATAR_BG: "#5b21b6",
      PROFILE_AVATAR_POSITION_X: "60",
      PROFILE_AVATAR_POSITION_Y: 40,
      PROFILE_AVATAR_SCALE: 130,
      PROFILE_BANNER_URL: "https://example.com/banner.png",
      PROFILE_BANNER_MODE: "tile",
      PROFILE_BANNER_COLOR: "#123456",
      PROFILE_BACKGROUND_URL: "https://example.com/bg.png",
      PROFILE_BACKGROUND_MODE: "fit",
      PROFILE_BACKGROUND_COLOR: "#abcdef",
      LOGTIME_CALENDAR_COLOR: "#00bcba",
      FRIENDS_LIST: ["alice"],
      PROFILE_USERNAME_BADGE_BG: "#fff",
    });

    expect(visuals).toEqual({
      profileColor: "#00bcba",
      customAvatar: "https://api.betterintra.com/api/v1/public/images/abc",
      avatarBg: "#5b21b6",
      avatarShape: "round",
      avatarPosX: 60,
      avatarPosY: 40,
      avatarScale: 130,
      banner: "https://example.com/banner.png",
      bannerMode: "tile",
      bannerColor: "#123456",
      background: "https://example.com/bg.png",
      backgroundMode: "fit",
      backgroundColor: "#abcdef",
    });
  });

  it("falls back to defaults and drops invalid values", () => {
    const visuals = pickVisuals({
      PROFILE_BANNER_MODE: "nope",
      PROFILE_BACKGROUND_MODE: 42,
      PROFILE_AVATAR_BG: "red",
      PROFILE_IMAGE_URL: "  ",
      PROFILE_AVATAR_POSITION_X: "abc",
      PROFILE_AVATAR_SCALE: 5000,
      LOGTIME_CALENDAR_COLOR: "javascript:alert(1)",
    });

    expect(visuals.avatarBg).toBe("transparent");
    expect(visuals.customAvatar).toBeNull();
    expect(visuals.avatarPosX).toBe(50);
    expect(visuals.avatarScale).toBe(400);
    expect(visuals.bannerMode).toBe("fill");
    expect(visuals.backgroundMode).toBe("fill");
    expect(visuals.profileColor).toBeNull();
  });

  it("handles a missing settings blob", () => {
    expect(pickVisuals().customAvatar).toBeNull();
  });

  it("only accepts round or square avatar shapes", () => {
    expect(pickVisuals({ PROFILE_AVATAR_SHAPE: "square" }).avatarShape).toBe(
      "square",
    );
    expect(pickVisuals({ PROFILE_AVATAR_SHAPE: "nope" }).avatarShape).toBe(
      "round",
    );
  });
});

describe("pickLogtimeConfig", () => {
  it("returns the extension defaults for an empty settings blob", () => {
    expect(pickLogtimeConfig()).toEqual({
      goalHours: 140,
      showAverage: true,
      showGoal: true,
      showTacos: false,
      showTotalTacos: false,
      showStreak: true,
      emoji: "🌮",
      divisor: 8.7,
      rate: 2,
      maxEarnings: 500,
      showDaysMode: "date",
      calendarColor: "#00BCBA",
      labelsColor: "#26a641",
      rainbowPalette: "rainbow",
      calendarView: "normal",
      fontScale: 100,
      disableAnimations: false,
    });
  });

  it("uses the owner's LOGTIME_* preferences", () => {
    const config = pickLogtimeConfig({
      LOGTIME_GOAL_HOURS: 120,
      LOGTIME_SHOW_AVERAGE: false,
      LOGTIME_SHOW_TACOS: true,
      LOGTIME_SHOW_TOTAL_TACOS: true,
      LOGTIME_SHOW_STREAK: false,
      LOGTIME_EMOJI: "🍕",
      LOGTIME_EMOJI_DIVISOR: 10,
      LOGTIME_EMOJI_RATE: 3,
      LOGTIME_MAX_EARNINGS: 250,
      LOGTIME_SHOW_DAYS_MODE: "both",
      LOGTIME_CALENDAR_COLOR: "#123abc",
      LOGTIME_LABELS_COLOR: "#abcdef",
      LOGTIME_RAINBOW_PALETTE: "sunset",
      LOGTIME_CALENDAR_VIEW: "heatmap",
      GENERAL_FONT_SCALE: 110,
      DISABLE_ANIMATIONS: true,
    });
    expect(config.goalHours).toBe(120);
    expect(config.showAverage).toBe(false);
    expect(config.showTacos).toBe(true);
    expect(config.showTotalTacos).toBe(true);
    expect(config.showStreak).toBe(false);
    expect(config.emoji).toBe("🍕");
    expect(config.divisor).toBe(10);
    expect(config.rate).toBe(3);
    expect(config.maxEarnings).toBe(250);
    expect(config.showDaysMode).toBe("both");
    expect(config.calendarColor).toBe("#123abc");
    expect(config.labelsColor).toBe("#abcdef");
    expect(config.rainbowPalette).toBe("sunset");
    expect(config.calendarView).toBe("heatmap");
    expect(config.fontScale).toBe(110);
    expect(config.disableAnimations).toBe(true);
  });

  it("drops invalid enums, colours and numbers", () => {
    const config = pickLogtimeConfig({
      LOGTIME_CALENDAR_VIEW: "spiral",
      LOGTIME_SHOW_DAYS_MODE: "weeks",
      LOGTIME_CALENDAR_COLOR: "not-a-color",
      LOGTIME_LABELS_COLOR: "rgb(1,2,3)",
      LOGTIME_GOAL_HOURS: "lots",
      LOGTIME_EMOJI: "",
      GENERAL_FONT_SCALE: 5000,
    });
    expect(config.calendarView).toBe("normal");
    expect(config.showDaysMode).toBe("date");
    expect(config.calendarColor).toBe("#00BCBA");
    expect(config.labelsColor).toBe("#26a641");
    expect(config.goalHours).toBe(140);
    expect(config.emoji).toBe("🌮");
    expect(config.fontScale).toBe(200);
  });
});

describe("buildProfilePayload", () => {
  const user = {
    login: "amelie",
    displayname: "Amélie Martin",
    usual_full_name: "Amélie Martin",
    image: {
      link: "https://cdn/link.png",
      versions: { large: "https://cdn/large.png" },
    },
    "staff?": false,
    "alumni?": true,
    "active?": true,
    created_at: "2024-01-30T13:30:43.828Z",
    alumnized_at: "2026-05-01T00:00:00.000Z",
    wallet: 842,
    correction_point: 12,
    location: "c3r1p2",
    campus: [{ id: 12, name: "Belgium" }],
    pool_month: "june",
    pool_year: "2001",
    groups: [
      { name: "Piscine C", color: "#0099ff" },
      { name: "42 Network" },
    ],
    cursus_users: [
      {
        cursus_id: 4,
        level: 1,
        grade: "Pisciner",
        cursus: { name: "Piscine", kind: "piscine" },
      },
      {
        cursus_id: 21,
        level: 14.32,
        grade: "Member",
        blackholed_at: "2027-01-01T00:00:00.000Z",
        begin_at: "2025-01-01T00:00:00.000Z",
        cursus: { name: "42cursus", slug: "42cursus", kind: "main" },
      },
    ],
    projects_users: [
      {
        id: 2,
        status: "finished",
        "validated?": true,
        final_mark: 100,
        marked_at: "2026-01-02T10:00:00.000Z",
        cursus_ids: [21],
        project: { name: "Born2beroot", slug: "born2beroot" },
      },
    ],
  };

  it("maps identity, stats and cursus", () => {
    const p = buildProfilePayload(user, { PROFILE_AVATAR_SCALE: 120 });
    expect(p.login).toBe("amelie");
    expect(p.displayName).toBe("Amélie Martin");
    expect(p.avatar).toBe("https://cdn/large.png");
    expect(p.alumni).toBe(true);
    expect(p.alumnizedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(p.wallet).toBe(842);
    expect(p.correctionPoints).toBe(12);
    expect(p.level).toBe(14.32);
    expect(p.grade).toBe("Member");
    expect(p.poolLabel).toBe("06/2001");
    expect(p.campusName).toBe("Belgium");
    expect(p.groups).toEqual([
      { name: "Piscine C", color: "#0099ff" },
      { name: "42 Network", color: null },
    ]);
    expect(p.cursus).toEqual({
      name: "42cursus",
      slug: "42cursus",
      kind: "main",
      beginAt: "2025-01-01T00:00:00.000Z",
      endAt: null,
    });
    expect(p.blackholedAt).toBe("2027-01-01T00:00:00.000Z");
    expect(p.visuals.avatarScale).toBe(120);
  });

  it("derives the project summary from the main cursus", () => {
    const p = buildProfilePayload(user);
    expect(p.projects.total).toBe(1);
    expect(p.projects.recent[0].name).toBe("Born2beroot");
  });

  it("includes the owner's logtime preferences", () => {
    const p = buildProfilePayload(user, { LOGTIME_GOAL_HOURS: 90 });
    expect(p.logtime.goalHours).toBe(90);
    expect(p.logtime.calendarView).toBe("normal");
  });

  it("survives 42 payload gaps", () => {
    const p = buildProfilePayload({ login: "ghost" });
    expect(p.displayName).toBe("ghost");
    expect(p.level).toBe(0);
    expect(p.cursus).toBeNull();
    expect(p.poolLabel).toBeNull();
    expect(p.alumnizedAt).toBeNull();
    expect(p.projects.total).toBe(0);
    expect(p.groups).toEqual([]);
  });
});

describe("pickGroups", () => {
  it("keeps group names with their colours", () => {
    expect(
      pickGroups([
        { name: "PHOENIX", color: "#f99e3b" },
        { name: "Supervising Tutor", color: "#6000bc" },
      ]),
    ).toEqual([
      { name: "PHOENIX", color: "#f99e3b" },
      { name: "Supervising Tutor", color: "#6000bc" },
    ]);
  });

  it("drops invalid colours and nameless or malformed entries", () => {
    expect(
      pickGroups([
        { name: "Bocal", color: "red" },
        { name: "  " },
        null,
        { name: 42 },
        { name: "Alumni", color: "#abc" },
      ]),
    ).toEqual([
      { name: "Bocal", color: null },
      { name: "Alumni", color: "#abc" },
    ]);
  });

  it("handles a missing groups array", () => {
    expect(pickGroups(undefined)).toEqual([]);
    expect(pickGroups("nope")).toEqual([]);
  });
});
