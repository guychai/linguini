import { account, api, composer, expect, signIn, test } from "../lib.ts";

test.describe("auth", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign in, sign out, sign back in", async ({ page }) => {
    const a = account();
    await signIn(page, a);
    expect((await api(page, "/api/session")).status).toBe(200);
    await page.getByText("Sign out").click();
    await page.waitForSelector(".lg-auth-card");
    expect((await api(page, "/api/session")).status).toBe(401);
    await page.fill('input[name="email"]', a.email);
    await page.fill('input[name="password"]', a.password);
    await page.click('button[type="submit"]');
    await composer(page).waitFor({ timeout: 60_000 });
    expect((await api(page, "/api/session")).status).toBe(200);
  });
});

test("admin endpoints are 404 for a normal user", async ({ page }) => {
  await page.goto("/");
  await composer(page).waitFor({ timeout: 60_000 });
  expect((await api(page, "/api/admin/users")).status).toBe(404);
  expect((await api(page, "/api/auth/admin/list-users")).status).toBe(404);
});
