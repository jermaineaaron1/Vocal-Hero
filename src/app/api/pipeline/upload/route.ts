// POST /api/pipeline/upload
// Creates a song stub in Supabase, then streams the uploaded audio file to
// the Python pipeline for Basic Pitch vocal detection.
//
// body: multipart/form-data
//   file      File    — MP3/WAV/M4A audio
//   title     string  — song title (required)
//   artist    string  — artist name
//   prim_lang string  — language code (default "en")
//   tags      string  — comma-separated tags
//
// returns: { song_id, status: "queued" }

import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/vocal-hero/supabaseClient';

export const maxDuration = 60; // allow up to 60s for large file uploads

const PIPELINE_URL    = process.env.PIPELINE_URL    ?? 'http://localhost:8000';
const PIPELINE_SECRET = process.env.PIPELINE_SECRET ?? 'dev-secret';

export async function POST(req: NextRequest) {
  try {
    const body = await req.formData();

    const file     = body.get('file') as File | null;
    const title    = (body.get('title')    as string | null)?.trim() ?? '';
    const artist   = (body.get('artist')   as string | null)?.trim() ?? '';
    const primLang = (body.get('prim_lang') as string | null) ?? 'en';
    const tags     = (body.get('tags')     as string | null)?.trim() ?? '';

    if (!file)        return NextResponse.json({ error: 'audio file is required' },  { status: 400 });
    if (!title)       return NextResponse.json({ error: 'title is required' },        { status: 400 });

    // 1. Create song stub in Supabase
    const sb = getServiceClient();
    const { data: song, error: insertErr } = await sb
      .from('vh_songs')
      .insert({
        title,
        artist,
        prim_lang: primLang,
        trans_lang: 'none',
        tags,
        status: 'processing',
        pipeline_log: 'upload: queued',
      })
      .select()
      .single();

    if (insertErr || !song) {
      return NextResponse.json({ error: insertErr?.message ?? 'DB insert failed' }, { status: 500 });
    }

    // 2. Forward file to Python pipeline as multipart
    const pipelineForm = new FormData();
    pipelineForm.append('file', file, file.name);
    pipelineForm.append('prim_lang', primLang);

    const pipelineRes = await fetch(`${PIPELINE_URL}/pipeline/upload/${song.id}`, {
      method: 'POST',
      headers: { 'x-api-key': PIPELINE_SECRET },
      body: pipelineForm,
    });

    if (!pipelineRes.ok) {
      const txt = await pipelineRes.text();
      await sb.from('vh_songs').update({ status: 'error', pipeline_log: txt }).eq('id', song.id);
      return NextResponse.json({ error: `Pipeline error: ${txt}` }, { status: 502 });
    }

    return NextResponse.json({ song_id: song.id, status: 'queued' }, { status: 202 });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
