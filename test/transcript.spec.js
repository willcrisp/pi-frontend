// Transcript smoke tests: the chrome around rendered messages.
//
// Companion to composer.spec.js, and here for the same reason — these features
// have no other safety net, and every one of them shipped broken-by-omission
// once already: FindBar was written but never mounted, lib/diff.js was written
// but never imported, and the copy button renderMarkdown() plants in every code
// block had no click handler behind it. A test that the wiring exists is
// exactly what would have caught that.
//
// Driven against the transcript in mock-opencode.js (one fenced code block, one
// edit-shaped tool call), so these exercise the real components end to end.
import { expect, test } from "@playwright/test";

// Not "networkidle": the SSE stream is deliberately never-ending.
test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await page.locator(".msg-assistant").first().waitFor();
});

test.describe("diff rendering", () => {
  test("an edit tool call renders as a diff, not raw output", async ({ page }) => {
    const diff = page.locator(".tool-diff");
    await expect(diff).toHaveCount(1);
    await expect(diff.locator(".diff-path")).toHaveText(/README\.md/);
    await expect(diff.locator(".diff-stat-add")).toHaveText("+1");
    await expect(diff.locator(".diff-stat-del")).toHaveText("−1");
  });

  test("expanding shows the changed lines with their signs", async ({ page }) => {
    const diff = page.locator(".tool-diff");
    await diff.locator("summary").click();
    await expect(diff.locator(".diff-line.add")).toHaveText(/CHARLIE/);
    await expect(diff.locator(".diff-line.del")).toHaveText(/charlie/);
    // One change with 3 lines of context either side covers all 7 lines, so
    // nothing should be collapsed away.
    await expect(diff.locator(".diff-skip")).toHaveCount(0);
  });
});

test("the code-copy button copies the block it sits in", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const copy = page.locator(".markdown pre .code-copy").first();
  await expect(copy).toHaveCount(1);
  // Hidden until the <pre> is hovered, so click through the opacity.
  await copy.click({ force: true });
  await expect(copy).toHaveClass(/copied/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "const x = 1;\nconst y = 2;"
  );
});

test.describe("prompt rail", () => {
  test("lists the prompts in the chat", async ({ page }) => {
    await expect(page.locator(".msg-rail li")).toHaveCount(2);
    await expect(page.locator(".msg-rail-jump").first()).toHaveText("show me a snippet");
  });

  // V2 has no fork endpoint, so the fork is reconstructed: a new session, seeded
  // with a prompt carrying the earlier turns as context. Assert both halves are
  // in what gets sent — a fork that dropped the context would look identical
  // from the outside otherwise.
  test("the fork button starts a new chat seeded with the turns above it", async ({ page }) => {
    const row = page.locator(".msg-rail li").nth(1);
    await row.hover();
    await row.locator(".msg-rail-fork").click();

    const forked = page.locator(".msg-user").first();
    await expect(forked).toContainText("forked conversation");
    await expect(forked).toContainText("show me a snippet");
    await expect(forked).toContainText("now rename the file");
    // The new chat is a chat of its own: one prompt, not the two forked from.
    await expect(page.locator(".msg-rail li")).toHaveCount(1);
  });
});

test.describe("serena mcp chip", () => {
  test("serena tool calls render with a chip and stripped prefix", async ({ page }) => {
    const chip = page.locator(".mcp-chip");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText("serena");

    // The displayed name drops the serena_ prefix; the full name is on the title.
    const name = page.locator(".tool-mcp-serena .tool-name");
    await expect(name).toHaveText("find_referencing_symbols");
    await expect(name).toHaveAttribute("title", "serena_find_referencing_symbols");
  });

  test("serena tool call gets amber border and accent", async ({ page }) => {
    const tool = page.locator(".tool.tool-mcp-serena");
    await expect(tool).toHaveCount(1);

    const borderColor = await tool.evaluate((el) => getComputedStyle(el).borderColor);
    // rgba(224, 175, 104, 0.35)
    expect(borderColor).toMatch(/224,\s*175,\s*104/);

    const nameColor = await tool.locator(".tool-name").evaluate(
      (el) => getComputedStyle(el).color
    );
    // var(--msg-tool-serena) = #e0af68
    expect(nameColor).toMatch(/224,\s*175,\s*104/);
  });
});

test("web searches show the query and linked pages without expanding a tool payload", async ({ page }) => {
  const search = page.locator(".web-search");
  await expect(search).toHaveCount(1);
  await expect(search.locator(".web-search-term")).toHaveText("OpenCode reasoning levels");
  const result = search.locator(".web-search-result");
  await expect(result).toHaveCount(1);
  await expect(result).toContainText("OpenCode documentation");
  await expect(result).toHaveAttribute("href", "https://opencode.ai/docs/");
});

test.describe("live web searches", () => {
  async function control(request, body) {
    await request.post("http://127.0.0.1:4096/api/mock/control", { data: body });
  }

  async function prompt(page, text) {
    await page.locator("textarea").fill(text);
    await page.locator("textarea").press("Enter");
  }

  test("shows provider progress and a page while the search is still running", async ({ page, request }) => {
    await control(request, { webSearch: true, webSearchDelay: 1000 });
    await prompt(page, "find Serena documentation");

    const search = page.locator(".web-search").last();
    await expect(search.locator(".web-search-progress")).toContainText("Checking official documentation");
    await expect(search.locator(".web-search-result")).toContainText("Serena - The coding agent toolkit");
    await expect(search.locator(".web-search-result")).toHaveAttribute("href", "https://oraios.github.io/serena/");
  });

  test("makes an aborted provider response visible", async ({ page, request }) => {
    await control(request, { webSearch: true, webSearchAborted: true });
    await prompt(page, "find Serena documentation");

    const search = page.locator(".web-search").last();
    await expect(search.locator(".web-search-status")).toHaveText("Interrupted");
    await expect(search.locator(".web-search-error-text")).toHaveText("Step interrupted");
  });
});

test.describe("tool images", () => {
  // The seeded transcript carries a `read` of a PNG with the real tool's
  // content shape (text sentinel + file block with a data URI).
  test("a stored image read renders the image inline beneath the tool row", async ({ page }) => {
    const img = page.locator(".tool-image img");
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(img).toHaveAttribute("alt", /screenshot\.png/);
    // The row itself stays a collapsed <details> — the image is not hidden
    // inside it.
    const row = page.locator(".tool", { has: page.locator(".tool-name", { hasText: "read" }) });
    await expect(row).toHaveCount(1);
    await expect(row).not.toHaveAttribute("open", "");
  });

  test("a live image read renders as the call settles", async ({ page, request }) => {
    await request.post("http://127.0.0.1:4096/api/mock/control", { data: { readImage: true } });
    await page.locator("textarea").fill("look at this png");
    await page.locator("textarea").press("Enter");

    // The seeded transcript already has one image read; this adds a second.
    const imgs = page.locator(".tool-image img");
    await expect(imgs).toHaveCount(2);
    await expect(imgs.last()).toHaveAttribute("src", /^data:image\/png;base64,/);
  });
});

test.describe("FindBar", () => {
  test("Ctrl+Shift+F opens it and counts matches", async ({ page }) => {
    await expect(page.locator(".find-bar")).toHaveCount(0);
    await page.keyboard.press("Control+Shift+F");
    await expect(page.locator(".find-bar")).toBeVisible();

    await page.locator(".find-input").fill("const");
    await expect(page.locator(".find-count")).toHaveText("1 / 2");

    await page.keyboard.press("Escape");
    await expect(page.locator(".find-bar")).toHaveCount(0);
  });

  // The highlight names in find-bar.css drifted from the ones FindBar.vue
  // registers (`pi-` vs `oc-`) and nothing caught it: an unmatched highlight
  // name throws no error and logs no warning — the matches simply never get
  // coloured, while the count keeps working. Assert the two agree.
  test("registers highlights under names the stylesheet actually targets", async ({ page }) => {
    await page.keyboard.press("Control+Shift+F");
    await page.locator(".find-input").fill("const");
    await expect(page.locator(".find-count")).toContainText("/");

    const { registered, styled } = await page.evaluate(() => ({
      registered: [...CSS.highlights.keys()],
      styled: [...document.styleSheets]
        .flatMap((sheet) => {
          try {
            return [...sheet.cssRules];
          } catch {
            return []; // cross-origin sheet
          }
        })
        .map((rule) => (rule.selectorText || "").match(/::highlight\(([^)]+)\)/))
        .filter(Boolean)
        .map((m) => m[1].trim()),
    }));

    expect(registered.length).toBeGreaterThan(0);
    for (const name of registered) expect(styled).toContain(name);
  });
});

test.describe("ShortcutsDialog", () => {
  test("opens on ? and from the header button", async ({ page }) => {
    await page.keyboard.press("?");
    await expect(page.locator(".shortcuts")).toContainText("Find in this chat");
    await page.keyboard.press("Escape");
    await expect(page.locator(".shortcuts")).toHaveCount(0);

    await page.locator(".header-shortcuts").click();
    await expect(page.locator(".shortcuts")).toBeVisible();
  });

  test("a ? typed into the composer stays in the composer", async ({ page }) => {
    await page.locator("textarea").type("why?");
    await expect(page.locator(".shortcuts")).toHaveCount(0);
    await expect(page.locator("textarea")).toHaveValue("why?");
  });
});
