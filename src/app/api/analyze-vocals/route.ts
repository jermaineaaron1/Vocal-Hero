// POST /api/analyze-vocals
// Proxies to Python pipeline for vocal note detection.
// Returns immediately with 202; caller should poll /api/songs?id=... for notes.

import { NextRequest, NextResponse } from 'next/server';

const PIPELINE_URL    = process.env.PIPELINE_URL    ?? 'http://localhost:8000';
const PIPELINE_SECRET = process.env.PIPELINE_SECRET ?? 'dev-secret';

export async function POST(req: NextRequest) {
  try {
    const { song_id, yt_url, duration } = await req.json();
    if (!song_id || !yt_url) {
      return NextResponse.json({ error: 'song_id and yt_url are required' }, { status: 400 });
    }

    const res = await fetch(`${PIPELINE_URL}/pipeline/vocals/${song_id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PIPELINE_SECRET,
      },
      body: JSON.stringify({ yt_url, duration }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `Pipeline error: ${text}` }, { status: res.status });
    }

    return NextResponse.json(await res.json(), { status: 202 });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
