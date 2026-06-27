import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/vocal-hero/supabaseClient';
import type { Song } from '@/lib/vocal-hero/types';

function sb() {
  return getServiceClient();
}

// GET /api/songs?status=ready
// GET /api/songs?id=<uuid>
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const status = searchParams.get('status');

  try {
    if (id) {
      const { data, error } = await sb()
        .from('vh_songs')
        .select('*')
        .eq('id', id)
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 404 });
      return NextResponse.json(data);
    }

    let query = sb().from('vh_songs').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data ?? []);
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST /api/songs — create stub, returns { id }
// body: { title, artist?, prim_lang?, trans_lang?, tags? }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { title, artist = '', prim_lang = 'en', trans_lang = 'none', tags = '' } = body;

    if (!title?.trim()) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const { data, error } = await sb()
      .from('vh_songs')
      .insert({ title: title.trim(), artist, prim_lang, trans_lang, tags, status: 'draft' })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/songs?id=<uuid>
// body: partial Song fields
export async function PATCH(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  try {
    const body: Partial<Song> = await req.json();
    // Strip read-only fields
    const { id: _id, created_at: _ca, ...fields } = body as Song;
    void _id; void _ca;

    const { data, error } = await sb()
      .from('vh_songs')
      .update(fields)
      .eq('id', id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// DELETE /api/songs?id=<uuid>
// Cascades: removes related vh_game_sessions rows first to satisfy FK constraint.
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  try {
    const client = sb();

    // Remove game sessions that reference this song (FK constraint)
    const { error: sessErr } = await client
      .from('vh_game_sessions')
      .delete()
      .eq('song_id', id);
    if (sessErr) return NextResponse.json({ error: sessErr.message }, { status: 500 });

    // Now safe to delete the song
    const { error } = await client.from('vh_songs').delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
