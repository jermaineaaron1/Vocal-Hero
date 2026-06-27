import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/vocal-hero/supabaseClient';

const BUCKET = 'vh-audio';

/**
 * POST /api/songs/audio
 * body: { song_id: string, filename: string }
 *
 * Returns a Supabase Storage presigned upload URL so the client can PUT the
 * file directly (bypasses the Vercel 4.5 MB body limit).
 * Also returns the future public URL so the caller can save it to the song.
 *
 * Prerequisites: create a public bucket called "vh-audio" in the Supabase
 * Storage dashboard before using this endpoint.
 */
export async function POST(req: NextRequest) {
  try {
    const { song_id, filename } = await req.json();
    if (!song_id || !filename) {
      return NextResponse.json({ error: 'song_id and filename are required' }, { status: 400 });
    }

    // Sanitise filename — keep extension, replace unsafe chars
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${song_id}/${safe}`;

    const sb = getServiceClient();

    // Get presigned upload URL (client will PUT the file here directly)
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) {
      // Helpful message when the bucket doesn't exist yet
      const msg = error.message.includes('not found') || error.message.includes('does not exist')
        ? `Storage bucket "${BUCKET}" not found — create a public bucket called "${BUCKET}" in the Supabase dashboard.`
        : error.message;
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    // Compute the public URL (valid once the file is uploaded)
    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);

    return NextResponse.json({
      upload_url: data.signedUrl,   // client PUT's the file here
      public_url: pub.publicUrl,    // save this as audio_url after upload
      path,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
