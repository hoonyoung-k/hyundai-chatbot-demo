// src/test/runBatch.browser.ts
// 브라우저에서 __ask로 100문을 실행하고 CSV/JSON/Summary를 "다운로드"합니다.

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

// 1) download 함수: BOM 옵션 지원
function download(filename: string, text: string, mime = "text/plain;charset=utf-8", withBOM = false) {
  const bom = withBOM ? "\uFEFF" : "";
  const blob = new Blob([bom + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}


export async function runBatchBrowser() {
  if (typeof (window as any).__ask !== "function") {
    console.warn("__ask 가 아직 준비되지 않았습니다. (Dev 서버/iframe 콘솔 확인)");
    return;
  }

  // ✅ public/에서 읽음 (위에서 복사한 파일)
  const res = await fetch("/testset.r1.json");
  const set: { q: string; gold?: string; intentGroup?: string }[] = await res.json();

  const out: Row[] = [];
  for (let i = 0; i < set.length; i++) {
    const { q, gold, intentGroup } = set[i];
    const t0 = performance.now();
    try {
      const r = await (window as any).__ask(q); // { text, meta }
      const ms = Math.round(performance.now() - t0);
      const m = (r && (r.meta || r.__meta)) || {};

      out.push({
        No: i + 1,
        Query: q,
        "Intent Group": intentGroup ?? "",
        "Expected (Gold)": gold ?? "",
        "Path (RAG/OpenDomain/Fallback)": m.path ?? "",
        Model: m.model ?? "",
        "Rewrite Applied": m.rewriteApplied ?? "",
        TopScore: m.topScore ?? "",
        "Retrieved IDs/Refs": Array.isArray(m.retrievedIds) ? m.retrievedIds.join("|") : "",
        "Primary URL": m.primaryUrl ?? "",
        "Response (Raw)": r?.text ?? "",
        "Tokens (in/out)": m.tokens ?? "",
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
      if ((i + 1) % 10 === 0) console.log(`[${i + 1}/${set.length}]`);
      await new Promise(r => setTimeout(r, 120)); // 과호출 방지
    } catch (e: any) {
      out.push({
        No: i + 1, Query: q, "Intent Group": intentGroup ?? "", "Expected (Gold)": gold ?? "",
        "Path (RAG/OpenDomain/Fallback)": "", Model: "", "Rewrite Applied": "",
        TopScore: "", "Retrieved IDs/Refs": "", "Primary URL": "",
        "Response (Raw)": `ERROR: ${e?.message || String(e)}`,
        "Tokens (in/out)": "", "Latency_ms": Math.round(performance.now() - t0),
        "Label (Good/Partial/Bad/Fallback)": "Bad", "Error Type (if any)": "exception",
        "Root Cause (expr/data/prompt/threshold/infra)": "infra",
        "Fix Type (rewrite/data/prompt/threshold/other)": "", "Action Detail": "Check console",
        Owner: "", "Status (todo/done)": "todo", Notes: ""
      });
    }
  }

  // 저장: JSON
  download("R1_results.json", JSON.stringify(out, null, 2), "application/json");

  // 저장: CSV
  const headers = Object.keys(out[0] || { No: "", Query: "" });
  const csv = [headers.join(",")]
    .concat(out.map(row => headers.map(h => {
      const v = (row as any)[h] ?? "";
      return `"${String(v).replaceAll('"','""').replaceAll('\n',' ').replaceAll('\r',' ')}"`;
    }).join(",")))
    .join("\n");

  // ⬇️ 여기서 withBOM = true 로 다운로드
  download("R1_results.csv", csv, "text/csv;charset=utf-8", true);

  // 저장: summary
  const total = out.length || 1;
  const good = out.filter(r => r["Label (Good/Partial/Bad/Fallback)"] === "Good").length;
  const partial = out.filter(r => r["Label (Good/Partial/Bad/Fallback)"] === "Partial").length;
  const bad = out.filter(r => r["Label (Good/Partial/Bad/Fallback)"] === "Bad").length;
  const fallback = out.filter(r => r["Label (Good/Partial/Bad/Fallback)"] === "Fallback").length;
  const lat = out.map(r => r["Latency_ms"]).filter(n => typeof n === "number") as number[];
  const mean = Math.round(lat.reduce((a,b)=>a+b,0) / Math.max(lat.length,1));
  const p = (arr:number[], q:number) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a,b)=>a-b);
    const idx = Math.floor((s.length-1) * q);
    return s[idx];
  };
  const summary = `# R1 Summary
- Total: ${total}
- Good/Partial/Bad/Fallback: ${good}/${partial}/${bad}/${fallback}
- Success Rate: ${(((good+partial)/total)*100).toFixed(1)}%
- Hallucination Rate: ${((bad/total)*100).toFixed(1)}%
- Latency(ms): avg=${mean}, p50=${p(lat,0.5)}, p95=${p(lat,0.95)}
- Path Dist: RAG=${out.filter(r=>r["Path (RAG/OpenDomain/Fallback)"]==="RAG").length}, OpenDomain=${out.filter(r=>r["Path (RAG/OpenDomain/Fallback)"]==="OpenDomain").length}, Fallback=${out.filter(r=>r["Path (RAG/OpenDomain/Fallback)"]==="Fallback").length}
`;
  download("summary.md", summary, "text/markdown;charset=utf-8");

  console.log("✅ Done. R1_results.csv/json & summary.md downloaded.");
}

// Dev에서 전역 노출
if (typeof window !== "undefined") {
  (window as any).__runBatch = runBatchBrowser;
}
