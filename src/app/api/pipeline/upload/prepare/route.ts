// POST /api/pipeline/upload/prepare
// Creates a song stub in Supabase and returns the direct pipeline upload URL
// so the browser can stream the file straight to Fly.io, bypassing Vercel's
// 4.5 MB body limit.
//
// body: { title, artist?, prim_lang?, tags? }
// returns: { song_id, upload_url, api_key }
//   upload_url = PIPELINE_URL/pipeline/upload/{song_id}
//   api_key    = PIPELINE_SECRET (safe to expose here — private app)

import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/vocal-hero/supabaseClient';

const PIPELINE_URL    = process.env.PIPELINE_URL    ?? 'http://localhost:8000';
const PIPELINE_SECRET = process.env.PIPELINE_SECRET ?? 'dev-secret';

export async function POST(req: NextRequest) {
  try {
    const { title, artist = '', prim_lang = 'en', tags = '' } = await req.json();
    if (!title?.trim()) return NextResponse.json({ error: 'title is required' }, { status: 400 });

    const sb = getServiceClient();
    const { data: song, error } = await sb
      .from('vh_songs')
      .insert({
        title: title.trim(),
        artist,
        prim_lang,
        trans_lang: 'none',
        tags,
        status: 'processing',
        pipeline_log: 'upload: waiting for file',
      })
      .select()
      .single();

    if (error || !song) {
      return NextResponse.json({ error: error?.message ?? 'DB insert failed' }, { status: 500 });
    }

    return NextResponse.json({
      song_id:    song.id,
      upload_url: `${PIPELINE_URL}/pipeline/upload/${song.id}`,
      api_key:    PIPELINE_SECRET,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
