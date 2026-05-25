import { describe, expect, it } from "vitest";
import { newImageId, newSessionId } from "./id";

describe("id helpers", () => {
  it("produces image IDs with the img_ prefix", () => {
    const id = newImageId();
    expect(id).toMatch(/^img_[a-z0-9]{6}$/);
  });

  it("produces session IDs with the session_ prefix", () => {
    const id = newSessionId();
    expect(id).toMatch(/^session_[a-z0-9]{6}$/);
  });

  it("generates distinct IDs on consecutive calls", () => {
    const ids = new Set(Array.from({ length: 64 }, () => newImageId()));
    expect(ids.size).toBe(64);
  });
});
