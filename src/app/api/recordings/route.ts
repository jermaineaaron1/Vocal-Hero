import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/vocal-hero/supabaseClient';

function sb() {
  return getServiceClient();
}

// GET /api/recordings?songId=<uuid> — list recordings for a song, newest first
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const songId = searchParams.get('songId');
  if (!songId) return NextResponse.json({ error: 'songId is required' }, { status: 400 });

  try {
    const { data, error } = await sb()
      .from('vh_recordings')
      .select('*')
      .eq('song_id', songId)
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data ?? []);
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST /api/recordings — save a captured take
// body: { songId, partIndex?, source?, notes }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { songId, partIndex = -1, source = 'midi', notes } = body;

    if (!songId) return NextResponse.json({ error: 'songId is required' }, { status: 400 });
    if (!Array.isArray(notes)) return NextResponse.json({ error: 'notes must be an array' }, { status: 400 });

    const { data, error } = await sb()
      .from('vh_recordings')
      .insert({ song_id: songId, part_index: partIndex, source, notes })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
