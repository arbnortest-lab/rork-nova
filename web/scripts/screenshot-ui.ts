/**
 * Captures the dashboard across viewport widths from a running preview and
 * reports horizontal overflow and runtime errors.
 *
 *   (bun x vite preview --port 4173 --strictPort &) && bun scripts/screenshot-ui.ts [outDir] [baseUrl]
 *
 * Signs in with the demo credentials, then shoots the main page in its
 * default state and with the settings dialog open on each of its tabs.
 * Full-page captures so nothing below the fold is missed. Output defaults
 * to /tmp/shots.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Page } from "playwright";

const OUT = process.argv[2] ?? "/tmp/shots";
const BASE = process.argv[3] ?? "http://localhost:4173";

const VIEWPORTS = [
  { name: "phone-360", width: 360, height: 780 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "laptop-1024", width: 1024, height: 768 },
  { name: "desktop-1280", width: 1280, height: 800 },
  { name: "desktop-1440", width: 1440, height: 900 },
] as const;

const SETTINGS_TABS = ["Gates", "Alerts", "Radar", "On-chain"] as const;

async function signIn(page: Page): Promise<void> {
  await page.goto(BASE, { waitUntil: "networkidle" });
  const user = page.locator("#login-user");
  if (await user.count()) {
    await user.fill("Admin");
    await page.locator("#login-pass").fill("Lumi1996++");
    await page.keyboard.press("Enter");
    await page.waitForSelector("text=Liquidity Exhaustion Engine", { timeout: 15_000 });
  }
}

/** Pixels the document scrolls sideways; anything above zero is a layout bug. */
async function overflowOf(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Elements whose right edge pokes past the viewport, for diagnosis. */
async function offenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.right > limit && r.width > 0) {
        const cls = (el.getAttribute("class") ?? "").slice(0, 80);
        out.push(`${el.tagName.toLowerCase()}.${cls} right=${Math.round(r.right)}`);
      }
      if (out.length >= 12) break;
    }
    return out;
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const errors: string[] = [];
  let bad = 0;

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`${vp.name}: ${e.message}`));
    page.on("console", (m) => {
      // CORS-blocked REST calls from localhost are an environment limit, not an app error.
      if (m.type() === "error" && !/CORS|ERR_FAILED/.test(m.text())) errors.push(`${vp.name} console: ${m.text()}`);
    });

    await signIn(page);
    await page.waitForTimeout(2500);

    const overflow = await overflowOf(page);
    console.log(`${vp.name}: main overflow ${overflow}px`);
    if (overflow > 0) {
      bad += 1;
      for (const line of await offenders(page)) console.log(`    ${line}`);
    }
    await page.screenshot({ path: join(OUT, `${vp.name}-main.png`), fullPage: true });

    const settings = page.getByRole("button", { name: "Settings" }).first();
    if (await settings.count()) {
      await settings.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 5000 });
      for (const tab of SETTINGS_TABS) {
        await page.getByRole("tab", { name: tab }).click();
        await page.waitForTimeout(250);
        const dialogOverflow = await dialog.evaluate((el) => {
          const panel = el.querySelector<HTMLElement>('[role="tabpanel"]');
          return panel ? panel.scrollWidth - panel.clientWidth : 0;
        });
        if (dialogOverflow > 0) {
          bad += 1;
          console.log(`${vp.name}: settings/${tab} overflow ${dialogOverflow}px`);
        }
        await page.screenshot({ path: join(OUT, `${vp.name}-settings-${tab.toLowerCase()}.png`), fullPage: false });
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      if (await dialog.count()) {
        bad += 1;
        console.log(`${vp.name}: dialog did not close on Escape`);
      }
    } else {
      bad += 1;
      console.log(`${vp.name}: Settings button not found`);
    }

    await context.close();
  }

  await browser.close();
  if (errors.length) {
    console.log("Runtime errors:");
    for (const e of errors) console.log(`  ${e}`);
  } else {
    console.log("No runtime errors.");
  }
  console.log(bad === 0 ? "Layout OK at every width." : `${bad} layout problem(s).`);
  process.exit(bad === 0 && errors.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
