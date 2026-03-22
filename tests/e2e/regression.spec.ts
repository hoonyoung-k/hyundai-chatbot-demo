/**
 * 필수 회귀: 핵심 차량/인물/브랜드 RAG + OOD fallback
 * 실패 시: 입력 / assert 이름 / 기대값이 expect 메시지에 포함됩니다.
 */
import { test, expect } from "@playwright/test";

/** 일반적인 RAG fallback/학습중 응답 패턴 (이면 실패로 간주) */
const FALLBACK_LIKE =
  /제공된 정보만으로는|아직 학습 중이에요|안내 범위를 벗어난|골라보시겠어요|현대자동차 관련 질문을 주시면/;

const BUTTON_GUIDE_IN_TEXT =
  /공식\s*안내\s*보기\s*버튼|자세히\s*보기|공식\s*안내(?:를)?\s*확인해\s*주세요/;

/** 범위 밖 질문은 fallback 성격이어야 함 */
const EXPECT_FALLBACK =
  /제공된 정보만으로는|아직 학습 중|안내 범위를 벗어난|골라보시겠어요|현대자동차 관련 질문을 주시면|차량·서비스 관련/;

async function collectNewBotTexts(page: import("@playwright/test").Page, beforeCount: number) {
  await expect
    .poll(async () => page.locator(".flex.justify-start .rounded-2xl").count(), {
      timeout: 120_000,
    })
    .toBeGreaterThan(beforeCount);
  const all = await page.locator(".flex.justify-start .rounded-2xl").allTextContents();
  return all.slice(beforeCount).join("\n").trim();
}

async function sendAndGetBotReply(page: import("@playwright/test").Page, query: string) {
  const before = await page.locator(".flex.justify-start .rounded-2xl").count();
  const input = page.getByPlaceholder("메시지를 입력하세요…");
  await input.fill(query);
  await input.press("Enter");
  return collectNewBotTexts(page, before);
}

test.describe.configure({ mode: "serial" });

test.describe("회귀 QA", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  const vehicleQueries = ["소나타", "쏘나타", "아반떼n", "g 80", "gv70"];
  for (const q of vehicleQueries) {
    test(`[차량] ${q}`, async ({ page }) => {
      const text = await sendAndGetBotReply(page, q);
      await expect.soft(text, `[${q}] fallback 아님`).not.toMatch(FALLBACK_LIKE);
      await expect.soft(text, `[${q}] 버튼 유도 문구 없음`).not.toMatch(BUTTON_GUIDE_IN_TEXT);
      const sticky = await page.locator("button.hd-btn--primary.w-full").count();
      await expect.soft(sticky, `[${q}] sticky CTA 없음`).toBe(0);
    });
  }

  const people = ["정주영", "정몽구", "정의선"];
  for (const q of people) {
    test(`[인물] ${q}`, async ({ page }) => {
      const text = await sendAndGetBotReply(page, q);
      await expect.soft(text, `[${q}] fallback 아님`).not.toMatch(FALLBACK_LIKE);
      await expect.soft(text, `[${q}] 버튼 유도 문구 없음`).not.toMatch(BUTTON_GUIDE_IN_TEXT);
      const sticky = await page.locator("button.hd-btn--primary.w-full").count();
      await expect.soft(sticky, `[${q}] sticky CTA 없음`).toBe(0);
    });
  }

  test("[브랜드] 제네시스", async ({ page }) => {
    const q = "제네시스";
    const text = await sendAndGetBotReply(page, q);
    await expect.soft(text, `[${q}] fallback 아님`).not.toMatch(FALLBACK_LIKE);
    const sticky = await page.locator("button.hd-btn--primary.w-full").count();
    await expect.soft(sticky, `[${q}] sticky CTA 없음`).toBe(0);
  });

  const ood = ["비트코인 시세", "오늘 날씨"];
  for (const q of ood) {
    test(`[OOD] ${q}`, async ({ page }) => {
      const text = await sendAndGetBotReply(page, q);
      await expect(text, `[${q}] fallback 유지`).toMatch(EXPECT_FALLBACK);
    });
  }
});
