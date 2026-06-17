import React, { useState, useRef } from "react";
import { MapContainer, TileLayer, CircleMarker, Marker, useMapEvents, useMap } from "react-leaflet";

const SEOUL = [37.55, 126.99];
const color = (pct) => `hsl(${(1 - pct) * 220}, 85%, 50%)`; // 백분위 높음=빨강

// ★렌더 절제: 화면 영역(bbox) 필지만 — moveend마다 /screen/bbox 조회
function BboxLayer() {
  const [pts, setPts] = useState([]);
  const fetchBbox = (map) => {
    const b = map.getBounds();
    const q = `west=${b.getWest()}&south=${b.getSouth()}&east=${b.getEast()}&north=${b.getNorth()}&limit=1500`;
    if (map.getZoom() < 13) { setPts([]); return; } // 줌 낮으면 생략(통짜 렌더 금지)
    fetch(`/screen/bbox?${q}`).then((r) => r.json()).then((d) => setPts(d.results || []));
  };
  const map = useMapEvents({ moveend: () => fetchBbox(map) });
  return pts.map((p) => (
    <CircleMarker key={p.pnu} center={[p.lat, p.lon]} radius={4} pathOptions={{ color: color(p.score_pct), fillOpacity: 0.6, weight: 0 }} />
  ));
}

function FlyTo({ pos }) {
  const map = useMap();
  if (pos) map.flyTo(pos, 16);
  return null;
}

// 5종 판단 섹션 — 아이콘·부제(위계). LLM/템플릿 본문의 '### 라벨'과 매칭.
const SECTION_META = {
  "될까": { ic: "🏘️", sub: "사업 환경" }, "얼마": { ic: "💰", sub: "시세·계획" },
  "언제": { ic: "⏳", sub: "사업 단계" }, "리스크": { ic: "⚠️", sub: "리스크" },
  "진입": { ic: "🚪", sub: "진입 가능성" },
};

// 본문(### 라벨\n내용)을 섹션 카드로 분해. 태그 없는 깨끗한 문장만 들어온다(백엔드가 제거).
function parseSections(text) {
  if (!text) return [];
  return text.split(/^###\s+/m).map((b) => b.trim()).filter(Boolean).map((blk) => {
    const nl = blk.indexOf("\n");
    return { label: (nl < 0 ? blk : blk.slice(0, nl)).trim(), body: (nl < 0 ? "" : blk.slice(nl + 1)).trim() };
  });
}

// ★상단 히어로 — 한 줄 결론 + 핵심 3칩. in_zone(지정)≠candidate(환경유사) 구분, 신뢰도 병기.
function Hero({ r }) {
  const fe = r.stages?.["예언_환경점수"]?.result;
  const rq = r.stages?.["진단_요건"]?.result;
  const el = r.stages?.["진입_eligibility"]?.result?.["진단_토허"];
  const cls = r.in_zone ? "지정 정비구역" : r.candidate ? "재개발 환경 유사" : "환경 유사 아님";
  const tone = r.in_zone ? "t-desig" : r.candidate ? "t-cand" : "t-none";
  return (
    <div className={`hero ${tone}`}>
      <div className="hero-label">{cls}{r.confidence ? <span className="conf">{r.confidence}</span> : null}</div>
      {r.verdict?.headline && <div className="hero-sub">{r.verdict.headline}</div>}
      <div className="chips">
        <div className="chip"><span className="ck">환경순위</span><span className="cv">{fe ? fe.rank_phrase : "—"}</span></div>
        <div className="chip"><span className="ck">요건</span><span className="cv">{rq?.path ?? "산출 불가"}</span></div>
        <div className="chip"><span className="ck">토허</span><span className="cv">{el ? (el.toheo_applies ? "적용" : "미적용") : "—"}</span></div>
      </div>
    </div>
  );
}

function ReportPanel({ r }) {
  if (!r) return <p className="muted">주소를 입력하면 5종 판단 리포트가 나옵니다.</p>;
  if (r.error) return <p style={{ color: "#c00" }}>{r.error}</p>;
  const sections = parseSections(r.report?.report_text);
  const facts = r.report?.source_facts || {};
  return (
    <div className="report">
      <Hero r={r} />
      <div className="cards">
        {sections.map((s, i) => {
          const m = SECTION_META[s.label] || { ic: "•", sub: "" };
          return (
            <div key={i} className="card">
              <div className="card-h"><span className="ic">{m.ic}</span><b>{s.label}</b><span className="card-sub">{m.sub}</span></div>
              <div className="card-b">{s.body}</div>
            </div>
          );
        })}
      </div>
      {/* ★출처는 화면에서 빼되 메타로 보존 — 클릭하면 표시값(키→값) 확인(정직성 장치 유지) */}
      <details className="src">
        <summary>출처·근거 ({Object.keys(facts).length})</summary>
        <table className="src-t"><tbody>{Object.entries(facts).map(([k, v]) => (
          <tr key={k}><td>{k}</td><td>{v}</td></tr>))}</tbody></table>
      </details>
      {/* ★caveat도 사용자 언어 번역본(caveats_user) — 내부코드 R##·§ 노출 금지, 접힘 유지 */}
      <details>
        <summary>한계·주의 ({r.report?.caveats_user?.length || 0})</summary>
        <ul>{(r.report?.caveats_user || []).map((c, i) => <li key={i}>{c}</li>)}</ul>
      </details>
      <div className="muted">추정·참고치 · 투자 권유 아님</div>
    </div>
  );
}

function Screener({ onPick }) {
  const [gu, setGu] = useState("11440");
  const [minPct, setMinPct] = useState(0.9);
  const [items, setItems] = useState([]);
  const run = () => fetch(`/screen?gu=${gu}&min_pct=${minPct}&top_k=30`).then((r) => r.json()).then((d) => setItems(d.results || []));
  return (
    <div>
      <div className="filters">
        <select value={gu} onChange={(e) => setGu(e.target.value)}>
          <option value="11290">성북</option><option value="11590">동작</option>
          <option value="11380">은평</option><option value="11530">구로</option>
          <option value="11440">마포</option><option value="11680">강남</option>
        </select>
        <input type="number" step="0.05" min="0" max="1" value={minPct} onChange={(e) => setMinPct(e.target.value)} />
        <button onClick={run}>검색</button>
      </div>
      {items.map((it) => (
        <div key={it.pnu} className="screen-item" onClick={() => onPick([it.lat, it.lon])}>
          …{it.pnu.slice(-8)} · 점수 {it.score.toFixed(3)} · 상위 {(100 * (1 - it.score_pct)).toFixed(0)}%
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("search");
  const [addr, setAddr] = useState("성북구 정릉동 170-1");
  const [report, setReport] = useState(null);
  const [pos, setPos] = useState(null);
  const search = () => {
    setReport({ loading: true });
    /* ★stage 하드코딩 금지(누수 경로) — 실제 단계를 모르면 보내지 않는다. in_zone+stage일 때만 '언제' 출력 */
    fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: addr, property_type: "다세대" }) })
      .then((r) => r.json())
      .then((r) => { setReport(r); if (r.lat) setPos([r.lat, r.lon]); })
      .catch((e) => setReport({ error: String(e) }));
  };
  return (
    <div className="app">
      <div className="panel">
        <h2>재개발 투자 판단</h2>
        <div className="tabs">
          <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>주소 검색</button>
          <button className={tab === "screener" ? "active" : ""} onClick={() => setTab("screener")}>스크리너</button>
        </div>
        {tab === "search" ? (
          <>
            <div className="search">
              <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="지번 주소 (예: 성북구 정릉동 170-1)" />
              <button onClick={search}>판단</button>
            </div>
            {report?.loading ? <p className="muted">분석 중…</p> : <ReportPanel r={report} />}
          </>
        ) : (
          <Screener onPick={setPos} />
        )}
      </div>
      <div className="map">
        <MapContainer center={SEOUL} zoom={12} style={{ height: "100%" }}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
          <BboxLayer />
          {pos && <Marker position={pos} />}
          <FlyTo pos={pos} />
        </MapContainer>
        <div className="legend">색 = 환경 점수 백분위 (빨강=상위)</div>
      </div>
    </div>
  );
}
