// The TrueFoundry card in the Providers dialog.
//
// Discovery shells out over a PTY, which the mock server doesn't implement, so
// these tests seed the discovery cache in localStorage instead — the same path
// a returning user hits, and it keeps the test about the selection UI rather
// than about PTY plumbing (see test/mentions.spec.js for the same approach).
//
// The saved gateway is seeded alongside the cache, because the cache is keyed by
// gateway URL and the card only finds it once the field holds the same one. This
// used to work by accident: one deployment's hostname was hardcoded as the
// field's default, so it matched without being set. That default is now empty
// unless VITE_TRUEFOUNDRY_GATEWAY says otherwise, and seeding both halves of the
// returning user's state is the honest version of this fixture anyway.
import { expect, test } from "@playwright/test";

// Any URL works — it only has to be the same on both sides.
const GATEWAY = "https://gateway.example.com";

// Two provider accounts under one broad provider type, plus a second type.
// The duplicated "virtual-model" type is the case that makes grouping by
// account rather than by type matter.
const MODELS = [
  { id: "openai/gpt-5-mini", name: "gpt-5-mini", account: "openai", provider: "openai" },
  { id: "openai/gpt-4.1-mini", name: "gpt-4.1-mini", account: "openai", provider: "openai" },
  {
    id: "general-virtual-models/claude-sonnet-4-6-ha",
    name: "claude-sonnet-4-6-ha",
    account: "general-virtual-models",
    provider: "virtual-model",
  },
  {
    id: "vm-ainchor-mcp/ainchor",
    name: "ainchor",
    account: "vm-ainchor-mcp",
    provider: "virtual-model",
  },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([gateway, models]) => {
      localStorage.setItem(
        "opencode-web:truefoundry-cache",
        JSON.stringify({ [gateway]: { models, fetchedAt: Date.now() } })
      );
      // What the card reads back into its gateway field, and the key the cache
      // above is looked up by (TRUEFOUNDRY_GATEWAY_KEY in lib/truefoundry.js).
      localStorage.setItem("truefoundry.gateway", gateway);
    },
    [GATEWAY, MODELS]
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await page.locator('button[title="Providers"]').click();
});

const card = (page) => page.locator(".tf-card");

test("shows a dedicated TrueFoundry setup", async ({ page }) => {
  await expect(card(page)).toContainText("TrueFoundry");
  await expect(card(page).locator('input[type="url"]')).toHaveValue(GATEWAY);
  await expect(card(page).locator('input[type="password"]')).toHaveAttribute("autocomplete", "off");
});

test("groups the cached catalogue by provider account", async ({ page }) => {
  // Four models, three accounts — grouping by the broad provider type would
  // collapse the two virtual-model accounts into one and make them unselectable
  // apart from each other.
  await expect(card(page).locator(".tf-group")).toHaveCount(3);
  await expect(card(page).locator(".tf-group-name")).toHaveText([
    "general-virtual-models",
    "openai",
    "vm-ainchor-mcp",
  ]);
});

test("selects nothing until asked, and the add button stays disabled", async ({ page }) => {
  // A tenant catalogue runs to hundreds of models; defaulting to "all selected"
  // makes an accidental bulk import one click away.
  await expect(card(page).locator(".tf-count")).toHaveText("0 selected");
  await expect(card(page).getByRole("button", { name: /^Add / })).toBeDisabled();
});

test("a provider account checkbox takes its whole group", async ({ page }) => {
  const openai = card(page).locator(".tf-group").filter({ hasText: "openai" }).first();
  await openai.locator(".tf-group-head input[type=checkbox]").check();

  await expect(card(page).locator(".tf-count")).toHaveText("2 selected");
  await expect(card(page).getByRole("button", { name: "Add 2 selected models" })).toBeEnabled();
});

test("a partly-selected group renders indeterminate, not checked", async ({ page }) => {
  const openai = card(page).locator(".tf-group").filter({ hasText: "openai" }).first();
  await openai.locator(".tf-group-toggle").click(); // expand
  await openai.locator(".tf-models input[type=checkbox]").first().check();

  const group = openai.locator(".tf-group-head input[type=checkbox]");
  await expect(group).not.toBeChecked();
  // The tri-state is the whole point: "some of this account" has to be visibly
  // different from both "none" and "all", or a partial selection reads as empty.
  await expect(group).toHaveJSProperty("indeterminate", true);
});

test("search filters across accounts and expands the matches", async ({ page }) => {
  await card(page).locator('input[type="search"]').fill("ainchor");

  await expect(card(page).locator(".tf-group")).toHaveCount(1);
  // A match inside a collapsed group would look like no match at all, so a
  // search expands what it finds.
  await expect(card(page).locator(".tf-model")).toHaveCount(1);
  await expect(card(page).locator(".tf-model-id")).toHaveText("vm-ainchor-mcp/ainchor");
});

test("clear drops the selection", async ({ page }) => {
  await card(page).getByRole("button", { name: "Select all" }).click();
  await expect(card(page).locator(".tf-count")).toHaveText("4 selected");

  await card(page).getByRole("button", { name: "Clear" }).click();
  await expect(card(page).locator(".tf-count")).toHaveText("0 selected");
});
