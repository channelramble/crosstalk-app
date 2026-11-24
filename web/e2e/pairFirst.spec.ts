import { test, expect } from "./fixtures";

// The pairing screen (web/src/views/Pairing.tsx) opened by a pairing link, as the QR code under `crosstalk-hub pair`
// opens it: the code is filled in; in Safari on an iPhone it says to add Crosstalk to the Home Screen first.

const APP = "http://127.0.0.1:5198";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";

test("a pairing link fills the code in; on an iPhone in Safari it says to make it an app first, with the code to type there", async ({ browser }) => {
  // A device that has never been paired.
  const phone = await browser.newContext({ userAgent: IPHONE, storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });
  try {
    const page = await phone.newPage();
    await page.goto(`${APP}/#pair=ABCD-EFGH`);
    await expect(page.getByRole("textbox", { name: "Pairing code" })).toHaveValue("ABCD-EFGH");
    const first = page.getByRole("note");
    await expect(first).toContainText("On an iPhone, make it an app first.");
    await expect(first).toContainText("Add to Home Screen");
    await expect(first).toContainText("ABCD-EFGH");
    if (process.env.CT_SHOTS) await page.screenshot({ path: `${process.env.CT_SHOTS}/pair-first.png` });
    // It can still be paired right here.
    await expect(page.getByRole("button", { name: "Pair this device", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Any other browser: the code, and no such note.
    const plain = await other.newPage();
    await plain.goto(`${APP}/#pair=WXYZ-2345`);
    await expect(plain.getByRole("textbox", { name: "Pairing code" })).toHaveValue("WXYZ-2345");
    await expect(plain.getByRole("note")).toHaveCount(0);
  } finally {
    await phone.close();
    await other.close();
  }
});
