import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PASSWORD } from "./fixture.js";

test("browse, unlock, and download an original", async ({ page }) => {
  await page.goto("/");

  // The home page shows only the curated set.
  await expect(page.locator("h1")).toHaveText("Selected work");
  await expect(page.locator("figure")).toHaveCount(1);

  // The month rail leads to the full archive.
  await page.getByRole("link", { name: /Browse all/ }).click();
  await page.getByRole("link", { name: /\(2\)/ }).click();
  await expect(page.locator("figure")).toHaveCount(2);

  // Opening a photo is linkable.
  await page.locator("figure a").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(page.url()).toMatch(/photo=/);

  // A wrong password fails fast and downloads nothing.
  await page.getByLabel(/Have the password/).fill("not the password");
  await page.getByRole("button", { name: "Unlock originals" }).click();
  await expect(page.getByText("That password is not right.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download original" })).toHaveCount(0);

  // The right password unlocks.
  await page.getByLabel(/Have the password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock originals" }).click();
  await expect(page.getByRole("button", { name: "Download original" })).toBeVisible();

  // The decrypted bytes match the source file exactly.
  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download original" }).click(),
  ]).then(([d]) => d);

  const saved = await download.path();
  const sourceList = JSON.parse(readFileSync("e2e/.fixture/sources.json", "utf8")) as string[];
  const expectedHashes = sourceList.map((p) =>
    createHash("sha256").update(readFileSync(p)).digest("hex"),
  );
  const actual = createHash("sha256").update(readFileSync(saved!)).digest("hex");
  expect(expectedHashes).toContain(actual);

  // Escape closes and returns to the grid.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// The one assertion a unit test cannot make: jsdom does not enforce CSP.
// The lqip used to ride on an inline `style` attribute, which this page's
// `style-src 'self'` silently drops — so every thumbnail rendered with no
// placeholder at all while the test suite reported it present.
test("the lqip placeholder paints under the shipped CSP", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });

  await page.goto("/?m=2026-03");
  const figure = page.locator("figure").first();
  await expect(figure).toBeVisible();

  const background = await figure.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(background).toMatch(/^url\("?data:image\/jpeg;base64,/);
  // Nothing the page does to paint it trips the policy. (frame-ancestors is
  // ignored in a meta tag by every browser and is reported here for that
  // reason alone; the CloudFront response header is where it takes effect.)
  expect(violations.filter((v) => !/frame-ancestors/.test(v))).toEqual([]);
});

test("the gallery still browses without unlocking", async ({ page }) => {
  await page.goto("/?m=2026-03");
  await expect(page.locator("figure").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Download original" })).toHaveCount(0);
});
