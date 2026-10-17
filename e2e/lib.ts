import { test as base, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

export type Account = { runId: string; email: string; password: string; name: string };
export const account = (): Account => JSON.parse(readFileSync(new URL("./.run/account.json", import.meta.url), "utf8"));

/** Every test fails on any uncaught page error. */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await use(errors);
      expect(errors, "uncaught page errors").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** Same-origin API call from the signed-in page (session cookie + the client header). */
export async function api(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ([path, method, body]) => {
      const r = await fetch(path, {
        method,
        headers: { "content-type": "application/json", "x-linguini-client": "1" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await r.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: r.status, text, json: json as any };
    },
    [path, method, body] as const,
  );
}

export const composer = (page: Page) => page.locator('[aria-label="Message"]:visible').first();
export const STOP = '[aria-label="Stop generation"]';

/** Types like a person (fast machine typing trips React's update-depth guard in upstream's composer). */
export async function send(page: Page, text: string, opts: { tap?: boolean } = {}) {
  const box = composer(page);
  await box.waitFor({ timeout: 60_000 });
  if (opts.tap) await box.tap();
  else await box.click();
  await page.keyboard.type(text, { delay: 40 });
  if (opts.tap) await page.locator('button[type="submit"]:visible').last().tap();
  else await page.keyboard.press("Enter");
}

type Conversation = { id: string; jobs: Array<{ id: string; status: string }>; events: Array<{ type: string; data?: unknown }> };
export async function conversations(page: Page): Promise<Conversation[]> {
  const list = (await api(page, "/api/conversations")).json as Array<{ id: string }>;
  const out: Conversation[] = [];
  for (const c of list) out.push((await api(page, `/api/conversations/${c.id}`)).json);
  return out;
}

/** Waits until some conversation has a completed reply matching `re`; returns its id. */
export async function waitForReply(page: Page, re: RegExp, timeoutMs = 180_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const c of await conversations(page))
      if (c.events.some((e) => e.type === "assistant.completed" && re.test(JSON.stringify(e.data ?? ""))))
        return c.id;
    await page.waitForTimeout(2000);
  }
  throw new Error(`no completed reply matching ${re}`);
}

/** Status chips upstream draws under messages whose item status isn't "completed". */
export const STATUSES = ["running", "pending", "waiting", "failed", "cancelled", "interrupted", "queued", "starting"];
export async function probe(page: Page) {
  return page.evaluate((statuses) => {
    const chips = [...document.querySelectorAll("span.rounded-full")]
      .map((s) => s.textContent?.trim() ?? "")
      .filter((t) => statuses.includes(t));
    return {
      chips,
      working: /Working for/.test(document.body.innerText),
      stop: !!document.querySelector('[aria-label="Stop generation"]'),
    };
  }, STATUSES);
}

export async function signIn(page: Page, a: Account) {
  await page.goto("/");
  await page.waitForSelector(".lg-auth-card");
  await page.fill('input[name="email"]', a.email);
  await page.fill('input[name="password"]', a.password);
  await page.click('button[type="submit"]');
  await composer(page).waitFor({ timeout: 60_000 });
}

/** Opens a conversation from the sidebar (direct links need the environment prefix). */
export async function openConversation(page: Page, title: RegExp) {
  await page.goto("/");
  await composer(page).waitFor({ timeout: 60_000 });
  await page.getByText(title).first().click();
}
