import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

// ============================================
// TYPES
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

// Customer tier ARR estimates
const TIER_ARR: Record<string, number> = {
  'enterprise': 50000,
  'pro': 5000,
  'free': 0
};

// Priority weights
const TIER_WEIGHT: Record<string, number> = { 'enterprise': 10, 'pro': 5, 'free': 1 };
const SEVERITY_WEIGHT: Record<string, number> = { 'critical': 10, 'high': 7, 'medium': 4, 'low': 1 };
const SENTIMENT_WEIGHT: Record<string, number> = { 'negative': 10, 'neutral': 5, 'positive': 1 };

const SHEET_SOURCES: Record<string, string> = {
  'Support': 'support',
  'Discord': 'discord',
  'GitHub': 'github',
  'Twitter': 'twitter'
};

// Theme keywords for clustering
const THEME_KEYWORDS: Record<string, string[]> = {
  'documentation': ['docs', 'documentation', 'guide', 'tutorial', 'example', 'readme', 'outdated', 'confusing'],
  'reliability': ['down', 'outage', 'error', 'fail', 'crash', 'broken', 'unstable', '503', '500', 'timeout'],
  'performance': ['slow', 'latency', 'speed', 'fast', 'performance', 'cold start', 'response time', 'millisecond'],
  'dx': ['developer experience', 'wrangler', 'cli', 'sdk', 'api', 'typescript', 'tooling', 'debug'],
  'pricing': ['price', 'cost', 'billing', 'expensive', 'cheap', 'free tier', 'credits', 'charge'],
  'features': ['feature', 'request', 'would be', 'should', 'wish', 'need', 'want', 'missing'],
  'support': ['support', 'help', 'response', 'ticket', 'customer service', 'resolved'],
  'security': ['security', 'auth', 'permission', '403', '401', 'access', 'credential', 'token']
};

// ============================================
// WORKFLOW: Multi-step feedback processing
// ============================================
export class MyWorkflow extends WorkflowEntrypoint<Env, FeedbackPayload> {
  async run(event: WorkflowEvent<FeedbackPayload>, step: WorkflowStep) {
    const feedback = event.payload;

    // Step 1: Sentiment Analysis using DistilBERT
    const sentiment = await step.do("analyze-sentiment", async () => {
      try {
        const response = await this.env.AI.run("@cf/huggingface/distilbert-sst-2-int8", {
          text: feedback.content.substring(0, 512)
        });
        // Returns array: [{label: "POSITIVE/NEGATIVE", score: 0.95}]
        const result = Array.isArray(response) ? response[0] : response;
        const label = (result.label || 'NEUTRAL').toLowerCase();
        const score = label === 'positive' ? result.score : -result.score;
        return { 
          sentiment: label === 'positive' ? 'positive' : label === 'negative' ? 'negative' : 'neutral',
          score: Math.round(score * 100) / 100
        };
      } catch (e) {
        console.error('Sentiment error:', e);
        return { sentiment: "neutral", score: 0 };
      }
    });

    // Step 2: Extract Themes using keyword matching + AI
    const themes = await step.do("extract-themes", async () => {
      const contentLower = feedback.content.toLowerCase();
      const detectedThemes: string[] = [];
      
      // Keyword-based theme detection
      for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
        if (keywords.some(kw => contentLower.includes(kw))) {
          detectedThemes.push(theme);
        }
      }
      
      // If no themes detected, use AI
      if (detectedThemes.length === 0) {
        try {
          const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
            messages: [{
              role: "user",
              content: `Classify this feedback into 1-2 themes. Valid themes: documentation, reliability, performance, dx, pricing, features, support, security.
              
Feedback: "${feedback.content.substring(0, 300)}"

Reply with ONLY comma-separated themes, nothing else. Example: reliability, performance`
            }]
          });
          const aiThemes = ((response as any).response || '').toLowerCase()
            .split(',')
            .map((t: string) => t.trim())
            .filter((t: string) => Object.keys(THEME_KEYWORDS).includes(t));
          return { themes: aiThemes.length > 0 ? aiThemes : ['general'] };
        } catch {
          return { themes: ['general'] };
        }
      }
      
      return { themes: detectedThemes.slice(0, 3) };
    });

    // Step 3: Urgency Classification
    const urgency = await step.do("classify-urgency", async () => {
      const contentLower = feedback.content.toLowerCase();
      const tier = feedback.customer_tier.toLowerCase();
      
      // Rule-based urgency detection
      const criticalKeywords = ['urgent', 'down', 'outage', 'production', 'critical', 'emergency', 'asap', 'immediately', 'sla'];
      const highKeywords = ['broken', 'fail', 'error', 'blocked', 'cannot', 'stuck', 'alternative', 'leaving'];
      
      const hasCritical = criticalKeywords.some(kw => contentLower.includes(kw));
      const hasHigh = highKeywords.some(kw => contentLower.includes(kw));
      
      // Enterprise customers get urgency boost
      if (tier === 'enterprise' && (hasCritical || hasHigh)) {
        return { urgency: 'critical' };
      }
      if (hasCritical) {
        return { urgency: tier === 'enterprise' ? 'critical' : 'high' };
      }
      if (hasHigh) {
        return { urgency: tier === 'enterprise' ? 'high' : 'medium' };
      }
      
      // AI fallback for ambiguous cases
      try {
        const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [{
            role: "user",
            content: `Rate urgency as: critical, high, medium, or low.
Customer tier: ${tier}
Feedback: "${feedback.content.substring(0, 300)}"

Reply with ONLY one word: critical, high, medium, or low`
          }]
        });
        const result = ((response as any).response || 'medium').toLowerCase().trim();
        const validUrgencies = ['critical', 'high', 'medium', 'low'];
        return { urgency: validUrgencies.includes(result) ? result : 'medium' };
      } catch {
        return { urgency: 'medium' };
      }
    });

    // Step 4: Generate Summary
    const summaryResult = await step.do("generate-summary", async () => {
      try {
        const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [{
            role: "user",
            content: `Summarize in max 15 words: "${feedback.content.substring(0, 400)}"
            
Reply with ONLY the summary, no quotes.`
          }]
        });
        return ((response as any).response as string).substring(0, 120).trim();
      } catch {
        return feedback.content.substring(0, 100) + '...';
      }
    });

    // Step 5: Calculate Priority Score
    const priorityScore = await step.do("calculate-priority", async () => {
      const tierW = TIER_WEIGHT[feedback.customer_tier.toLowerCase()] || 1;
      const sevW = SEVERITY_WEIGHT[urgency.urgency] || 4;
      const sentW = SENTIMENT_WEIGHT[sentiment.sentiment] || 5;
      
      // Calculate days since created
      const daysOld = Math.max(1, Math.floor((Date.now() - new Date(feedback.created_at).getTime()) / (1000 * 60 * 60 * 24)));
      const ageW = Math.min(daysOld * 0.5, 5); // Cap at 5
      
      const score = (tierW * 0.4) + (sevW * 0.3) + (sentW * 0.2) + (ageW * 0.1);
      return Math.round(score * 10) / 10;
    });

    // Step 6: Store in D1
    await step.do("store-results", async () => {
      const arrEstimate = TIER_ARR[feedback.customer_tier.toLowerCase()] || 0;
      
      await this.env.DB.prepare(`
        UPDATE feedback SET
          sentiment = ?,
          sentiment_score = ?,
          urgency = ?,
          themes = ?,
          summary = ?,
          priority_score = ?,
          arr_estimate = ?,
          processed_at = ?
        WHERE id = ?
      `).bind(
        sentiment.sentiment,
        sentiment.score,
        urgency.urgency,
        JSON.stringify(themes.themes),
        summaryResult,
        priorityScore,
        arrEstimate,
        new Date().toISOString(),
        feedback.id
      ).run();
    });

    return { id: feedback.id, sentiment, themes, urgency, summary: summaryResult, priorityScore };
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================
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
        const normalizedTier = (customer_tier || 'free').toLowerCase().trim();
        const created_at = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
        const arrEstimate = TIER_ARR[normalizedTier] || 0;

        await env.DB.prepare(
          `INSERT INTO feedback (id, source, content, content_hash, author, customer_tier, arr_estimate, created_at) VALUES (?,?,?,?,?,?,?,?)`
        ).bind(id, sourceName, content.trim(), contentHash, author || 'anonymous', normalizedTier, arrEstimate, created_at).run();

        await env.MY_WORKFLOW.create({ params: { id, source: sourceName, content: content.trim(), customer_tier: normalizedTier, created_at } });
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
      if (path === "/" || path === "/index.html") {
        return new Response(getHTML(env), { headers: { "Content-Type": "text/html", ...cors } });
      }

      if (path === "/api/feedback" && req.method === "GET") {
        const source = url.searchParams.get("source");
        const urgency = url.searchParams.get("urgency");
        const sentiment = url.searchParams.get("sentiment");
        const theme = url.searchParams.get("theme");
        
        let query = "SELECT * FROM feedback WHERE 1=1";
        const params: string[] = [];
        
        if (source) { query += " AND source=?"; params.push(source); }
        if (urgency) { query += " AND urgency=?"; params.push(urgency); }
        if (sentiment) { query += " AND sentiment=?"; params.push(sentiment); }
        if (theme) { query += " AND themes LIKE ?"; params.push(`%${theme}%`); }
        
        query += " ORDER BY priority_score DESC, created_at DESC LIMIT 100";
        
        const result = await env.DB.prepare(query).bind(...params).all();
        return Response.json(result.results, { headers: cors });
      }

      if (path === "/api/feedback" && req.method === "POST") {
        const body = await req.json() as any;
        const id = crypto.randomUUID();
        const created_at = new Date().toISOString();
        const contentHash = await hashContent(body.content);
        const normalizedTier = (body.customer_tier || 'free').toLowerCase();
        const arrEstimate = TIER_ARR[normalizedTier] || 0;
        
        await env.DB.prepare(
          `INSERT INTO feedback (id,source,content,content_hash,author,customer_tier,arr_estimate,created_at) VALUES (?,?,?,?,?,?,?,?)`
        ).bind(id, body.source||"manual", body.content, contentHash, body.author||"anonymous", normalizedTier, arrEstimate, created_at).run();
        
        const instance = await env.MY_WORKFLOW.create({ params: { id, source: body.source||"manual", content: body.content, customer_tier: normalizedTier, created_at } });
        return Response.json({ id, workflowId: instance.id, status: "processing" }, { headers: cors });
      }

      if (path === "/api/import" && req.method === "POST") {
        if (!env.SPREADSHEET_ID || !env.SHEETS_API_KEY) {
          return Response.json({ error: "Google Sheets not configured" }, { status: 400, headers: cors });
        }
        const result = await importFromSheets(env);
        return Response.json({ success: true, message: `Imported ${result.imported} items`, ...result }, { headers: cors });
      }

      // Enhanced insights endpoint
      if (path === "/api/insights") {
        // Basic stats
        const stats = await env.DB.prepare(`
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN urgency='critical' THEN 1 ELSE 0 END) as critical,
            SUM(CASE WHEN urgency='high' THEN 1 ELSE 0 END) as high,
            SUM(CASE WHEN urgency='medium' THEN 1 ELSE 0 END) as medium,
            SUM(CASE WHEN urgency='low' THEN 1 ELSE 0 END) as low,
            SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) as negative,
            SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) as positive,
            SUM(CASE WHEN sentiment='neutral' THEN 1 ELSE 0 END) as neutral,
            ROUND(AVG(sentiment_score), 2) as avg_sentiment,
            SUM(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END) as processing
          FROM feedback
        `).first();

        // By source with critical counts
        const bySource = await env.DB.prepare(`
          SELECT source, 
            COUNT(*) as count,
            SUM(CASE WHEN urgency='critical' THEN 1 ELSE 0 END) as critical,
            SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) as negative
          FROM feedback GROUP BY source
        `).all();

        // By customer tier with ARR at risk
        const byTier = await env.DB.prepare(`
          SELECT customer_tier,
            COUNT(*) as count,
            SUM(CASE WHEN urgency='critical' THEN 1 ELSE 0 END) as critical,
            SUM(CASE WHEN urgency IN ('critical', 'high') AND sentiment='negative' THEN arr_estimate ELSE 0 END) as arr_at_risk
          FROM feedback GROUP BY customer_tier
        `).all();

        // Theme analysis
        const allFeedback = await env.DB.prepare(`SELECT themes FROM feedback WHERE themes IS NOT NULL`).all();
        const themeCounts: Record<string, number> = {};
        for (const row of allFeedback.results as any[]) {
          try {
            const themes = JSON.parse(row.themes);
            for (const theme of themes) {
              themeCounts[theme] = (themeCounts[theme] || 0) + 1;
            }
          } catch {}
        }
        const topThemes = Object.entries(themeCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([theme, count]) => ({ theme, count }));

        // Severity distribution
        const severityDist = await env.DB.prepare(`
          SELECT urgency, COUNT(*) as count,
            ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM feedback WHERE urgency IS NOT NULL), 1) as percentage
          FROM feedback WHERE urgency IS NOT NULL GROUP BY urgency
          ORDER BY CASE urgency WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
        `).all();

        // Recent critical items
        const recentCritical = await env.DB.prepare(`
          SELECT * FROM feedback WHERE urgency='critical' ORDER BY created_at DESC LIMIT 5
        `).all();

        // High priority items (top 10 by priority score)
        const highPriority = await env.DB.prepare(`
          SELECT * FROM feedback WHERE priority_score IS NOT NULL ORDER BY priority_score DESC LIMIT 10
        `).all();

        // Temporal pattern (last 7 days)
        const temporal = await env.DB.prepare(`
          SELECT DATE(created_at) as date,
            COUNT(*) as total,
            SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) as negative
          FROM feedback 
          WHERE created_at >= datetime('now', '-7 days')
          GROUP BY DATE(created_at)
          ORDER BY date DESC
        `).all();

        // Total ARR at risk
        const arrAtRisk = await env.DB.prepare(`
          SELECT SUM(arr_estimate) as total_arr_at_risk
          FROM feedback 
          WHERE urgency IN ('critical', 'high') AND sentiment = 'negative'
        `).first();

        return Response.json({ 
          stats, 
          bySource: bySource.results,
          byTier: byTier.results,
          topThemes,
          severityDist: severityDist.results,
          recentCritical: recentCritical.results,
          highPriority: highPriority.results,
          temporal: temporal.results,
          arrAtRisk: (arrAtRisk as any)?.total_arr_at_risk || 0
        }, { headers: cors });
      }

      // Theme clustering endpoint
      if (path === "/api/themes") {
        const theme = url.searchParams.get("theme");
        if (!theme) {
          return Response.json({ error: "Theme parameter required" }, { status: 400, headers: cors });
        }
        
        const items = await env.DB.prepare(`
          SELECT * FROM feedback WHERE themes LIKE ? ORDER BY priority_score DESC, urgency, created_at DESC
        `).bind(`%${theme}%`).all();
        
        return Response.json(items.results, { headers: cors });
      }

      if (path === "/api/clear" && req.method === "POST") {
        await env.DB.prepare('DELETE FROM feedback').run();
        return Response.json({ success: true }, { headers: cors });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers: cors });
    } catch (error: any) {
      console.error('Error:', error);
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

// ============================================
// HTML UI - Enhanced Dashboard
// ============================================
function getHTML(env: Env) {
  const configured = !!(env.SPREADSHEET_ID && env.SHEETS_API_KEY);
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback Intel | PM Dashboard</title>
<style>
:root{--bg:#0a0a0a;--card:#1a1a1a;--border:#2a2a2a;--text:#e5e5e5;--muted:#888;--orange:#f6821f;--red:#ef4444;--yellow:#f59e0b;--green:#22c55e;--blue:#3b82f6}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
.container{max-width:1400px;margin:0 auto;padding:20px}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:16px}
h1{font-size:24px;color:var(--orange);display:flex;align-items:center;gap:10px}
h1 span{font-size:12px;color:var(--muted);font-weight:normal}
.header-actions{display:flex;gap:10px;flex-wrap:wrap}
.btn{background:var(--orange);color:#000;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-weight:600;font-size:14px;transition:all 0.2s}
.btn:hover{background:#ff9a47;transform:translateY(-1px)}
.btn:disabled{background:#555;cursor:not-allowed;transform:none}
.btn-secondary{background:var(--card);color:#fff;border:1px solid var(--border)}
.btn-danger{background:#7f1d1d;color:#fff}

/* Config Banner */
.config-banner{background:#1e3a5f;border:1px solid var(--blue);padding:16px;border-radius:8px;margin-bottom:24px}
.config-banner.success{background:#14532d;border-color:var(--green)}
.config-banner code{background:#000;padding:2px 6px;border-radius:4px;font-size:12px}

/* Critical Insights Panel */
.insights-panel{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border:1px solid #e94560;border-radius:12px;padding:20px;margin-bottom:24px}
.insights-panel h2{color:#e94560;font-size:16px;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.insight-item{background:rgba(0,0,0,0.3);border-radius:8px;padding:14px;margin-bottom:12px}
.insight-item:last-child{margin-bottom:0}
.insight-title{font-weight:600;color:#fff;margin-bottom:6px;display:flex;align-items:center;gap:8px}
.insight-title .badge{font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500}
.insight-title .badge.critical{background:var(--red);color:#fff}
.insight-title .badge.warning{background:var(--yellow);color:#000}
.insight-title .badge.info{background:var(--blue);color:#fff}
.insight-desc{font-size:13px;color:#aaa;margin-bottom:8px}
.insight-action{font-size:12px;color:var(--orange);font-weight:500}

/* Stats Grid */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.stat-card{background:var(--card);padding:20px;border-radius:10px;border:1px solid var(--border)}
.stat-card h3{font-size:12px;color:var(--muted);text-transform:uppercase;margin-bottom:8px}
.stat-value{font-size:36px;font-weight:700}
.stat-sub{font-size:12px;color:var(--muted);margin-top:4px}
.stat-card.critical{border-color:var(--red)}
.stat-card.critical .stat-value{color:var(--red)}
.stat-card.warning .stat-value{color:var(--yellow)}
.stat-card.success .stat-value{color:var(--green)}
.stat-card.info .stat-value{color:var(--blue)}

/* Two Column Layout */
.dashboard-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px}
@media(max-width:1024px){.dashboard-grid{grid-template-columns:1fr}}

/* Panels */
.panel{background:var(--card);border-radius:10px;border:1px solid var(--border);overflow:hidden}
.panel-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.panel-header h2{font-size:16px;font-weight:600}
.panel-body{padding:20px}

/* Tables */
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table th,.data-table td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--border)}
.data-table th{color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase}
.data-table tr:hover{background:rgba(255,255,255,0.02)}

/* Progress Bars */
.progress-bar{height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:6px}
.progress-fill{height:100%;border-radius:3px}

/* Theme Tags */
.theme-grid{display:flex;flex-wrap:wrap;gap:8px}
.theme-tag{background:var(--border);padding:8px 14px;border-radius:6px;font-size:13px;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;gap:8px}
.theme-tag:hover{background:#333;transform:translateY(-2px)}
.theme-tag .count{background:var(--orange);color:#000;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}

/* Feedback List */
.feedback-list{display:flex;flex-direction:column;gap:12px;max-height:600px;overflow-y:auto}
.feedback-item{background:var(--card);padding:16px;border-radius:8px;border:1px solid var(--border);transition:all 0.2s}
.feedback-item:hover{border-color:#444}
.feedback-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;flex-wrap:wrap;gap:8px}
.feedback-source{padding:4px 10px;border-radius:4px;font-size:11px;text-transform:uppercase;font-weight:600}
.feedback-source.support{background:#7f1d1d;color:#fca5a5}
.feedback-source.discord{background:#5865F2;color:#fff}
.feedback-source.github{background:#238636;color:#fff}
.feedback-source.twitter{background:#1d9bf0;color:#fff}
.feedback-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.priority-badge{background:var(--orange);color:#000;padding:4px 10px;border-radius:4px;font-size:11px;font-weight:700}
.feedback-content{color:#ccc;margin-bottom:12px;font-size:14px}
.feedback-tags{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.tag{padding:4px 10px;border-radius:4px;font-size:11px;font-weight:600}
.tag.critical{background:#7f1d1d;color:#fca5a5}
.tag.high{background:#78350f;color:#fcd34d}
.tag.medium{background:#1e3a5f;color:#93c5fd}
.tag.low{background:#1f2937;color:#9ca3af}
.tag.positive{background:#14532d;color:#86efac}
.tag.negative{background:#7f1d1d;color:#fca5a5}
.tag.neutral{background:#374151;color:#9ca3af}
.tag.theme{background:#312e81;color:#a5b4fc}
.feedback-summary{font-style:italic;color:var(--muted);font-size:13px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
.feedback-footer{display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--muted)}
.arr-badge{color:var(--green);font-weight:600}

/* Filters */
.filters{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;align-items:center}
.filters label{font-size:12px;color:var(--muted)}
select{background:var(--card);color:#fff;border:1px solid var(--border);padding:8px 12px;border-radius:6px;font-size:13px}

/* Toast */
.toast{position:fixed;bottom:20px;right:20px;background:var(--card);border:1px solid var(--border);padding:16px 24px;border-radius:8px;z-index:1000;display:none;box-shadow:0 10px 40px rgba(0,0,0,0.5)}
.toast.show{display:block}
.toast.success{border-color:var(--green)}
.toast.error{border-color:var(--red)}

/* Loading */
.loading{text-align:center;padding:40px;color:var(--muted)}
.spinner{display:inline-block;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--orange);border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* Temporal Chart */
.temporal-chart{display:flex;align-items:flex-end;gap:8px;height:100px;padding:10px 0}
.temporal-bar{flex:1;background:var(--border);border-radius:4px 4px 0 0;position:relative;min-width:30px}
.temporal-bar .negative{position:absolute;bottom:0;left:0;right:0;background:var(--red);border-radius:0 0 4px 4px;opacity:0.7}
.temporal-bar .date{position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);font-size:10px;color:var(--muted);white-space:nowrap}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🔥 Feedback Intel <span>AI-Powered PM Dashboard</span></h1>
    <div class="header-actions">
      <button class="btn" onclick="importFromSheets()" id="importBtn" ${!configured?'disabled':''}>📥 Import</button>
      <button class="btn btn-secondary" onclick="refreshData()">🔄 Refresh</button>
      <button class="btn btn-danger" onclick="clearData()">🗑️ Clear</button>
    </div>
  </header>

  ${!configured?`<div class="config-banner"><strong>⚙️ Setup Required</strong><p style="margin-top:8px;font-size:14px">Set <code>SPREADSHEET_ID</code> and <code>SHEETS_API_KEY</code> secrets</p></div>`
  :`<div class="config-banner success"><strong>✅ Google Sheets Connected</strong><p style="margin-top:8px;font-size:14px">Auto-import runs daily at 9am UTC. Click Import for manual sync.</p></div>`}

  <!-- Critical Insights Panel -->
  <div class="insights-panel" id="insightsPanel">
    <h2>🚨 CRITICAL FINDINGS</h2>
    <div id="insightsList"><div class="loading"><span class="spinner"></span> Analyzing feedback...</div></div>
  </div>

  <!-- Stats Grid -->
  <div class="stats-grid" id="statsGrid">
    <div class="stat-card"><h3>Total Feedback</h3><div class="stat-value">-</div></div>
    <div class="stat-card critical"><h3>Critical Issues</h3><div class="stat-value">-</div></div>
    <div class="stat-card warning"><h3>ARR at Risk</h3><div class="stat-value">-</div></div>
    <div class="stat-card success"><h3>Positive</h3><div class="stat-value">-</div></div>
  </div>

  <!-- Two Column Layout -->
  <div class="dashboard-grid">
    <!-- Left Column -->
    <div>
      <!-- Severity Distribution -->
      <div class="panel" style="margin-bottom:24px">
        <div class="panel-header"><h2>📊 Severity Distribution</h2></div>
        <div class="panel-body" id="severityDist"></div>
      </div>

      <!-- Channel Analysis -->
      <div class="panel" style="margin-bottom:24px">
        <div class="panel-header"><h2>📡 Channel Analysis</h2></div>
        <div class="panel-body">
          <table class="data-table" id="channelTable">
            <thead><tr><th>Channel</th><th>Total</th><th>Critical</th><th>Negative</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>

      <!-- Customer Tier Risk -->
      <div class="panel">
        <div class="panel-header"><h2>💰 Customer Tier Risk</h2></div>
        <div class="panel-body">
          <table class="data-table" id="tierTable">
            <thead><tr><th>Tier</th><th>Count</th><th>Critical</th><th>ARR at Risk</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Right Column -->
    <div>
      <!-- Theme Clustering -->
      <div class="panel" style="margin-bottom:24px">
        <div class="panel-header"><h2>🏷️ Theme Clusters</h2></div>
        <div class="panel-body">
          <div class="theme-grid" id="themeGrid"></div>
        </div>
      </div>

      <!-- Temporal Pattern -->
      <div class="panel">
        <div class="panel-header"><h2>📈 7-Day Trend</h2></div>
        <div class="panel-body">
          <div class="temporal-chart" id="temporalChart"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Feedback List -->
  <div class="panel">
    <div class="panel-header">
      <h2>📝 Feedback Items</h2>
      <div class="filters">
        <select id="sourceFilter" onchange="applyFilters()">
          <option value="">All Sources</option>
          <option value="support">Support</option>
          <option value="github">GitHub</option>
          <option value="discord">Discord</option>
          <option value="twitter">Twitter</option>
        </select>
        <select id="urgencyFilter" onchange="applyFilters()">
          <option value="">All Urgency</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select id="sentimentFilter" onchange="applyFilters()">
          <option value="">All Sentiment</option>
          <option value="positive">Positive</option>
          <option value="negative">Negative</option>
          <option value="neutral">Neutral</option>
        </select>
      </div>
    </div>
    <div class="panel-body">
      <div class="feedback-list" id="feedbackList"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let insightsData = null;

function showToast(m,t='success'){const e=document.getElementById('toast');e.textContent=m;e.className='toast show '+t;setTimeout(()=>e.className='toast',3000)}

function formatCurrency(n){return n>=1000?'$'+(n/1000).toFixed(0)+'K':'$'+n}

async function fetchInsights(){
  try{
    const r=await fetch('/api/insights');
    insightsData=await r.json();
    renderInsights();
    renderStats();
    renderSeverity();
    renderChannels();
    renderTiers();
    renderThemes();
    renderTemporal();
  }catch(e){console.error(e)}
}

function renderInsights(){
  const d=insightsData;
  if(!d||!d.stats)return;
  
  const insights=[];
  
  // Enterprise at risk
  const entTier=d.byTier?.find(t=>t.customer_tier==='enterprise');
  if(entTier?.critical>0){
    insights.push({
      badge:'critical',
      title:'Enterprise SLA Risk',
      desc:\`\${entTier.critical} critical issues from Enterprise customers. \${formatCurrency(entTier.arr_at_risk||0)} ARR at risk.\`,
      action:'→ ACTION: Escalate to VP Eng + Legal review for SLA credit policy'
    });
  }
  
  // Reliability pattern
  const relTheme=d.topThemes?.find(t=>t.theme==='reliability');
  if(relTheme?.count>=3){
    insights.push({
      badge:'warning',
      title:'Reliability Pattern Detected',
      desc:\`\${relTheme.count} feedback items tagged "reliability". Indicates potential infrastructure issues.\`,
      action:'→ ACTION: Investigate recent deployments and infrastructure changes'
    });
  }
  
  // Documentation debt
  const docTheme=d.topThemes?.find(t=>t.theme==='documentation');
  if(docTheme?.count>=3){
    insights.push({
      badge:'info',
      title:'Documentation Debt',
      desc:\`\${docTheme.count} complaints about documentation (outdated, confusing, incomplete).\`,
      action:'→ ACTION: Audit docs older than 90 days, prioritize rewrites'
    });
  }
  
  // Negative sentiment spike
  if(d.stats.negative>d.stats.positive){
    insights.push({
      badge:'warning',
      title:'Negative Sentiment Exceeds Positive',
      desc:\`\${d.stats.negative} negative vs \${d.stats.positive} positive (\${Math.round(d.stats.negative/(d.stats.total||1)*100)}% negative rate).\`,
      action:'→ ACTION: Review recent product changes, investigate root causes'
    });
  }
  
  // High priority concentration
  if(d.stats.high>=d.stats.total*0.4){
    insights.push({
      badge:'warning',
      title:'High Severity Concentration',
      desc:\`\${Math.round((d.stats.high+d.stats.critical)/(d.stats.total||1)*100)}% of feedback is HIGH or CRITICAL severity.\`,
      action:'→ ACTION: Review severity tagging criteria or address systemic issues'
    });
  }
  
  if(insights.length===0){
    insights.push({
      badge:'info',
      title:'No Critical Issues Detected',
      desc:'Feedback patterns look healthy. Continue monitoring.',
      action:'→ Keep up the good work!'
    });
  }
  
  document.getElementById('insightsList').innerHTML=insights.map(i=>\`
    <div class="insight-item">
      <div class="insight-title"><span class="badge \${i.badge}">\${i.badge.toUpperCase()}</span>\${i.title}</div>
      <div class="insight-desc">\${i.desc}</div>
      <div class="insight-action">\${i.action}</div>
    </div>
  \`).join('');
}

function renderStats(){
  const d=insightsData;
  if(!d?.stats)return;
  document.getElementById('statsGrid').innerHTML=\`
    <div class="stat-card"><h3>Total Feedback</h3><div class="stat-value">\${d.stats.total||0}</div><div class="stat-sub">\${d.stats.processing||0} processing</div></div>
    <div class="stat-card critical"><h3>Critical Issues</h3><div class="stat-value">\${d.stats.critical||0}</div><div class="stat-sub">\${d.stats.high||0} high severity</div></div>
    <div class="stat-card warning"><h3>ARR at Risk</h3><div class="stat-value">\${formatCurrency(d.arrAtRisk||0)}</div><div class="stat-sub">From negative+critical</div></div>
    <div class="stat-card success"><h3>Sentiment</h3><div class="stat-value">\${d.stats.positive||0}👍</div><div class="stat-sub">\${d.stats.negative||0} negative, \${d.stats.neutral||0} neutral</div></div>
  \`;
}

function renderSeverity(){
  const d=insightsData?.severityDist;
  if(!d?.length){document.getElementById('severityDist').innerHTML='<div class="loading">No data</div>';return;}
  const colors={critical:'#ef4444',high:'#f59e0b',medium:'#3b82f6',low:'#6b7280'};
  const total=d.reduce((a,b)=>a+(b.count||0),0);
  document.getElementById('severityDist').innerHTML=d.map(s=>\`
    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
        <span style="text-transform:uppercase;font-weight:600">\${s.urgency}</span>
        <span>\${s.count} (\${s.percentage||0}%)</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:\${(s.count/total)*100}%;background:\${colors[s.urgency]||'#666'}"></div></div>
    </div>
  \`).join('');
}

function renderChannels(){
  const d=insightsData?.bySource;
  if(!d?.length)return;
  document.querySelector('#channelTable tbody').innerHTML=d.map(s=>\`
    <tr>
      <td><span class="feedback-source \${s.source}">\${s.source}</span></td>
      <td>\${s.count}</td>
      <td style="color:\${s.critical>0?'#ef4444':'inherit'}">\${s.critical||0}</td>
      <td style="color:\${s.negative>0?'#f59e0b':'inherit'}">\${s.negative||0}</td>
    </tr>
  \`).join('');
}

function renderTiers(){
  const d=insightsData?.byTier;
  if(!d?.length)return;
  document.querySelector('#tierTable tbody').innerHTML=d.map(t=>\`
    <tr>
      <td style="text-transform:capitalize;font-weight:600">\${t.customer_tier}</td>
      <td>\${t.count}</td>
      <td style="color:\${t.critical>0?'#ef4444':'inherit'}">\${t.critical||0}</td>
      <td class="arr-badge">\${formatCurrency(t.arr_at_risk||0)}</td>
    </tr>
  \`).join('');
}

function renderThemes(){
  const d=insightsData?.topThemes;
  if(!d?.length){document.getElementById('themeGrid').innerHTML='<div class="loading">No themes</div>';return;}
  document.getElementById('themeGrid').innerHTML=d.map(t=>\`
    <div class="theme-tag" onclick="filterByTheme('\${t.theme}')">\${t.theme}<span class="count">\${t.count}</span></div>
  \`).join('');
}

function renderTemporal(){
  const d=insightsData?.temporal;
  if(!d?.length){document.getElementById('temporalChart').innerHTML='<div class="loading">No data</div>';return;}
  const max=Math.max(...d.map(t=>t.total||1));
  document.getElementById('temporalChart').innerHTML=d.reverse().map(t=>{
    const h=(t.total/max)*100;
    const nh=(t.negative/t.total)*h;
    const date=new Date(t.date).toLocaleDateString('en-US',{month:'short',day:'numeric'});
    return \`<div class="temporal-bar" style="height:\${h}%" title="\${t.total} total, \${t.negative} negative"><div class="negative" style="height:\${nh}%"></div><span class="date">\${date}</span></div>\`;
  }).join('');
}

function filterByTheme(theme){
  document.getElementById('sourceFilter').value='';
  document.getElementById('urgencyFilter').value='';
  document.getElementById('sentimentFilter').value='';
  fetchFeedback({theme});
}

async function fetchFeedback(f={}){
  try{
    const p=new URLSearchParams(f);
    const r=await fetch('/api/feedback?'+p);
    const d=await r.json();
    renderFeedback(d);
  }catch(e){document.getElementById('feedbackList').innerHTML='<div class="loading">Error loading</div>';}
}

function renderFeedback(items){
  if(!items?.length){document.getElementById('feedbackList').innerHTML='<div class="loading">No feedback. Import from Sheets to start.</div>';return;}
  document.getElementById('feedbackList').innerHTML=items.map(i=>{
    const themes=i.themes?JSON.parse(i.themes):[];
    const priority=i.priority_score?i.priority_score.toFixed(1):'?';
    const arr=i.arr_estimate||0;
    return \`
    <div class="feedback-item">
      <div class="feedback-header">
        <div class="feedback-meta">
          <span class="priority-badge">P:\${priority}</span>
          <span class="feedback-source \${i.source}">\${i.source}</span>
          <span style="color:#888;font-size:12px">\${i.customer_tier}</span>
        </div>
        <span style="color:#666;font-size:12px">\${i.author||'anon'} · \${new Date(i.created_at).toLocaleDateString()}</span>
      </div>
      <div class="feedback-content">\${i.content}</div>
      <div class="feedback-tags">
        \${i.urgency?\`<span class="tag \${i.urgency}">\${i.urgency.toUpperCase()}</span>\`:'<span class="tag">Processing...</span>'}
        \${i.sentiment?\`<span class="tag \${i.sentiment}">\${i.sentiment}</span>\`:''}
        \${themes.map(t=>\`<span class="tag theme">\${t}</span>\`).join('')}
      </div>
      \${i.summary?\`<div class="feedback-summary">"\${i.summary}"</div>\`:''}
      <div class="feedback-footer">
        <span>\${arr>0?\`<span class="arr-badge">\${formatCurrency(arr)} ARR</span>\`:'Free tier'}</span>
        <span>ID: \${i.id.substring(0,8)}...</span>
      </div>
    </div>
  \`;}).join('');
}

function applyFilters(){
  const f={};
  const source=document.getElementById('sourceFilter').value;
  const urgency=document.getElementById('urgencyFilter').value;
  const sentiment=document.getElementById('sentimentFilter').value;
  if(source)f.source=source;
  if(urgency)f.urgency=urgency;
  if(sentiment)f.sentiment=sentiment;
  fetchFeedback(f);
}

async function importFromSheets(){
  const b=document.getElementById('importBtn');
  b.disabled=true;b.textContent='⏳ Importing...';
  try{
    const r=await fetch('/api/import',{method:'POST'});
    const d=await r.json();
    if(d.error)showToast(d.error,'error');
    else{showToast(\`Imported \${d.imported} items!\`,'success');setTimeout(refreshData,3000);}
  }catch(e){showToast('Failed','error');}
  finally{b.disabled=false;b.textContent='📥 Import';}
}

async function clearData(){
  if(!confirm('Delete all feedback?'))return;
  try{await fetch('/api/clear',{method:'POST'});showToast('Cleared');refreshData();}
  catch(e){showToast('Failed','error');}
}

function refreshData(){fetchInsights();applyFilters();}

refreshData();
setInterval(refreshData,30000);
</script>
</body></html>`;
}
