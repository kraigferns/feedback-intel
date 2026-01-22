import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

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

const SHEET_SOURCES: Record<string, string> = {
  'Support': 'support',
  'Discord': 'discord',
  'GitHub': 'github',
  'Twitter': 'twitter'
};

export class MyWorkflow extends WorkflowEntrypoint<Env, FeedbackPayload> {
  async run(event: WorkflowEvent<FeedbackPayload>, step: WorkflowStep) {
    const feedback = event.payload;

    const sentiment = await step.do("analyze-sentiment", async () => {
      const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{
          role: "user",
          content: `Analyze the sentiment of this customer feedback. Respond with ONLY valid JSON, no other text:
{"sentiment": "positive" or "negative" or "neutral", "score": number from -1.0 to 1.0}

Feedback: "${feedback.content.substring(0, 500)}"`
        }]
      });
      try {
        return JSON.parse((response as any).response);
      } catch {
        return { sentiment: "neutral", score: 0 };
      }
    });

    const themes = await step.do("extract-themes", async () => {
      const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{
          role: "user",
          content: `Extract 1-3 key themes from this feedback. Respond with ONLY valid JSON:
Valid themes: "performance", "reliability", "documentation", "pricing", "features", "support", "ui/ux", "security", "api", "onboarding", "billing", "dx"

Feedback: "${feedback.content.substring(0, 500)}"

Response: {"themes": ["theme1"]}`
        }]
      });
      try {
        return JSON.parse((response as any).response);
      } catch {
        return { themes: ["general"] };
      }
    });

    const urgency = await step.do("classify-urgency", async () => {
      const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{
          role: "user",
          content: `Classify urgency. Customer: ${feedback.customer_tier}. Respond ONLY JSON:
{"urgency": "critical" or "high" or "medium" or "low"}

Critical=Production down/enterprise angry, High=Major blocker, Medium=Pain point, Low=Nice-to-have

Feedback: "${feedback.content.substring(0, 500)}"`
        }]
      });
      try {
        return JSON.parse((response as any).response);
      } catch {
        return { urgency: "medium" };
      }
    });

    const summaryResult = await step.do("generate-summary", async () => {
      const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{
          role: "user",
          content: `Write ONE sentence summary (max 80 chars) of: "${feedback.content.substring(0, 500)}"`
        }]
      });
      return ((response as any).response as string).substring(0, 120);
    });

    await step.do("store-results", async () => {
      await this.env.DB.prepare(
        `UPDATE feedback SET sentiment=?, sentiment_score=?, urgency=?, themes=?, summary=?, processed_at=? WHERE id=?`
      ).bind(
        sentiment.sentiment, sentiment.score, urgency.urgency,
        JSON.stringify(themes.themes), summaryResult, new Date().toISOString(), feedback.id
      ).run();
    });

    return { id: feedback.id, sentiment, themes, urgency, summary: summaryResult };
  }
}

async function fetchSheetData(env: Env, sheetName: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(sheetName)}?key=${env.SHEETS_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${sheetName}: ${response.statusText}`);
  const data = await response.json() as { values?: string[][] };
  return data.values || [];
}

async function hashContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
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
        const created_at = timestamp || new Date().toISOString();

        await env.DB.prepare(
          `INSERT INTO feedback (id, source, content, content_hash, author, customer_tier, created_at) VALUES (?,?,?,?,?,?,?)`
        ).bind(id, sourceName, content.trim(), contentHash, author || 'anonymous', customer_tier || 'free', created_at).run();

        await env.MY_WORKFLOW.create({ params: { id, source: sourceName, content: content.trim(), customer_tier: customer_tier || 'free', created_at } });
        sheetImported++;
        totalImported++;
      }
      results[sourceName] = sheetImported;
    } catch (error) {
      console.error(`Error importing ${sheetName}:`, error);
      results[sourceName] = 0;
    }
  }
  return { imported: totalImported, sources: results };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (path === "/" || path === "/index.html") {
        return new Response(getHTML(env), { headers: { "Content-Type": "text/html", ...cors } });
      }

      if (path === "/api/feedback" && req.method === "GET") {
        const source = url.searchParams.get("source");
        const urgency = url.searchParams.get("urgency");
        const sentiment = url.searchParams.get("sentiment");
        let query = "SELECT * FROM feedback WHERE 1=1";
        const params: string[] = [];
        if (source) { query += " AND source=?"; params.push(source); }
        if (urgency) { query += " AND urgency=?"; params.push(urgency); }
        if (sentiment) { query += " AND sentiment=?"; params.push(sentiment); }
        query += " ORDER BY created_at DESC LIMIT 100";
        const result = await env.DB.prepare(query).bind(...params).all();
        return Response.json(result.results, { headers: cors });
      }

      if (path === "/api/feedback" && req.method === "POST") {
        const body = await req.json() as any;
        const id = crypto.randomUUID();
        const created_at = new Date().toISOString();
        const contentHash = await hashContent(body.content);
        await env.DB.prepare(
          `INSERT INTO feedback (id,source,content,content_hash,author,customer_tier,created_at) VALUES (?,?,?,?,?,?,?)`
        ).bind(id, body.source||"manual", body.content, contentHash, body.author||"anonymous", body.customer_tier||"free", created_at).run();
        const instance = await env.MY_WORKFLOW.create({ params: { id, source: body.source||"manual", content: body.content, customer_tier: body.customer_tier||"free", created_at } });
        return Response.json({ id, workflowId: instance.id, status: "processing" }, { headers: cors });
      }

      if (path === "/api/import" && req.method === "POST") {
        if (!env.SPREADSHEET_ID || !env.SHEETS_API_KEY) {
          return Response.json({ error: "Google Sheets not configured" }, { status: 400, headers: cors });
        }
        const result = await importFromSheets(env);
        return Response.json({ success: true, message: `Imported ${result.imported} items`, ...result }, { headers: cors });
      }

      if (path === "/api/insights") {
        const stats = await env.DB.prepare(`SELECT COUNT(*) as total,
          SUM(CASE WHEN urgency='critical' THEN 1 ELSE 0 END) as critical,
          SUM(CASE WHEN urgency='high' THEN 1 ELSE 0 END) as high,
          SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) as negative,
          SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) as positive,
          SUM(CASE WHEN sentiment='neutral' THEN 1 ELSE 0 END) as neutral FROM feedback`).first();
        const bySource = await env.DB.prepare(`SELECT source, COUNT(*) as count FROM feedback GROUP BY source`).all();
        const topThemes = await env.DB.prepare(`SELECT themes, COUNT(*) as count FROM feedback WHERE themes IS NOT NULL GROUP BY themes ORDER BY count DESC LIMIT 5`).all();
        const recentCritical = await env.DB.prepare(`SELECT * FROM feedback WHERE urgency='critical' ORDER BY created_at DESC LIMIT 5`).all();
        return Response.json({ stats, bySource: bySource.results, topThemes: topThemes.results, recentCritical: recentCritical.results }, { headers: cors });
      }

      if (path === "/api/clear" && req.method === "POST") {
        await env.DB.prepare('DELETE FROM feedback').run();
        return Response.json({ success: true }, { headers: cors });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers: cors });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500, headers: cors });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (!env.SPREADSHEET_ID || !env.SHEETS_API_KEY) return;
    try {
      const result = await importFromSheets(env);
      console.log(`Scheduled import: ${result.imported} items`);
    } catch (error) {
      console.error('Scheduled import failed:', error);
    }
  }
};

function getHTML(env: Env) {
  const configured = !!(env.SPREADSHEET_ID && env.SHEETS_API_KEY);
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback Intel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh}.container{max-width:1200px;margin:0 auto;padding:20px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px;padding-bottom:20px;border-bottom:1px solid #333;flex-wrap:wrap;gap:15px}h1{font-size:24px;color:#f6821f}h1 span{font-size:12px;color:#888;font-weight:normal}.header-actions{display:flex;gap:10px;flex-wrap:wrap}.btn{background:#f6821f;color:#000;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-weight:600;font-size:14px}.btn:hover{background:#ff9a47}.btn:disabled{background:#555;cursor:not-allowed}.btn-secondary{background:#333;color:#fff}.btn-danger{background:#7f1d1d;color:#fff}.config-banner{background:#1e3a5f;border:1px solid #3b82f6;padding:15px;border-radius:8px;margin-bottom:20px}.config-banner.success{background:#14532d;border-color:#22c55e}.config-banner code{background:#000;padding:2px 6px;border-radius:4px;font-size:12px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:15px;margin-bottom:30px}.stat-card{background:#1a1a1a;padding:20px;border-radius:8px;border:1px solid #333}.stat-value{font-size:32px;font-weight:bold;color:#fff}.stat-label{font-size:12px;color:#888;text-transform:uppercase;margin-top:5px}.stat-card.critical{border-color:#ef4444}.stat-card.critical .stat-value{color:#ef4444}.stat-card.positive .stat-value{color:#22c55e}.stat-card.negative .stat-value{color:#f59e0b}.source-badges{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}.source-badge{background:#1a1a1a;border:1px solid #333;padding:8px 12px;border-radius:6px;font-size:13px}.source-badge strong{color:#f6821f}.filters{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}select{background:#1a1a1a;color:#fff;border:1px solid #333;padding:8px 12px;border-radius:6px}.feedback-list{display:flex;flex-direction:column;gap:12px}.feedback-item{background:#1a1a1a;padding:16px;border-radius:8px;border:1px solid #333}.feedback-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px}.feedback-source{background:#333;padding:4px 8px;border-radius:4px;font-size:12px;text-transform:uppercase}.feedback-source.support{background:#7f1d1d}.feedback-source.discord{background:#5865F2}.feedback-source.github{background:#238636}.feedback-source.twitter{background:#1d9bf0}.feedback-content{color:#ccc;line-height:1.5;margin-bottom:10px}.feedback-meta{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.tag{padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600}.tag.critical{background:#7f1d1d;color:#fca5a5}.tag.high{background:#78350f;color:#fcd34d}.tag.medium{background:#1e3a5f;color:#93c5fd}.tag.low{background:#1a1a1a;color:#888}.tag.positive{background:#14532d;color:#86efac}.tag.negative{background:#7f1d1d;color:#fca5a5}.tag.neutral{background:#333;color:#888}.summary{font-style:italic;color:#888;font-size:13px;margin-top:8px}.themes{color:#f6821f;font-size:12px}.loading{text-align:center;padding:40px;color:#888}.section-title{font-size:18px;margin-bottom:15px;color:#fff}.toast{position:fixed;bottom:20px;right:20px;background:#1a1a1a;border:1px solid #333;padding:15px 20px;border-radius:8px;z-index:1000;display:none}.toast.show{display:block}.toast.success{border-color:#22c55e}.toast.error{border-color:#ef4444}
</style></head><body><div class="container">
<header><h1>🔥 Feedback Intel <span>Cloudflare Workers + AI</span></h1>
<div class="header-actions">
<button class="btn" onclick="importFromSheets()" id="importBtn" ${!configured?'disabled':''}>📥 Import from Sheets</button>
<button class="btn btn-secondary" onclick="refreshData()">🔄 Refresh</button>
<button class="btn btn-danger" onclick="clearData()">🗑️ Clear</button>
</div></header>
${!configured?`<div class="config-banner"><strong>⚙️ Setup Required</strong><p style="margin-top:8px;font-size:14px">Set <code>SPREADSHEET_ID</code> and <code>SHEETS_API_KEY</code> secrets</p></div>`
:`<div class="config-banner success"><strong>✅ Google Sheets Connected</strong><p style="margin-top:8px;font-size:14px">Click Import to pull feedback. Auto-import runs daily at 9am UTC.</p></div>`}
<div class="stats" id="stats"><div class="stat-card"><div class="stat-value">-</div><div class="stat-label">Total</div></div><div class="stat-card critical"><div class="stat-value">-</div><div class="stat-label">Critical</div></div><div class="stat-card negative"><div class="stat-value">-</div><div class="stat-label">Negative</div></div><div class="stat-card positive"><div class="stat-value">-</div><div class="stat-label">Positive</div></div></div>
<div class="source-badges" id="sourceBadges"></div>
<div class="filters">
<select id="sourceFilter" onchange="applyFilters()"><option value="">All Sources</option><option value="support">Support</option><option value="github">GitHub</option><option value="discord">Discord</option><option value="twitter">Twitter</option></select>
<select id="urgencyFilter" onchange="applyFilters()"><option value="">All Urgency</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
<select id="sentimentFilter" onchange="applyFilters()"><option value="">All Sentiment</option><option value="positive">Positive</option><option value="negative">Negative</option><option value="neutral">Neutral</option></select>
</div>
<h2 class="section-title">Recent Feedback</h2>
<div class="feedback-list" id="feedbackList"><div class="loading">Loading...</div></div>
</div><div class="toast" id="toast"></div>
<script>
function showToast(m,t='success'){const e=document.getElementById('toast');e.textContent=m;e.className='toast show '+t;setTimeout(()=>e.className='toast',3000)}
async function fetchInsights(){try{const r=await fetch('/api/insights'),d=await r.json();document.getElementById('stats').innerHTML=\`<div class="stat-card"><div class="stat-value">\${d.stats?.total||0}</div><div class="stat-label">Total</div></div><div class="stat-card critical"><div class="stat-value">\${d.stats?.critical||0}</div><div class="stat-label">Critical</div></div><div class="stat-card negative"><div class="stat-value">\${d.stats?.negative||0}</div><div class="stat-label">Negative</div></div><div class="stat-card positive"><div class="stat-value">\${d.stats?.positive||0}</div><div class="stat-label">Positive</div></div>\`;if(d.bySource?.length)document.getElementById('sourceBadges').innerHTML=d.bySource.map(s=>\`<div class="source-badge"><strong>\${s.count}</strong> \${s.source}</div>\`).join('')}catch(e){console.error(e)}}
async function fetchFeedback(f={}){try{const p=new URLSearchParams(f),r=await fetch('/api/feedback?'+p),d=await r.json();renderFeedback(d)}catch(e){document.getElementById('feedbackList').innerHTML='<div class="loading">Error</div>'}}
function renderFeedback(items){if(!items.length){document.getElementById('feedbackList').innerHTML='<div class="loading">No feedback. Import from Sheets to start.</div>';return}document.getElementById('feedbackList').innerHTML=items.map(i=>\`<div class="feedback-item"><div class="feedback-header"><span class="feedback-source \${i.source}">\${i.source}</span><span style="color:#888;font-size:12px">\${i.customer_tier} · \${i.author||'anon'} · \${new Date(i.created_at).toLocaleDateString()}</span></div><div class="feedback-content">\${i.content}</div><div class="feedback-meta">\${i.urgency?\`<span class="tag \${i.urgency}">\${i.urgency.toUpperCase()}</span>\`:'<span class="tag">Processing...</span>'}\${i.sentiment?\`<span class="tag \${i.sentiment}">\${i.sentiment}</span>\`:''}\${i.themes?\`<span class="themes">\${JSON.parse(i.themes).join(', ')}</span>\`:''}</div>\${i.summary?\`<div class="summary">"\${i.summary}"</div>\`:''}</div>\`).join('')}
function applyFilters(){const f={},s=document.getElementById('sourceFilter').value,u=document.getElementById('urgencyFilter').value,t=document.getElementById('sentimentFilter').value;if(s)f.source=s;if(u)f.urgency=u;if(t)f.sentiment=t;fetchFeedback(f)}
async function importFromSheets(){const b=document.getElementById('importBtn');b.disabled=true;b.textContent='⏳ Importing...';try{const r=await fetch('/api/import',{method:'POST'}),d=await r.json();if(d.error)showToast(d.error,'error');else{showToast(\`Imported \${d.imported} items!\`,'success');setTimeout(refreshData,2000)}}catch(e){showToast('Failed','error')}finally{b.disabled=false;b.textContent='📥 Import from Sheets'}}
async function clearData(){if(!confirm('Delete all feedback?'))return;try{await fetch('/api/clear',{method:'POST'});showToast('Cleared');refreshData()}catch(e){showToast('Failed','error')}}
function refreshData(){fetchInsights();applyFilters()}
refreshData();setInterval(refreshData,15000);
</script></body></html>`;
}
