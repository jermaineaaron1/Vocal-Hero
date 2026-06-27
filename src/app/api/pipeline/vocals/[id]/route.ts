// POST /api/pipeline/vocals/[id]
// Triggers Basic Pitch audio-to-MIDI detection for an existing song.
// body: { yt_url: string }
// Returns: { status: 'queued', song_id }

import { NextRequest, NextResponse } from 'next/server';

const PIPELINE_URL    = process.env.PIPELINE_URL    ?? 'http://localhost:8000';
const PIPELINE_SECRET = process.env.PIPELINE_SECRET ?? 'dev-secret';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: songId } = await params;
  if (!songId) return NextResponse.json({ error: 'song id missing' }, { status: 400 });

  try {
    const body = await req.json().catch(() => ({}));
    const { yt_url } = body as { yt_url?: string };
    if (!yt_url?.trim()) return NextResponse.json({ error: 'yt_url is required' }, { status: 400 });

    const res = await fetch(`${PIPELINE_URL}/pipeline/vocals/${songId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PIPELINE_SECRET,
      },
      body: JSON.stringify({ yt_url: yt_url.trim() }),
    });

    if (!res.ok) {
      const txt = await res.text();
      return NextResponse.json({ error: `Pipeline error: ${txt}` }, { status: 502 });
    }

    return NextResponse.json({ status: 'queued', song_id: songId }, { status: 202 });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
