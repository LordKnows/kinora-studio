import { describe, expect, it } from "vitest";

import { coverage, lineSentences, openText } from "@/studio/coverage";

/* Which lines of the script are on screen, from the quotes each shot names. */

const script = `《城市漫步》
主角：小橘，一只八个月大的橘色虎斑小猫。

序列一 · 清晨出发（0:00–0:18，小巷）
天刚亮。小橘从花盆后钻出来，伸了个懒腰。一只麻雀飞走，小橘停了一下，又继续。

序列二 · 屋顶（0:18–0:30）
城市的窗户一盏一盏亮起来。小橘的尾巴轻轻卷在脚边，它望着远处，眼睛里映着灯光。`;

describe("script coverage", () => {
  it("splits the scenes into sentences and leaves the title and cast out", () => {
    const c = coverage(script, []);
    expect(c.lines.map((l) => l.text)).toEqual(["天刚亮。", "小橘从花盆后钻出来，伸了个懒腰。", "一只麻雀飞走，小橘停了一下，又继续。", "城市的窗户一盏一盏亮起来。", "小橘的尾巴轻轻卷在脚边，它望着远处，眼睛里映着灯光。"]);
    expect(c.lines.map((l) => l.section)).toEqual([0, 0, 0, 1, 1]);
    expect(c.inUse).toBe(false);
  });

  it("covers a sentence by a clause of it, or by a quote that spans it", () => {
    const c = coverage(script, [
      { id: "a", slate: "1·1", scriptLines: ["天刚亮。小橘从花盆后钻出来，伸了个懒腰。"] },
      { id: "b", slate: "1·2", scriptLines: ["一只麻雀飞走"] },
      { id: "c", slate: "1·3", scriptLines: ["小橘停了一下，又继续"] },
      { id: "d", slate: "2·1", scriptLines: ["城市的窗户一盏一盏亮起来"] },
    ]);
    expect(c.lines.map((l) => l.shots)).toEqual([["a"], ["a"], ["b", "c"], ["d"], []]);
    expect(c.inUse).toBe(true);
    expect(c.stale).toEqual([]);
  });

  it("matches across spacing and punctuation, and flags a quote the script no longer has", () => {
    const c = coverage(script, [
      { id: "a", slate: "2·2", scriptLines: ["小橘的尾巴 轻轻卷在脚边 —— 它望着远处"] },
      { id: "b", slate: "2·3", scriptLines: ["它跳上了栏杆"] },
    ]);
    expect(c.lines[4]!.shots).toEqual(["a"]);
    expect(c.stale).toEqual([{ shotId: "b", slate: "2·3", quote: "它跳上了栏杆" }]);
  });

  it("leaves the clause of a sentence that no shot quotes open", () => {
    const c = coverage(script, [{ id: "a", slate: "2·2", scriptLines: ["小橘的尾巴轻轻卷在脚边"] }]);
    const last = c.lines[4]!;
    expect(last.shots).toEqual(["a"]);
    expect(last.open).toBe(true);
    expect(openText(last)).toBe("它望着远处，眼睛里映着灯光。");
    const whole = coverage(script, [{ id: "a", slate: "2·2", scriptLines: ["小橘的尾巴轻轻卷在脚边，它望着远处，眼睛里映着灯光。"] }]);
    expect(whole.lines[4]!.open).toBe(false);
  });

  it("works on an English script with INT./EXT. headings", () => {
    const text = "INT. KITCHEN – NIGHT\nShe waits by the window. The kettle sings.\n\nEXT. STREET – DAY\nHe runs.";
    expect(lineSentences("She waits by the window. The kettle sings.")).toEqual(["She waits by the window.", "The kettle sings."]);
    const c = coverage(text, [{ id: "a", slate: "1·1", scriptLines: ["the kettle sings"] }]);
    expect(c.lines.map((l) => [l.text, l.shots.length])).toEqual([["She waits by the window.", 0], ["The kettle sings.", 1], ["He runs.", 0]]);
  });
});
