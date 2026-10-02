import { describe, expect, it } from "vitest";
import { formatDesktopNotification, notifyDesktop } from "../utils/desktop-notify.js";

describe("desktop notifications", () => {
  describe("formatting", () => {
    it("leads with success for a passed run", () => {
      const note = formatDesktopNotification({ workflowName: "nightly", status: "passed" });
      expect(note.title).toBe("Workflow finished");
      expect(note.message).toContain("nightly");
      expect(note.urgent).toBe(false);
    });

    it("leads with the status for a failed run so it is legible in a tray", () => {
      const note = formatDesktopNotification({ workflowName: "nightly", status: "failed" });
      expect(note.title).toBe("Workflow failed");
      expect(note.urgent).toBe(true);
    });

    it("includes the error in the body when there is one", () => {
      const note = formatDesktopNotification({
        workflowName: "nightly",
        status: "failed",
        error: "exceeded tokenBudget (620/500)",
      });
      expect(note.message).toContain("exceeded tokenBudget (620/500)");
    });

    it("treats a timeout as urgent", () => {
      expect(formatDesktopNotification({ workflowName: "w", status: "timed_out" }).urgent).toBe(true);
    });

    it("treats a cancellation as urgent only when there is no outcome to report", () => {
      // A cancellation is still something the operator asked about, so it is
      // surfaced; it is simply titled by status rather than as a failure.
      const note = formatDesktopNotification({ workflowName: "w", status: "cancelled" });
      expect(note.urgent).toBe(true);
      expect(note.title).toBe("Workflow cancelled");
    });
  });

  describe("delivery", () => {
    // These exercise the real platform path, so they assert only that delivery
    // resolves to a definite answer. Whether this particular machine has a
    // notification centre is an environment fact, not a code contract.
    it("resolves to a definite result rather than throwing", async () => {
      const result = await notifyDesktop({ title: "t", message: "m" });
      expect(typeof result.delivered).toBe("boolean");
      if (result.delivered) expect(typeof result.via).toBe("string");
      else expect(typeof result.reason).toBe("string");
    });

    it("survives shell metacharacters, quotes and newlines in the body", async () => {
      // A notification body is data, never a command line. If quoting were wrong
      // this would either error or, worse, execute something. One case covers all
      // three hazards because they share the same escaping path.
      const result = await notifyDesktop({
        title: "; echo INJECTED",
        message: "$(whoami) `id` && echo x | cat 'quoted' \"double\"\nline2",
      });
      expect(typeof result.delivered).toBe("boolean");
    });

    it("survives an empty notification", async () => {
      const result = await notifyDesktop({ title: "", message: "" });
      expect(typeof result.delivered).toBe("boolean");
    });
  });
});
