// src/test/regression.ts
// 실행: npx ts-node src/test/regression.ts (또는 StackBlitz 터미널)
import { runOnce } from "../logic/router"; // <- 사용 중인 엔트리 함수에 맞춰 수정
import fs from "node:fs";

type Meta = {
  path?: "RAG" | "OpenDomain" | "Fallback";
  model?: string;
  rewriteApplied?: boolean;
  topScore?: number;
  retrievedIds?: string[];
  primaryUrl?: string;
  tokens?: string; // "in/out" 같은 요약
};
type Resp = { text: string; meta?: Meta };

const TESTS: { q: string; gold?: string }[] = [
  // TODO: faq.json의 기준 50 + 각 묶음 유사 1개 (총 100개)로 채워주세요.
];

(async () => {
  const out: any[] = [];
  for (let i = 0; i < TESTS.length; i++) {
    const { q, gold } = TESTS[i];
    const t0 = Date.now();
    try {
      const r: Resp = await runOnce(q); // ← 프로젝트 실제 호출 시그니처에 맞춰 수정
      const ms = Date.now() - t0;
      out.push({
        No: i + 1,
        Query: q,
        "Expected (Gold)": gold ?? "",
        "Path (RAG/OpenDomain/Fallback)": r.meta?.path ?? "",
        Model: r.meta?.model ?? "",
        "Rewrite Applied": r.meta?.rewriteApplied ?? "",
        TopScore: r.meta?.topScore ?? "",
        "Retrieved IDs/Refs": (r.meta?.retrievedIds ?? []).join("|"),
        "Primary URL": r.meta?.primaryUrl ?? "",
        "Response (Raw)": r.text,
        "Tokens (in/out)": r.meta?.tokens ?? "",
        "Latency_ms": ms,
        "Label (Good/Partial/Bad/Fallback)": "",
        "Error Type (if any)": "",
        "Root Cause (expr/data/prompt/threshold/infra)": "",
        "Fix Type (rewrite/data/prompt/threshold/other)": "",
        "Action Detail": "",
        Owner: "",
        "Status (todo/done)": "todo",
        Notes: ""
      });
      process.stdout.write(`.${(i+1)%50===0?`\n(${i+1})`:''}`);
    } catch (e: any) {
      out.push({
        No: i + 1, Query: q, "Expected (Gold)": gold ?? "",
        "Response (Raw)": `ERROR: ${e?.message || String(e)}`,
        "Latency_ms": Date.now() - t0,
        "Label (Good/Partial/Bad/Fallback)": "Bad",
        "Error Type (if any)": "exception",
        "Root Cause (expr/data/prompt/threshold/infra)": "infra",
        Owner: "", "Status (todo/done)": "todo", Notes: "Check logs"
      });
      process.stdout.write("E");
    }
  }
  fs.writeFileSync("R1_results.json", JSON.stringify(out, null, 2));
  console.log("\n✅ Saved: R1_results.json (엑셀 R1_Log에 붙여넣어 집계하세요)");
})();
