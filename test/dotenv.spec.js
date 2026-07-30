// lib/dotenv.js — the .env parsing behind the TrueFoundry PAT read-through.
//
// A pure module with no DOM, so it's exercised by importing it straight from
// the Vite dev server rather than by driving a component. The cases here are
// the ones that would silently hand a *wrong* token to the gateway, which fails
// with an auth error that points nowhere near the actual cause.
import { expect, test } from "@playwright/test";

async function parse(page, text) {
  return page.evaluate(
    (src) => import("/src/lib/dotenv.js").then((m) => m.parseEnv(src)),
    text
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
});

test("reads a plain assignment", async ({ page }) => {
  expect(await parse(page, "TRUEFOUNDRY_API_KEY=abc123")).toEqual({
    TRUEFOUNDRY_API_KEY: "abc123",
  });
});

test("ignores comments and blank lines", async ({ page }) => {
  const env = await parse(page, "# a comment\n\nA=1\n   \n#B=2\n");
  expect(env).toEqual({ A: "1" });
});

test("accepts `export` prefixes", async ({ page }) => {
  // .env files are often sourced as well as read.
  expect(await parse(page, "export TRUEFOUNDRY_API_KEY=xyz")).toEqual({
    TRUEFOUNDRY_API_KEY: "xyz",
  });
});

test("strips surrounding quotes but keeps what's inside", async ({ page }) => {
  // A JWT-ish token contains dots and dashes; quoting it is common and the
  // quotes must not survive into the Authorization header.
  const env = await parse(page, `A="ey.J-h_b"\nB='ey.J-h_b'`);
  expect(env).toEqual({ A: "ey.J-h_b", B: "ey.J-h_b" });
});

test("keeps a # inside a quoted value", async ({ page }) => {
  // Truncating here would produce a token that looks plausible and is wrong.
  expect(await parse(page, 'A="tok#en"')).toEqual({ A: "tok#en" });
});

test("drops a trailing comment from an unquoted value", async ({ page }) => {
  expect(await parse(page, "A=token # the pat")).toEqual({ A: "token" });
});

test("skips malformed lines rather than inventing keys", async ({ page }) => {
  const env = await parse(page, "not-an-assignment\n=novalue\n1BAD=x\nGOOD=y");
  expect(env).toEqual({ GOOD: "y" });
});

test("later duplicates win, as a shell sourcing the file would", async ({ page }) => {
  expect(await parse(page, "A=first\nA=second")).toEqual({ A: "second" });
});
