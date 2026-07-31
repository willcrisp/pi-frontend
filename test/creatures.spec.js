// The menagerie: tokens decide the stage, work decides the branch.
//
// Driven against the mock's `creatureHistory` fixture, which is laid out to grow
// one deliberate lineage (see the comment on CREATURE_SESSIONS in
// mock-opencode.js). That fixture IS the assertion here: if the branching model
// changes, these tests should be re-derived from it rather than relaxed.
import { expect, test } from "@playwright/test";

const MOCK = "http://127.0.0.1:4096";
const ATLAS = "/home/user/atlas";

async function openMenagerie(page, seed = { creatureHistory: true }) {
  await page.request.post(`${MOCK}/api/mock/control`, { data: seed });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await page.locator(".creature-chip").click();
  const dialog = page.locator(".connect-panel").filter({ hasText: "Menagerie" }).first();
  await dialog.waitFor();
  return dialog;
}

test.afterEach(async ({ page }) => {
  await page.request.post(`${MOCK}/api/mock/control`, {
    data: { creatureHistory: false, richHistory: false },
  });
});

test("branches on the work that fed each stage, in order", async ({ page }) => {
  const dialog = await openMenagerie(page);
  await dialog.locator("select").selectOption(ATLAS);

  // 3.3m tokens is stage 4, and the fixture fed it frontend, then security,
  // then data, then testing — one per stage, in that order.
  await expect(dialog.locator(".mg-sub").first()).toContainText("Elder");
  await expect(dialog.locator(".mg-path")).toHaveText("frontend › security › data › testing");
  await expect(dialog.locator(".mg-link-branch")).toHaveText([
    "Frontend",
    "Security",
    "Data",
    "Testing",
  ]);
});

test("the branch preview points at current work, not the session that triggered the last evolution", async ({
  page,
}) => {
  const dialog = await openMenagerie(page);
  await dialog.locator("select").selectOption(ATLAS);

  // Regression: a session spanning a threshold used to be credited WHOLE to the
  // stage it ended in, so the 500k testing session that caused this creature's
  // last evolution outweighed every docs session since — and the preview said
  // "branching testing" for a project that had been writing docs for a
  // fortnight. Tokens are now split at the boundary in proportion.
  await expect(dialog.locator(".mg-branches li").first()).toContainText("Docs");
  await expect(dialog.locator(".mg-branches li.leading")).toContainText("Docs");
});

test("a project under the first threshold is still an egg", async ({ page }) => {
  const dialog = await openMenagerie(page, { creatureHistory: true, richHistory: true });

  // /home/user/notes has 19k tokens across two sessions — below the 25k first
  // evolution, so it has a lineage of nothing and reads as an egg rather than
  // as a missing creature.
  await dialog.locator("select").selectOption("/home/user/notes");
  await expect(dialog.locator(".mg-name")).toHaveText("Unhatched");
  await expect(dialog.locator(".mg-sub").first()).toContainText("Egg");
  await expect(dialog.locator(".mg-path")).toHaveCount(0);
});

test("the same history always draws the same creature", async ({ page }) => {
  const dialog = await openMenagerie(page);
  await dialog.locator("select").selectOption(ATLAS);
  const before = await dialog.locator(".mg-portrait svg").innerHTML();
  const name = await dialog.locator(".mg-name").innerText();

  // Nothing about a creature is persisted — it is re-derived from the session
  // list every time. That is only a good trade if the derivation is exactly
  // reproducible, so: same history, same pixels, across a full reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await page.locator(".creature-chip").click();
  const again = page.locator(".connect-panel").filter({ hasText: "Menagerie" }).first();
  await again.locator("select").selectOption(ATLAS);

  await expect(again.locator(".mg-name")).toHaveText(name);
  expect(await again.locator(".mg-portrait svg").innerHTML()).toBe(before);
  // And it is not an empty box: a deterministic nothing would also pass the
  // comparison above. Faces, not cubes — lib/voxel.js culls every face that has
  // a neighbour, so this is the count of what is actually visible.
  expect(await again.locator(".mg-portrait svg polygon").count()).toBeGreaterThan(20);
});

test("every project gets its own animal", async ({ page }) => {
  const dialog = await openMenagerie(page, { creatureHistory: true, richHistory: true });

  // Four projects in the fixture, four creatures, each with its own sprite.
  const rows = dialog.locator(".mg-row");
  expect(await rows.count()).toBe(4);
  await expect(rows.first()).toContainText("atlas");
  expect(await dialog.locator(".mg-row svg").count()).toBe(4);

  // Each is composited from the named parts its rolls chose, not drawn from a
  // fixed sheet — the whole point of the parts library.
  await expect(dialog.locator(".mg-parts")).toBeVisible();
});
