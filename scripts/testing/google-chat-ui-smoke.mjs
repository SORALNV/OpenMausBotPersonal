export async function checkGoogleChatFixtureUi(base, ownerHeaders) {
  const { chromium } = await import(new URL("../../../GoogleChatExtensionMCP/node_modules/playwright/index.mjs", import.meta.url).href);
  const browser = await chromium.launch({ headless: true });
  const errors = [], failed = [];
  try {
    const page = await browser.newPage({ extraHTTPHeaders: ownerHeaders });
    page.on("pageerror", error => errors.push(error.message.slice(0, 500)));
    page.on("requestfailed", request => failed.push({ path: new URL(request.url()).pathname, reason: request.failure()?.errorText }));
    await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#root")?.childElementCount > 0, undefined, { timeout: 15000 }).catch(() => {});
    const rendered = await page.evaluate(() => Boolean(document.querySelector("#root")?.childElementCount));
    if (!rendered || errors.length) throw new Error(JSON.stringify({ rendered, errors, failed }));
    const profile = page.getByRole("button", { name: /^(You|あなた)$/ });
    await profile.waitFor({ timeout: 10000 }).catch(() => {});
    if (!await profile.count()) throw new Error(JSON.stringify({ rendered, text: (await page.locator("body").innerText()).slice(0, 1200), buttons: await page.getByRole("button").allTextContents() }));
    await profile.click();
    await page.getByRole("menuitem", { name: /^(Settings|設定)$/ }).click();
    await page.getByText("連絡管理人が新たな対応の必要性を判定し、必要なときだけ短く通知します。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "通知先を登録・状態確認", exact: true }).waitFor();
    await page.getByText(/通知先登録済み／監視状態: OK/).waitFor();
    if (errors.length) throw new Error(JSON.stringify({ rendered, errors, failed }));
    return { rendered, settingsLoaded: true, personalActionPolicyShown: true, registrationSeparateFromReadiness: true, pageErrors: errors.length };
  } finally { await browser.close(); }
}
