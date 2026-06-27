// Server-side proxy so PIPELINE_SECRET never reaches the browser.
//
// POST /api/pipeline        — create song stub + queue pipeline job
//   body: { title, artist?, yt_url, prim_lang?, trans_lang?, tags? }
//   returns: { song_id, status: 'queued' }
//
// GET  /api/pipeline?id=... — poll pipeline status for a song
//   returns: { status, pipeline_log }

import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/vocal-hero/supabaseClient';

const PIPELINE_URL    = process.env.PIPELINE_URL    ?? 'http://localhost:8000';
const PIPELINE_SECRET = process.env.PIPELINE_SECRET ?? 'dev-secret';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { title, artist = '', yt_url, prim_lang = 'en', trans_lang = 'none', tags = '' } = body;

    if (!yt_url?.trim())   return NextResponse.json({ error: 'yt_url is required' },  { status: 400 });
    if (!title?.trim())    return NextResponse.json({ error: 'title is required' },    { status: 400 });

    // 1. Create song stub in Supabase
    const sb = getServiceClient();
    const { data: song, error: insertErr } = await sb
      .from('vh_songs')
      .insert({ title: title.trim(), artist, prim_lang, trans_lang, tags, status: 'draft', yt_url: yt_url.trim() })
      .select()
      .single();
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

    // 2. Kick off Python pipeline
    const pipelineRes = await fetch(`${PIPELINE_URL}/pipeline/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PIPELINE_SECRET,
      },
      body: JSON.stringify({
        song_id:    song.id,
        yt_url:     yt_url.trim(),
        prim_lang,
        trans_lang,
      }),
    });

    if (!pipelineRes.ok) {
      const txt = await pipelineRes.text();
      // Mark song as error so the UI can show it
      await sb.from('vh_songs').update({ status: 'error', pipeline_log: txt }).eq('id', song.id);
      return NextResponse.json({ error: `Pipeline error: ${txt}` }, { status: 502 });
    }

    return NextResponse.json({ song_id: song.id, status: 'queued' }, { status: 202 });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  try {
    // Forward to Python pipeline for live log, but also read from Supabase
    // (Supabase is the source of truth; pipeline status is a nice-to-have)
    const sb = getServiceClient();
    const { data, error } = await sb
      .from('vh_songs')
      .select('id, status, pipeline_log, title, artist')
      .eq('id', id)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json(data);
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
