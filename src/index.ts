import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

// ============================================
// TYPES & CONSTANTS
// ============================================
interface FeedbackPayload {
  id: string;
  source: string;
  content: string;
  author?: string;
  customer_tier: string;
  created_at: string;
}

interface Env {
  DB: D1Database;
  AI: Ai;
  MY_WORKFLOW: Workflow;
  SHEETS_API_KEY: string;
  SPREADSHEET_ID: string;
}

const TIER_ARR: Record<string, number> = { 'enterprise': 50000, 'pro': 5000, 'free': 0 };
const TIER_WEIGHT: Record<string, number> = { 'enterprise': 10, 'pro': 5, 'free': 1 };
const SEVERITY_WEIGHT: Record<string, number> = { 'critical': 10, 'high': 7, 'medium': 4, 'low': 1 };
const SENTIMENT_WEIGHT: Record<string, number> = { 'negative': 10, 'neutral': 5, 'positive': 1 };
const SHEET_SOURCES: Record<string, string> = { 'Support': 'support', 'Discord': 'discord', 'GitHub': 'github', 'Twitter': 'twitter' };

const THEME_KEYWORDS: Record<string, string[]> = {
  'documentation': ['docs', 'documentation', 'guide', 'tutorial', 'example', 'outdated', 'confusing'],
  'reliability': ['down', 'outage', 'error', 'fail', 'crash', 'broken', 'unstable', 'timeout'],
  'performance': ['slow', 'latency', 'speed', 'fast', 'performance', 'cold start'],
  'dx': ['developer experience', 'wrangler', 'cli', 'sdk', 'api', 'typescript', 'tooling'],
  'pricing': ['price', 'cost', 'billing', 'expensive', 'cheap', 'free tier', 'credits'],
  'features': ['feature', 'request', 'would be', 'should', 'wish', 'need', 'want', 'missing'],
  'support': ['support', 'help', 'response', 'ticket', 'resolved'],
  'security': ['security', 'auth', 'permission', '403', '401', 'access', 'token']
};

// ============================================
// WORKFLOW
// ============================================
export class MyWorkflow extends WorkflowEntrypoint<Env, FeedbackPayload> {
  async run(event: WorkflowEvent<FeedbackPayload>, step: WorkflowStep) {
    const feedback = event.payload;

    const sentiment = await step.do("analyze-sentiment", async () => {
      try {
        const response = await this.env.AI.run("@cf/huggingface/distilbert-sst-2-int8", {
          text: feedback.content.substring(0, 512)
        });
        const result = Array.isArray(response) ? response[0] : response;
        const label = (result.label || 'NEUTRAL').toLowerCase();
        const score = label === 'positive' ? result.score : -result.score;
        return { sentiment: label === 'positive' ? 'positive' : label === 'negative' ? 'negative' : 'neutral', score: Math.round(score * 100) / 100 };
      } catch { return { sentiment: "neutral", score: 0 }; }
    });

    const themes = await step.do("extract-themes", async () => {
      const contentLower = feedback.content.toLowerCase();
      const detected: string[] = [];
      for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
        if (keywords.some(kw => contentLower.includes(kw))) detected.push(theme);
      }
      if (detected.length === 0) {
        try {
          const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
            messages: [{ role: "user", content: `Classify into 1-2 themes (documentation, reliability, performance, dx, pricing, features, support, security): "${feedback.content.substring(0, 300)}"\n\nReply with ONLY comma-separated themes.` }]
          });
          const aiThemes = ((response as any).response || '').toLowerCase().split(',').map((t: string) => t.trim()).filter((t: string) => Object.keys(THEME_KEYWORDS).includes(t));
          return { themes: aiThemes.length > 0 ? aiThemes : ['general'] };
        } catch { return { themes: ['general'] }; }
      }
      return { themes: detected.slice(0, 3) };
    });

    const urgency = await step.do("classify-urgency", async () => {
      const contentLower = feedback.content.toLowerCase();
      const tier = feedback.customer_tier.toLowerCase();
      const criticalKw = ['urgent', 'down', 'outage', 'production', 'critical', 'emergency', 'asap', 'sla'];
      const highKw = ['broken', 'fail', 'error', 'blocked', 'cannot', 'stuck', 'alternative', 'leaving'];
      const hasCritical = criticalKw.some(kw => contentLower.includes(kw));
      const hasHigh = highKw.some(kw => contentLower.includes(kw));
      if (tier === 'enterprise' && (hasCritical || hasHigh)) return { urgency: 'critical' };
      if (hasCritical) return { urgency: tier === 'enterprise' ? 'critical' : 'high' };
      if (hasHigh) return { urgency: tier === 'enterprise' ? 'high' : 'medium' };
      return { urgency: 'low' };
    });

    const summaryResult = await step.do("generate-summary", async () => {
      try {
        const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [{ role: "user", content: `Summarize in max 12 words: "${feedback.content.substring(0, 400)}"\n\nReply with ONLY the summary.` }]
        });
        return ((response as any).response as string).substring(0, 100).trim();
      } catch { return feedback.content.substring(0, 80) + '...'; }
    });

    const priorityScore = await step.do("calculate-priority", async () => {
      const tierW = TIER_WEIGHT[feedback.customer_tier.toLowerCase()] || 1;
      const sevW = SEVERITY_WEIGHT[urgency.urgency] || 4;
      const sentW = SENTIMENT_WEIGHT[sentiment.sentiment] || 5;
      const daysOld = Math.max(1, Math.floor((Date.now() - new Date(feedback.created_at).getTime()) / (1000 * 60 * 60 * 24)));
      const score = (tierW * 0.4) + (sevW * 0.3) + (sentW * 0.2) + (Math.min(daysOld * 0.5, 5) * 0.1);
      return Math.round(score * 10) / 10;
    });

    await step.do("store-results", async () => {
      await this.env.DB.prepare(`UPDATE feedback SET sentiment=?, sentiment_score=?, urgency=?, themes=?, summary=?, priority_score=?, arr_estimate=?, processed_at=? WHERE id=?`)
        .bind(sentiment.sentiment, sentiment.score, urgency.urgency, JSON.stringify(themes.themes), summaryResult, priorityScore, TIER_ARR[feedback.customer_tier.toLowerCase()] || 0, new Date().toISOString(), feedback.id).run();
    });

    return { id: feedback.id, sentiment, themes, urgency, summary: summaryResult, priorityScore };
  }
}

// ============================================
// HELPERS
// ============================================
async function fetchSheetData(env: Env, sheetName: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(sheetName)}?key=${env.SHEETS_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${sheetName}: ${response.statusText}`);
  return ((await response.json()) as { values?: string[][] }).values || [];
}

async function hashContent(content: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
}

async function importFromSheets(env: Env): Promise<{ imported: number; sources: Record<string, number> }> {
  const results: Record<string, number> = {};
  let totalImported = 0;
  for (const [sheetName, sourceName] of Object.entries(SHEET_SOURCES)) {
    try {
      const rows = await fetchSheetData(env, sheetName);
      let sheetImported = 0;
      for (const row of rows.slice(1)) {
        if (row.length < 3 || !row[0]?.trim()) continue;
        const [content, author, customer_tier, timestamp] = row;
        const contentHash = await hashContent(content);
        const existing = await env.DB.prepare('SELECT id FROM feedback WHERE content_hash=?').bind(contentHash).first();
        if (existing) continue;
        const id = crypto.randomUUID();
        const normalizedTier = (customer_tier || 'free').toLowerCase().trim();
        const created_at = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
        await env.DB.prepare(`INSERT INTO feedback (id, source, content, content_hash, author, customer_tier, arr_estimate, created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(id, sourceName, content.trim(), contentHash, author || 'anonymous', normalizedTier, TIER_ARR[normalizedTier] || 0, created_at).run();
        await env.MY_WORKFLOW.create({ params: { id, source: sourceName, content: content.trim(), customer_tier: normalizedTier, created_at } });
        sheetImported++;
        totalImported++;
      }
      results[sourceName] = sheetImported;
    } catch (error) { console.error(`Error importing ${sheetName}:`, error); results[sourceName] = 0; }
  }
  return { imported: totalImported, sources: results };
}

// ============================================
// HTTP HANDLER
// ============================================
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (path === "/" || path === "/index.html") return new Response(getHTML(env), { headers: { "Content-Type": "text/html", ...cors } });

      if (path === "/api/feedback" && req.method === "GET") {
        const source = url.searchParams.get("source"), urgency = url.searchParams.get("urgency"), sentiment = url.searchParams.get("sentiment"), theme = url.searchParams.get("theme");
        let query = "SELECT * FROM feedback WHERE 1=1";
        const params: string[] = [];
        if (source) { query += " AND source=?"; params.push(source); }
        if (urgency) { query += " AND urgency=?"; params.push(urgency); }
        if (sentiment) { query += " AND sentiment=?"; params.push(sentiment); }
        if (theme) { query += " AND themes LIKE ?"; params.push(`%${theme}%`); }
        query += " ORDER BY priority_score DESC, created_at DESC LIMIT 100";
        return Response.json((await env.DB.prepare(query).bind(...params).all()).results, { headers: cors });
      }

      if (path === "/api/feedback" && req.method === "POST") {
        const body = await req.json() as any;
        const id = crypto.randomUUID(), created_at = new Date().toISOString(), contentHash = await hashContent(body.content);
        const normalizedTier = (body.customer_tier || 'free').toLowerCase();
        await env.DB.prepare(`INSERT INTO feedback (id,source,content,content_hash,author,customer_tier,arr_estimate,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(id, body.source || "manual", body.content, contentHash, body.author || "anonymous", normalizedTier, TIER_ARR[normalizedTier] || 0, created_at).run();
        const instance = await env.MY_WORKFLOW.create({ params: { id, source: body.source || "manual", content: body.content, customer_tier: normalizedTier, created_at } });
        return Response.json({ id, workflowId: instance.id, status: "processing" }, { headers: cors });
      }

      if (path === "/api/import" && req.method === "POST") {
        if (!env.SPREADSHEET_ID || !env.SHEETS_API_KEY) return Response.json({ error: "Google Sheets not configured" }, { status: 400, headers: cors });
        const result = await importFromSheets(env);
        return Response.json({ success: true, message: `Imported ${result.imported} items`, ...result }, { headers: cors });
      }

      if (path === "/api/insights") {
        const stats = await env.DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN urgency='critical' THEN 1 ELSE 0 END) as critical, SUM(CASE WHEN urgency='high' THEN 1 ELSE 0 END) as high, SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) as negative, SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) as positive, SUM(CASE WHEN sentiment='neutral' THEN 1 ELSE 0 END) as neutral, ROUND(AVG(sentiment_score), 2) as avg_sentiment, SUM(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END) as processing FROM feedback`).first();
        const bySource = await env.DB.prepare(`SELECT source, COUNT(*) as count, SUM(CASE WHEN urgency='critical' THEN 1 ELSE 0 END) as critical, SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) as negative FROM feedback GROUP BY source`).all();
        const byTier = await env.DB.prepare(`SELECT customer_tier, COUNT(*) as count, SUM(CASE WHEN urgency='critical' THEN 1 ELSE 0 END) as critical, SUM(CASE WHEN urgency IN ('critical', 'high') AND sentiment='negative' THEN arr_estimate ELSE 0 END) as arr_at_risk FROM feedback GROUP BY customer_tier`).all();
        const allFeedback = await env.DB.prepare(`SELECT themes FROM feedback WHERE themes IS NOT NULL`).all();
        const themeCounts: Record<string, number> = {};
        for (const row of allFeedback.results as any[]) { try { for (const theme of JSON.parse(row.themes)) themeCounts[theme] = (themeCounts[theme] || 0) + 1; } catch {} }
        const topThemes = Object.entries(themeCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([theme, count]) => ({ theme, count }));
        const severityDist = await env.DB.prepare(`SELECT urgency, COUNT(*) as count, ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM feedback WHERE urgency IS NOT NULL), 1) as percentage FROM feedback WHERE urgency IS NOT NULL GROUP BY urgency ORDER BY CASE urgency WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END`).all();
        const highPriority = await env.DB.prepare(`SELECT * FROM feedback WHERE priority_score IS NOT NULL ORDER BY priority_score DESC LIMIT 10`).all();
        const arrAtRisk = await env.DB.prepare(`SELECT SUM(arr_estimate) as total FROM feedback WHERE urgency IN ('critical', 'high') AND sentiment = 'negative'`).first();
        return Response.json({ stats, bySource: bySource.results, byTier: byTier.results, topThemes, severityDist: severityDist.results, highPriority: highPriority.results, arrAtRisk: (arrAtRisk as any)?.total || 0 }, { headers: cors });
      }

      if (path === "/api/clear" && req.method === "POST") { await env.DB.prepare('DELETE FROM feedback').run(); return Response.json({ success: true }, { headers: cors }); }

      return Response.json({ error: "Not found" }, { status: 404, headers: cors });
    } catch (error: any) { console.error('Error:', error); return Response.json({ error: error.message }, { status: 500, headers: cors }); }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (!env.SPREADSHEET_ID || !env.SHEETS_API_KEY) return;
    try { const result = await importFromSheets(env); console.log(`Scheduled import: ${result.imported} items`); } catch (error) { console.error('Scheduled import failed:', error); }
  }
};

// ============================================
// CLEAN UI
// ============================================
function getHTML(env: Env) {
  const configured = !!(env.SPREADSHEET_ID && env.SHEETS_API_KEY);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback Intel</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#fff;min-height:100vh}
.container{max-width:1200px;margin:0 auto;padding:32px 24px}

/* Header */
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:32px}
.logo{font-size:20px;font-weight:600;color:#fff}
.logo span{color:#f97316}
.actions{display:flex;gap:8px}
.btn{padding:8px 16px;border-radius:8px;border:none;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s}
.btn-primary{background:#f97316;color:#fff}
.btn-primary:hover{background:#ea580c}
.btn-ghost{background:transparent;color:#888;border:1px solid #333}
.btn-ghost:hover{background:#222;color:#fff}

/* Alert Banner */
.alert{background:#1c1c1c;border:1px solid #333;border-radius:12px;padding:16px 20px;margin-bottom:24px;display:flex;align-items:center;gap:12px}
.alert.success{border-color:#22c55e33;background:#22c55e08}
.alert-icon{font-size:18px}
.alert-text{font-size:13px;color:#aaa}
.alert-text strong{color:#fff}

/* Stats Row */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
@media(max-width:768px){.stats{grid-template-columns:repeat(2,1fr)}}
.stat{background:#1c1c1c;border-radius:12px;padding:20px}
.stat-label{font-size:12px;color:#666;margin-bottom:4px}
.stat-value{font-size:28px;font-weight:600}
.stat-value.red{color:#ef4444}
.stat-value.orange{color:#f97316}
.stat-value.green{color:#22c55e}

/* Grid Layout */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:32px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}

/* Cards */
.card{background:#1c1c1c;border-radius:12px;padding:20px}
.card-title{font-size:14px;font-weight:500;color:#888;margin-bottom:16px}

/* Themes */
.themes{display:flex;flex-wrap:wrap;gap:8px}
.theme{background:#262626;padding:6px 12px;border-radius:6px;font-size:13px;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:6px}
.theme:hover{background:#333}
.theme-count{background:#f97316;color:#000;font-size:11px;padding:2px 6px;border-radius:4px;font-weight:600}

/* Simple Table */
.table{width:100%;font-size:13px}
.table th{text-align:left;color:#666;font-weight:500;padding:8px 0;border-bottom:1px solid #333}
.table td{padding:10px 0;border-bottom:1px solid #222}
.table td:last-child{text-align:right}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
.badge.critical{background:#7f1d1d;color:#fca5a5}
.badge.high{background:#78350f;color:#fcd34d}
.badge.support{background:#7f1d1d;color:#fca5a5}
.badge.discord{background:#5865F2;color:#fff}
.badge.github{background:#238636;color:#fff}
.badge.twitter{background:#1d9bf0;color:#fff}

/* Insights Box */
.insights{background:linear-gradient(135deg,#1a1a2e,#16213e);border:1px solid #e9456033;border-radius:12px;padding:20px;margin-bottom:24px}
.insight{background:#00000033;border-radius:8px;padding:12px;margin-bottom:8px}
.insight:last-child{margin-bottom:0}
.insight-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.insight-badge{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600}
.insight-badge.critical{background:#ef4444;color:#fff}
.insight-badge.warning{background:#f97316;color:#fff}
.insight-badge.info{background:#3b82f6;color:#fff}
.insight-title{font-size:13px;font-weight:500}
.insight-desc{font-size:12px;color:#888}
.insight-action{font-size:11px;color:#f97316;margin-top:6px}

/* Feedback List */
.feedback-section{margin-top:32px}
.feedback-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.feedback-title{font-size:16px;font-weight:500}
.filters{display:flex;gap:8px}
.filter{background:#1c1c1c;border:1px solid #333;color:#fff;padding:6px 12px;border-radius:6px;font-size:12px}
.feedback-list{display:flex;flex-direction:column;gap:12px}
.feedback-item{background:#1c1c1c;border-radius:10px;padding:16px}
.feedback-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.feedback-meta{display:flex;align-items:center;gap:8px}
.priority{background:#f97316;color:#000;font-size:11px;padding:3px 8px;border-radius:4px;font-weight:600}
.feedback-date{font-size:11px;color:#666}
.feedback-content{font-size:14px;color:#ccc;line-height:1.5;margin-bottom:10px}
.feedback-tags{display:flex;gap:6px;flex-wrap:wrap}
.tag{font-size:11px;padding:3px 8px;border-radius:4px}
.tag.critical{background:#7f1d1d;color:#fca5a5}
.tag.high{background:#78350f;color:#fcd34d}
.tag.medium{background:#1e3a5f;color:#93c5fd}
.tag.low{background:#262626;color:#888}
.tag.positive{background:#14532d;color:#86efac}
.tag.negative{background:#7f1d1d;color:#fca5a5}
.tag.neutral{background:#262626;color:#888}
.tag.theme{background:#312e81;color:#a5b4fc}
.feedback-summary{font-size:12px;color:#666;font-style:italic;margin-top:8px;padding-top:8px;border-top:1px solid #262626}
.feedback-footer{display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:11px;color:#555}
.arr{color:#22c55e;font-weight:500}

/* Toast */
.toast{position:fixed;bottom:20px;right:20px;background:#1c1c1c;border:1px solid #333;padding:12px 20px;border-radius:8px;font-size:13px;display:none;z-index:100}
.toast.show{display:block}
.toast.success{border-color:#22c55e}
.toast.error{border-color:#ef4444}

/* Loading */
.loading{color:#666;font-size:13px;padding:40px;text-align:center}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo"><span>●</span> Feedback Intel</div>
    <div class="actions">
      <button class="btn btn-primary" onclick="importData()" id="importBtn" ${!configured?'disabled':''}>Import</button>
      <button class="btn btn-ghost" onclick="refresh()">Refresh</button>
      <button class="btn btn-ghost" onclick="clearAll()">Clear</button>
    </div>
  </header>

  ${configured?`<div class="alert success"><span class="alert-icon">✓</span><span class="alert-text"><strong>Connected to Google Sheets</strong> — Auto-import daily at 9am UTC</span></div>`
  :`<div class="alert"><span class="alert-icon">⚙</span><span class="alert-text">Set <strong>SPREADSHEET_ID</strong> and <strong>SHEETS_API_KEY</strong> to enable import</span></div>`}

  <div class="insights" id="insights"><div class="loading">Analyzing feedback...</div></div>

  <div class="stats" id="stats">
    <div class="stat"><div class="stat-label">Total</div><div class="stat-value">—</div></div>
    <div class="stat"><div class="stat-label">Critical</div><div class="stat-value red">—</div></div>
    <div class="stat"><div class="stat-label">ARR at Risk</div><div class="stat-value orange">—</div></div>
    <div class="stat"><div class="stat-label">Positive</div><div class="stat-value green">—</div></div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-title">Themes</div>
      <div class="themes" id="themes"><span class="loading">Loading...</span></div>
    </div>
    <div class="card">
      <div class="card-title">By Channel</div>
      <table class="table" id="channels">
        <thead><tr><th>Channel</th><th>Total</th><th>Critical</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <div class="feedback-section">
    <div class="feedback-header">
      <div class="feedback-title">All Feedback</div>
      <div class="filters">
        <select class="filter" id="sourceFilter" onchange="applyFilters()">
          <option value="">All channels</option>
          <option value="support">Support</option>
          <option value="discord">Discord</option>
          <option value="github">GitHub</option>
          <option value="twitter">Twitter</option>
        </select>
        <select class="filter" id="urgencyFilter" onchange="applyFilters()">
          <option value="">All urgency</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>
    </div>
    <div class="feedback-list" id="feedbackList"><div class="loading">Loading feedback...</div></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let data=null;
const $=s=>document.querySelector(s);
const toast=(m,t='success')=>{const e=$('#toast');e.textContent=m;e.className='toast show '+t;setTimeout(()=>e.className='toast',3000)};
const fmt=n=>n>=1000?'$'+(n/1000).toFixed(0)+'K':'$'+n;

async function loadInsights(){
  try{
    const r=await fetch('/api/insights');
    data=await r.json();
    renderInsights();
    renderStats();
    renderThemes();
    renderChannels();
  }catch(e){console.error(e)}
}

function renderInsights(){
  if(!data?.stats)return;
  const items=[];
  const ent=data.byTier?.find(t=>t.customer_tier==='enterprise');
  if(ent?.critical>0)items.push({type:'critical',title:'Enterprise SLA Risk',desc:\`\${ent.critical} critical issues from Enterprise. \${fmt(ent.arr_at_risk||0)} ARR at risk.\`,action:'Escalate to VP Eng'});
  const rel=data.topThemes?.find(t=>t.theme==='reliability');
  if(rel?.count>=3)items.push({type:'warning',title:'Reliability Pattern',desc:\`\${rel.count} items tagged "reliability" — investigate infra changes.\`,action:'Review recent deployments'});
  const doc=data.topThemes?.find(t=>t.theme==='documentation');
  if(doc?.count>=3)items.push({type:'info',title:'Documentation Debt',desc:\`\${doc.count} complaints about outdated or confusing docs.\`,action:'Audit docs >90 days old'});
  if(data.stats.negative>data.stats.positive)items.push({type:'warning',title:'Negative > Positive',desc:\`\${data.stats.negative} negative vs \${data.stats.positive} positive.\`,action:'Investigate root causes'});
  if(!items.length)items.push({type:'info',title:'Looking Good',desc:'No critical patterns detected.',action:'Keep monitoring'});
  $('#insights').innerHTML=items.map(i=>\`<div class="insight"><div class="insight-header"><span class="insight-badge \${i.type}">\${i.type}</span><span class="insight-title">\${i.title}</span></div><div class="insight-desc">\${i.desc}</div><div class="insight-action">→ \${i.action}</div></div>\`).join('');
}

function renderStats(){
  if(!data?.stats)return;
  $('#stats').innerHTML=\`
    <div class="stat"><div class="stat-label">Total</div><div class="stat-value">\${data.stats.total||0}</div></div>
    <div class="stat"><div class="stat-label">Critical</div><div class="stat-value red">\${data.stats.critical||0}</div></div>
    <div class="stat"><div class="stat-label">ARR at Risk</div><div class="stat-value orange">\${fmt(data.arrAtRisk||0)}</div></div>
    <div class="stat"><div class="stat-label">Positive</div><div class="stat-value green">\${data.stats.positive||0}</div></div>
  \`;
}

function renderThemes(){
  if(!data?.topThemes?.length){$('#themes').innerHTML='<span class="loading">No themes</span>';return;}
  $('#themes').innerHTML=data.topThemes.map(t=>\`<div class="theme" onclick="filterTheme('\${t.theme}')">\${t.theme}<span class="theme-count">\${t.count}</span></div>\`).join('');
}

function renderChannels(){
  if(!data?.bySource?.length)return;
  $('#channels tbody').innerHTML=data.bySource.map(s=>\`<tr><td><span class="badge \${s.source}">\${s.source}</span></td><td>\${s.count}</td><td style="color:\${s.critical?'#ef4444':'#666'}">\${s.critical||0}</td></tr>\`).join('');
}

async function loadFeedback(filters={}){
  try{
    const r=await fetch('/api/feedback?'+new URLSearchParams(filters));
    const items=await r.json();
    if(!items?.length){$('#feedbackList').innerHTML='<div class="loading">No feedback yet</div>';return;}
    $('#feedbackList').innerHTML=items.map(i=>{
      const themes=i.themes?JSON.parse(i.themes):[];
      return \`<div class="feedback-item">
        <div class="feedback-top">
          <div class="feedback-meta">
            <span class="priority">P:\${i.priority_score?.toFixed(1)||'?'}</span>
            <span class="badge \${i.source}">\${i.source}</span>
            <span style="color:#888;font-size:12px">\${i.customer_tier}</span>
          </div>
          <span class="feedback-date">\${new Date(i.created_at).toLocaleDateString()}</span>
        </div>
        <div class="feedback-content">\${i.content}</div>
        <div class="feedback-tags">
          \${i.urgency?\`<span class="tag \${i.urgency}">\${i.urgency}</span>\`:''}
          \${i.sentiment?\`<span class="tag \${i.sentiment}">\${i.sentiment}</span>\`:''}
          \${themes.slice(0,2).map(t=>\`<span class="tag theme">\${t}</span>\`).join('')}
        </div>
        \${i.summary?\`<div class="feedback-summary">"\${i.summary}"</div>\`:''}
        <div class="feedback-footer">
          <span>\${i.arr_estimate?\`<span class="arr">\${fmt(i.arr_estimate)} ARR</span>\`:'Free'}</span>
          <span>\${i.author||'anon'}</span>
        </div>
      </div>\`;
    }).join('');
  }catch(e){$('#feedbackList').innerHTML='<div class="loading">Error loading</div>';}
}

function filterTheme(t){$('#sourceFilter').value='';$('#urgencyFilter').value='';loadFeedback({theme:t})}
function applyFilters(){const f={};const s=$('#sourceFilter').value,u=$('#urgencyFilter').value;if(s)f.source=s;if(u)f.urgency=u;loadFeedback(f)}
async function importData(){const b=$('#importBtn');b.disabled=true;b.textContent='...';try{const r=await fetch('/api/import',{method:'POST'});const d=await r.json();toast(d.error||'Imported '+d.imported+' items',d.error?'error':'success');setTimeout(refresh,2000)}catch(e){toast('Failed','error')}finally{b.disabled=false;b.textContent='Import'}}
async function clearAll(){if(!confirm('Delete all?'))return;await fetch('/api/clear',{method:'POST'});toast('Cleared');refresh()}
function refresh(){loadInsights();applyFilters()}

refresh();
setInterval(refresh,30000);
</script>
</body>
</html>`;
}
