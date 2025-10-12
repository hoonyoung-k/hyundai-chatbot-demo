// src/test/runBatch.ts
// 실행: npx tsx src/test/runBatch.ts

import fs from "node:fs/promises";
import { runOnce } from "../logic/router";

// -------------------------------
// 로컬 라벨러 (Step 1 규칙)
// -------------------------------
type Label = "Good" | "Fair" | "Bad";

function detectHasUrl(html?: string, text?: string) {
  const s = `${html ?? ""}\n${text ?? ""}`;
  const re = /\bhttps?:\/\/[^\s"'<>]+/i;
  return re.test(s);
}

function labelByThreshold(
  topScore: number,
  path?: string,
  html?: string,
  text?: string
): Label {
  const hasUrl = detectHasUrl(html, text);
  if (path === "Fallback") return "Bad";
  if (topScore >= 20 || (topScore >= 15 && hasUrl)) return "Good";
  if ((topScore >= 10 && topScore < 20) || (topScore >= 20 && !hasUrl)) return "Fair";
  return "Bad";
}

// -------------------------------
type Row = {
  No: number;
  Query: string;
  "Intent Group": string;
  "Expected (Gold)": string;
  "Path (RAG/OpenDomain/Fallback)": string;
  Model: string;
  "Rewrite Applied": string | boolean;
  TopScore: number | string;
  "Retrieved IDs/Refs": string;
  "Primary URL": string;
  "Response (Raw)": string;
  "Tokens (in/out)": string;
  "Latency_ms": number;
  "Label (Good/Partial/Bad/Fallback)": string;
  "Error Type (if any)": string;
  "Root Cause (expr/data/prompt/threshold/infra)": string;
  "Fix Type (rewrite/data/prompt/threshold/other)": string;
  "Action Detail": string;
  Owner: string;
  "Status (todo/done)": string;
  Notes: string;
};

async function main() {
  const set = JSON.parse(
    await fs.readFile("src/test/testset.r1.json", "utf-8")
  ) as { q: string; gold?: string; intentGroup?: string }[];

  const out: Row[] = [];
  for (let i = 0; i < set.length; i++) {
    const { q, gold, intentGroup } = set[i];
    const t0 = Date.now();
    try {
      const r = await runOnce(q); // { text, meta }
      const ms = Date.now() - t0;

      const meta = (r as any).meta || {};
      // 0~1 스케일이면 0~100으로 보정
      const raw = Number(meta.topScore ?? 0);
      const topScore = raw <= 1 ? raw * 100 : raw;

      const label: Label = labelByThreshold(topScore, meta.path, undefined, r.text);

      out.push({
        No: i + 1,
        Query: q,
        "Intent Group": intentGroup ?? "",
        "Expected (Gold)": gold ?? "",
        "Path (RAG/OpenDomain/Fallback)": meta.path ?? "",
        Model: meta.model ?? "",
        "Rewrite Applied": meta.rewriteApplied ?? "",
        TopScore: +topScore.toFixed(2),
        "Retrieved IDs/Refs": Array.isArray(meta.retrievedIds)
          ? meta.retrievedIds.join("|")
          : "",
        "Primary URL": meta.primaryUrl ?? "",
        "Response (Raw)": r.text ?? "",
        "Tokens (in/out)": meta.tokens ?? "",
        "Latency_ms": ms,
        "Label (Good/Partial/Bad/Fallback)": label,
        "Error Type (if any)": "",
        "Root Cause (expr/data/prompt/threshold/infra)": "",
        "Fix Type (rewrite/data/prompt/threshold/other)": "",
        "Action Detail": "",
        Owner: "",
        "Status (todo/done)": "todo",
        Notes: "",
      });

      if ((i + 1) % 10 === 0) process.stdout.write(`[${i + 1}] `);
    } catch (e: any) {
      out.push({
        No: i + 1,
        Query: q,
        "Intent Group": intentGroup ?? "",
        "Expected (Gold)": gold ?? "",
        "Path (RAG/OpenDomain/Fallback)": "",
        Model: "",
        "Rewrite Applied": "",
        TopScore: "",
        "Retrieved IDs/Refs": "",
        "Primary URL": "",
        "Response (Raw)": `ERROR: ${e?.message || String(e)}`,
        "Tokens (in/out)": "",
        "Latency_ms": Date.now() - t0,
        "Label (Good/Partial/Bad/Fallback)": "Bad",
        "Error Type (if any)": "exception",
        "Root Cause (expr/data/prompt/threshold/infra)": "infra",
        "Fix Type (rewrite/data/prompt/threshold/other)": "",
        "Action Detail": "Check logs",
        Owner: "",
        "Status (todo/done)": "todo",
        Notes: "",
      });
      process.stdout.write("E ");
    }
  }

  // 1) JSON 저장
  await fs.writeFile("R1_results.json", JSON.stringify(out, null, 2), "utf-8");

  // 2) CSV 저장
  const headers = Object.keys(out[0] || { No: "", Query: "" });
  const csv = [headers.join(",")]
    .concat(
      out.map((row) =>
        headers
          .map((h) => {
            const v = (row as any)[h] ?? "";
            return `"${String(v)
              .replaceAll('"', '""')
              .replaceAll("\n", " ")
              .replaceAll("\r", " ")}"`;
          })
          .join(",")
      )
    )
    .join("\n");
  await fs.writeFile("R1_results.csv", csv, "utf-8");

  // 3) 간단 요약 저장
  const total = out.length || 1;
  const good = out.filter((r) => r["Label (Good/Partial/Bad/Fallback)"] === "Good").length;
  const partial = out.filter((r) => r["Label (Good/Partial/Bad/Fallback)"] === "Partial").length;
  const bad = out.filter((r) => r["Label (Good/Partial/Bad/Fallback)"] === "Bad").length;
  const fallback = out.filter((r) => r["Label (Good/Partial/Bad/Fallback)"] === "Fallback").length;
  const lat = out.map((r) => r["Latency_ms"]).filter((n) => typeof n === "number") as number[];
  const mean = Math.round(lat.reduce((a, b) => a + b, 0) / Math.max(lat.length, 1));
  const p = (arr: number[], q: number) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const idx = Math.floor((s.length - 1) * q);
    return s[idx];
  };
  const summary = `# R1 Summary
- Total: ${total}
- Good/Partial/Bad/Fallback: ${good}/${partial}/${bad}/${fallback}
- Success Rate: ${(((good + partial) / total) * 100).toFixed(1)}%
- Hallucination Rate: ${((bad / total) * 100).toFixed(1)}%
- Latency(ms): avg=${mean}, p50=${p(lat, 0.5)}, p95=${p(lat, 0.95)}
- Path Dist: RAG=${out.filter(r=>r["Path (RAG/OpenDomain/Fallback)"]==="RAG").length}, OpenDomain=${out.filter(r=>r["Path (RAG/OpenDomain/Fallback)"]==="OpenDomain").length}, Fallback=${out.filter(r=>r["Path (RAG/OpenDomain/Fallback)"]==="Fallback").length}
`;
  await fs.writeFile("summary.md", summary, "utf-8");

  console.log("\n✅ Saved: R1_results.json, R1_results.csv, summary.md");
}

main().catch((e) => {
  console.error("runBatch failed:", e);
});
