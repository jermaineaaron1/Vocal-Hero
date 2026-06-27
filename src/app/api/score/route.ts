// POST /api/score
// body: { playerId, sessionId, delta }
// Calls vh_increment_player_score RPC — keeps service key server-side.

import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/vocal-hero/supabaseClient';

export async function POST(req: NextRequest) {
  try {
    const { playerId, sessionId, delta } = await req.json();

    if (!playerId || !sessionId || typeof delta !== 'number') {
      return NextResponse.json({ error: 'playerId, sessionId, delta required' }, { status: 400 });
    }
    if (delta <= 0) return NextResponse.json({ ok: true }); // nothing to do

    const sb = getServiceClient();

    // Increment score
    const { error: rpcErr } = await sb.rpc('vh_increment_player_score', {
      p_id: playerId,
      delta,
    });
    if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 });

    // Append score event for real-time leaderboard
    const { error: evtErr } = await sb.from('vh_score_events').insert({
      session_id: sessionId,
      player_id:  playerId,
      delta,
    });
    if (evtErr) console.error('score_event insert:', evtErr.message);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
