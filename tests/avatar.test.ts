import { describe, it, expect } from "vitest";
import { isValidAvatarLogin } from "../src/handlers/avatar";

describe("isValidAvatarLogin", () => {
  it("accepts typical logins", () => {
    expect(isValidAvatarLogin("jsmith")).toBe(true);
    expect(isValidAvatarLogin("a-b_c")).toBe(true);
    expect(isValidAvatarLogin("user42")).toBe(true);
  });

  it("rejects malformed or unsafe logins", () => {
    expect(isValidAvatarLogin("")).toBe(false);
    expect(isValidAvatarLogin("..")).toBe(false);
    expect(isValidAvatarLogin("a/b")).toBe(false);
    expect(isValidAvatarLogin("a.b")).toBe(false);
    expect(isValidAvatarLogin("Foo")).toBe(false);
    expect(isValidAvatarLogin("a".repeat(33))).toBe(false);
  });
});
