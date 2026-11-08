import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

type Item = {
  id: string;
  owner_id: string;
  type: 'lost' | 'found';
  name: string;
  category: string;
  color: string;
  location: string;
  description: string;
  image_path: string;
  report_date: string;
  status: string;
};
type Pair = { lost: Item; found: Item; score: number; reasons: string[] };

function words(text: string): Set<string> {
  const ignored = new Set(['the','and','with','from','near','outside','inside','found','lost','has','was','item','for','this','that','small','a','an','on','in','of','to','at','by']);
  return new Set((text || '').toLowerCase().match(/[a-z0-9]+/g)?.filter(word => word.length > 2 && !ignored.has(word)) || []);
}
function localScore(lost: Item, found: Item): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (lost.category.toLowerCase() === found.category.toLowerCase()) { score += 24; reasons.push('same item category'); }
  else if (lost.category.toLowerCase() === 'other' || found.category.toLowerCase() === 'other') score += 6;
  const colorA = words(lost.color), colorB = words(found.color);
  const colorOverlap = [...colorA].filter(word => colorB.has(word));
  if (colorOverlap.length) { score += 15; reasons.push('color detail overlaps'); }
  const locationA = words(lost.location), locationB = words(found.location);
  const locationOverlap = [...locationA].filter(word => locationB.has(word));
  if (locationOverlap.length) { score += Math.min(22, 10 + locationOverlap.length * 6); reasons.push('place details overlap'); }
  const detailsA = words(`${lost.name} ${lost.description}`), detailsB = words(`${found.name} ${found.description}`);
  const detailOverlap = [...detailsA].filter(word => detailsB.has(word));
  if (detailOverlap.length) { score += Math.min(29, 5 + detailOverlap.length * 5); reasons.push(`${detailOverlap.length} description clue(s) overlap`); }
  const dateGap = Math.abs(Date.parse(`${lost.report_date}T00:00:00Z`) - Date.parse(`${found.report_date}T00:00:00Z`)) / 86400000;
  if (dateGap <= 1) { score += 10; reasons.push('reported around the same day'); }
  else if (dateGap <= 4) score += 6;
  else if (dateGap <= 8) score += 2;
  return { score: Math.min(92, score), reasons };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

async function geminiScore(admin: ReturnType<typeof createClient>, pair: Pair): Promise<{ score: number; reasons: string[] } | null> {
  const apiKey = Deno.env.get('GEMINI_API_KEY')?.trim();
  if (!apiKey) return null;
  const imageParts: Array<Record<string, string>> = [];
  for (const item of [pair.lost, pair.found]) {
    const { data, error } = await admin.storage.from('item-photos').download(item.image_path);
    if (error || !data || data.size > 1_500_000) {
      imageParts.push({ type: 'text', text: 'Photo unavailable for this report.' });
      continue;
    }
    imageParts.push({ type: 'image', mime_type: data.type || 'image/jpeg', data: toBase64(new Uint8Array(await data.arrayBuffer())) });
  }
  const prompt = `Compare these two item reports and their photos. Estimate whether they may be the same physical item. Give a cautious integer fit score from 0 to 100 and up to three brief evidence reasons. Compare item identity, category, color, distinctive marks, place, and date. A low-quality or unhelpful photo should not force a match. Do not infer who owns an item. Do not include personal contact details.\nLOST REPORT: ${JSON.stringify({ name: pair.lost.name, category: pair.lost.category, color: pair.lost.color, location: pair.lost.location, description: pair.lost.description, date: pair.lost.report_date })}\nFOUND REPORT: ${JSON.stringify({ name: pair.found.name, category: pair.found.category, color: pair.found.color, location: pair.found.location, description: pair.found.description, date: pair.found.report_date })}`;
  const schema = {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 100 },
      reasons: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    },
    required: ['score', 'reasons'],
  };
  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-3.8-flash';
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'Api-Revision': '2026-05-20' },
    body: JSON.stringify({
      model,
      input: [{ type: 'text', text: prompt }, ...imageParts],
      store: false,
      response_format: { type: 'text', mime_type: 'application/json', schema },
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`Gemini returned ${response.status}`);
  const result = await response.json();
  const text = result.output_text || result.steps?.find((step: { type?: string }) => step.type === 'model_output')?.text;
  if (!text) throw new Error('Gemini returned no match result');
  const parsed = JSON.parse(text);
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.filter((reason: unknown): reason is string => typeof reason === 'string').slice(0, 3).map((reason: string) => reason.slice(0, 120)) : [];
  if (!Number.isFinite(score)) throw new Error('Gemini returned an invalid score');
  return { score, reasons };
}

async function analyzeCandidates(admin: ReturnType<typeof createClient>, pairs: Pair[]) {
  await Promise.all(pairs.map(async pair => {
    try {
      const ai = await geminiScore(admin, pair);
      if (!ai) return;
      const blended = Math.max(0, Math.min(100, Math.round(pair.score * 0.32 + ai.score * 0.68)));
      await admin.from('matches').upsert({
        lost_report_id: pair.lost.id,
        found_report_id: pair.found.id,
        score: blended,
        reasons: ai.reasons.length ? ai.reasons : pair.reasons,
        engine: 'Gemini AI',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'lost_report_id,found_report_id' });
    } catch (error) {
      console.error('Gemini pair analysis failed:', error);
    }
  }));
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST only.' }, 405);
  const projectUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const publicKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!projectUrl || !serviceKey || !publicKey || !token) return json({ error: 'Function authentication is not configured.' }, 500);

  const userClient = createClient(projectUrl, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return json({ error: 'Sign in to match your report.' }, 401);

  let reportId = '';
  try { reportId = (await request.json()).reportId; } catch { return json({ error: 'Invalid request.' }, 400); }
  if (typeof reportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(reportId)) return json({ error: 'Invalid report ID.' }, 400);

  const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: report, error: reportError } = await admin.from('reports').select('*').eq('id', reportId).maybeSingle();
  if (reportError || !report) return json({ error: 'Report not found.' }, 404);
  if (report.owner_id !== authData.user.id) return json({ error: 'You can only match your own report.' }, 403);
  if (report.status !== 'open') return json({ error: 'This report is closed.' }, 409);

  const oppositeType = report.type === 'lost' ? 'found' : 'lost';
  const { data: candidates, error: candidatesError } = await admin.from('reports').select('*')
    .eq('type', oppositeType).eq('status', 'open').neq('owner_id', report.owner_id)
    .order('created_at', { ascending: false }).limit(200);
  if (candidatesError) return json({ error: 'Could not read the open reports.' }, 500);

  const pairs: Pair[] = (candidates || []).map((candidate: Item) => {
    const lost = report.type === 'lost' ? report as Item : candidate;
    const found = report.type === 'found' ? report as Item : candidate;
    const local = localScore(lost, found);
    return { lost, found, ...local };
  }).sort((a, b) => b.score - a.score);

  const localRows = pairs.filter(pair => pair.score >= 18).slice(0, 20).map(pair => ({
    lost_report_id: pair.lost.id,
    found_report_id: pair.found.id,
    score: pair.score,
    reasons: pair.reasons,
    engine: 'Local match',
    updated_at: new Date().toISOString(),
  }));
  if (localRows.length) {
    const { error } = await admin.from('matches').upsert(localRows, { onConflict: 'lost_report_id,found_report_id' });
    if (error) return json({ error: 'Could not save local match suggestions.' }, 500);
  }

  const hasGemini = Boolean(Deno.env.get('GEMINI_API_KEY')?.trim());
  if (hasGemini) {
    const job = analyzeCandidates(admin, pairs.slice(0, 4));
    const edgeRuntime = (globalThis as typeof globalThis & { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(job);
    else await job;
  }
  return json({ ok: true, local_matches: localRows.length, ai_enabled: hasGemini, ai_candidates: hasGemini ? Math.min(4, pairs.length) : 0 }, 202);
});
