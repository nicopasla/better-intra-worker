import { describe, it, expect } from "vitest";
import { cursusUsersParams } from "../src/handlers/students";

describe("cursusUsersParams", () => {
  it("builds baseline params without future or range", () => {
    const params = cursusUsersParams(21);
    expect(params.get("filter[cursus_id]")).toBe("21");
    expect(params.get("filter[campus_id]")).toBe("12");
    expect(params.get("page[size]")).toBe("100");
    expect(params.has("filter[future]")).toBe(false);
    expect(params.has("range[begin_at]")).toBe(false);
  });

  it("adds filter[future]=true when requested", () => {
    const params = cursusUsersParams(21, { future: true });
    expect(params.get("filter[future]")).toBe("true");
    expect(params.has("range[begin_at]")).toBe(false);
    expect(params.get("filter[campus_id]")).toBe("12");
  });

  it("adds the begin_at range when provided", () => {
    const params = cursusUsersParams(21, {
      rangeBegin: "2026-10-01",
      rangeEnd: "2027-05-01",
    });
    expect(params.get("range[begin_at]")).toBe("2026-10-01,2027-05-01");
    expect(params.has("filter[future]")).toBe(false);
  });
});
