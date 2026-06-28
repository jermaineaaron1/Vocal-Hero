'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import type { Song, SongNote, SatbPart, TimedLyricSection } from '@/lib/vocal-hero/types';
import { harmonizeSatb, notesToCurve } from '@/lib/vocal-hero/harmonize';
import ArrangementView from './ArrangementView';

// ── Constants ──────────────────────────────────────────────────────────────────
const KEY_W   = 100;  // piano strip width  (CSS px)
const NOTE_H  = 20;   // px per semitone row
const RULER_H = 28;   // time ruler height
const MIDI_LO = 36;   // C2
const MIDI_HI = 84;   // C6
const EDGE    = 10;   // resize-grip zone (px)
const DEF_LEN = 0.5;  // default note length on single click (s)
const MIN_LEN = 0.05; // minimum note length (s)
const KEY_BLK = Math.round(KEY_W * 0.62); // black-key width

// ── Lookups ────────────────────────────────────────────────────────────────────
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const BLACK      = new Set([1,3,6,8,10]);
const PARTS      = ['Soprano','Alto','Tenor','Bass'];
const PCOL       = ['#f472b6','#fb923c','#60a5fa','#34d399'];
const UNGREY     = '#6b7280';
const PART_HZ    = [{min:260,max:1050},{min:175,max:700},{min:130,max:525},{min:80,max:330}];

function midiName(m: number) { return NOTE_NAMES[m%12] + (Math.floor(m/12)-1); }
function isBlack(m: number)  { return BLACK.has(m%12); }
function hzToMidi(f: number) { return Math.round(69 + 12*Math.log2(f/440)); }
function uid()                { return Math.random().toString(36).slice(2,10); }
function fmtTime(s: number)  { return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`; }
function ytVid(url: string)  { return url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1]??null; }
function snapTo(t: number, g: number) { return g>0 ? Math.round(t/g)*g : t; }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// ── Musical snap resolution ────────────────────────────────────────────────────
type SnapMode = 'off'|'32'|'16'|'8'|'4'|'4d'|'8d'|'2'|'1';
function snapModeSecs(mode: SnapMode|string, bpm: number): number {
  const b = 60 / bpm;               // seconds per quarter-note beat
  switch (mode) {
    case 'off': return 0;
    case '32':  return b * 0.125;   // 32nd note
    case '16':  return b * 0.25;    // 16th note
    case '8':   return b * 0.5;     // 8th note
    case '4':   return b;           // quarter note
    case '4d':  return b * 1.5;     // dotted quarter
    case '8d':  return b * 0.75;    // dotted 8th
    case '2':   return b * 2;       // half note
    case '1':   return b * 4;       // whole note
    default:    return b;
  }
}

// ── Canvas helpers (no ctx.roundRect — not available in all browsers) ─────────
function fillRRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.lineTo(x+w-r, y); ctx.arcTo(x+w,y, x+w,y+r, r);
  ctx.lineTo(x+w, y+h-r); ctx.arcTo(x+w,y+h, x+w-r,y+h, r);
  ctx.lineTo(x+r, y+h); ctx.arcTo(x,y+h, x,y+h-r, r);
  ctx.lineTo(x, y+r); ctx.arcTo(x,y, x+r,y, r);
  ctx.closePath();
  ctx.fill();
}
function strokeRRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.lineTo(x+w-r, y); ctx.arcTo(x+w,y, x+w,y+r, r);
  ctx.lineTo(x+w, y+h-r); ctx.arcTo(x+w,y+h, x+w-r,y+h, r);
  ctx.lineTo(x+r, y+h); ctx.arcTo(x,y+h, x,y+h-r, r);
  ctx.lineTo(x, y+r); ctx.arcTo(x,y, x+r,y, r);
  ctx.closePath();
  ctx.stroke();
}

// ── Coord transforms ───────────────────────────────────────────────────────────
function noteY(midi: number, sy: number) { return (MIDI_HI - midi)*NOTE_H - sy + RULER_H; }
function yMidi(y: number, sy: number)    { return Math.round(MIDI_HI - (y - RULER_H + sy)/NOTE_H); }
function noteX(t: number, sx: number, z: number)  { return KEY_W + (t-sx)*z; }
function xTime(x: number, sx: number, z: number)  { return (x-KEY_W)/z + sx; }

// ── YouTube IFrame API ─────────────────────────────────────────────────────────
declare global {
  interface Window {
    YT: { Player: new (el: HTMLElement|string, o: object)=>YTP; PlayerState: Record<string,number> };
    onYouTubeIframeAPIReady?: ()=>void;
  }
}
interface YTP { getCurrentTime():number; getDuration():number; seekTo(s:number,b:boolean):void; playVideo():void; pauseVideo():void; destroy():void; }

const _ytQ: (()=>void)[] = [];
function loadYT(cb: ()=>void) {
  if (typeof window==='undefined') return;
  if (window.YT?.Player) { cb(); return; }
  _ytQ.push(cb);
  if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
    window.onYouTubeIframeAPIReady = ()=>{ _ytQ.forEach(f=>f()); _ytQ.length=0; };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }
}

// ── Client-side MIDI parser ────────────────────────────────────────────────────
function parseMidiBytes(data: Uint8Array): SongNote[] {
  let pos = 0;
  const u16 = () => { const v=(data[pos]<<8)|data[pos+1]; pos+=2; return v; };
  const u32 = () => { const v=(data[pos]<<24)|(data[pos+1]<<16)|(data[pos+2]<<8)|data[pos+3]; pos+=4; return v; };
  const vl  = () => { let v=0; for(;;){ const b=data[pos++]; v=(v<<7)|(b&0x7F); if(!(b&0x80))break; } return v; };

  if (String.fromCharCode(data[0],data[1],data[2],data[3]) !== 'MThd')
    throw new Error('Not a MIDI file');
  pos=4; u32(); u16(); // chunk-size, format
  const nTracks=u16(), ppqn=u16();

  const evts: {midi:number; s:number; e:number}[] = [];

  for (let t=0; t<nTracks; t++) {
    if (pos+8>data.length) break;
    if (String.fromCharCode(data[pos],data[pos+1],data[pos+2],data[pos+3])!=='MTrk'){ pos+=8; continue; }
    pos+=4;
    const end=pos+u32(); let tick=0, rs=0;
    const active: Record<number,number> = {};
    while (pos<end) {
      tick+=vl();
      let st=data[pos]; if(st<0x80){st=rs;}else{pos++;if(st>=0x80&&st<0xF0)rs=st;}
      const cmd=st&0xF0;
      if (cmd===0x90){ const n=data[pos++],v=data[pos++]; if(v>0){active[n]=tick;}else if(active[n]!=null){evts.push({midi:n,s:active[n],e:tick});delete active[n];} }
      else if(cmd===0x80){ const n=data[pos++];pos++; if(active[n]!=null){evts.push({midi:n,s:active[n],e:tick});delete active[n];} }
      else if(cmd===0xC0||cmd===0xD0){pos++;}
      else if(st===0xFF){pos++;pos+=vl();}
      else if((st&0xF0)===0xF0){pos+=vl();}
      else{pos+=2;}
    }
    // flush any stuck notes
    Object.entries(active).forEach(([n,s])=>evts.push({midi:+n,s,e:tick}));
    pos=end;
  }

  const secPerTick = 0.5/ppqn; // 120 BPM default (0.5 s/beat)
  return evts
    .filter(e=>e.midi>=MIDI_LO&&e.midi<=MIDI_HI&&e.e>e.s)
    .sort((a,b)=>a.s-b.s)
    .slice(0,2000)
    .map(e=>({
      id: uid(),
      part: -1,
      midi: e.midi,
      start: Math.round(e.s*secPerTick*1000)/1000,
      end:   Math.round(e.e*secPerTick*1000)/1000,
      lyric: '',
      velocity: 80,
    }));
}

// ── Drag union ─────────────────────────────────────────────────────────────────
type Drag =
  | { k:'cr'; t0:number; midi:number; createdId:string|null }
  | { k:'mv'; id:string; ox:number; oy:number; os:number; oe:number; om:number }
  | { k:'rl'; id:string; ox:number; os:number; oe:number }
  | { k:'rr'; id:string; ox:number; os:number; oe:number }
  | { k:'ph' }
  | { k:'sel'; x0:number; y0:number; x1:number; y1:number };

// ──────────────────────────────────────────────────────────────────────────────
export default function SongEditorPage() {
  const router  = useRouter();
  const params  = useParams();
  const songId  = params.id as string;

  // UI state
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [toast,     setToast]     = useState('');

  // Song meta
  const [song,     setSong]    = useState<Song|null>(null);
  const [title,    setTitle]   = useState('');
  const [artist,   setArtist]  = useState('');
  const [ytUrl,    setYtUrl]   = useState('');
  const [duration, setDur]     = useState(180);

  // View: Piano Roll (note editing) vs Arrangement (chord-chart reading aid)
  const [view, setView] = useState<'pianoroll'|'arrangement'>('pianoroll');

  // Piano roll
  const [notes,    setNotes]   = useState<SongNote[]>([]);
  const [scrollX,  setScrX]    = useState(0);
  const [scrollY,  setScrY]    = useState((MIDI_HI-62)*NOTE_H);
  const [zoom,     setZoom]    = useState(120);
  const [snap,     setSnap]    = useState(0.5);   // derived from bpm+snapMode
  const [bpm,      setBpm]     = useState(120);
  const [timeSig,  setTimeSig] = useState(4);
  const [snapMode, setSnapMode]= useState<SnapMode>('4');
  const [selId,    setSelId]   = useState<string|null>(null);
  const [actPart,  setActPart] = useState(0);
  const [vis,      setVis]     = useState([true,true,true,true]);
  const [cursor,   setCursor]  = useState('crosshair');

  // YouTube
  const [ytTime,    setYtTime]    = useState(0);
  const [ytPlaying, setYtPlaying] = useState(false);
  const [ytDur,     setYtDur]     = useState(0);
  const [ytHide,    setYtHide]    = useState(false);

  // Context menu
  const [ctx2, setCtx2] = useState<{x:number;y:number;id:string}|null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [selIds, setSelIds] = useState<Set<string>>(new Set());

  // Tool mode: draw, select, erase
  const [drawMode, setDrawMode] = useState<'draw'|'select'|'erase'>('draw');
  const drawModeR = useRef<'draw'|'select'|'erase'>('draw');

  // Web Audio
  const audioCtxRef    = useRef<AudioContext|null>(null);
  const previewStopRef = useRef<(()=>void)|null>(null);

  // Multi-select
  const selIdsR      = useRef<Set<string>>(new Set());
  const rubberBandR  = useRef<{x0:number;y0:number;x1:number;y1:number}|null>(null);

  // Refs for stale-closure-free canvas handlers
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const wrapRef     = useRef<HTMLDivElement>(null);
  const ytDivRef    = useRef<HTMLDivElement>(null);
  const playerRef   = useRef<YTP|null>(null);
  const syncRef     = useRef<ReturnType<typeof setInterval>|null>(null);
  const dprRef      = useRef(1);
  const cssWRef     = useRef(0);
  const cssHRef     = useRef(0);

  // Live refs (updated in useEffect to avoid stale closures)
  const notesR    = useRef<SongNote[]>([]);
  const scrXR     = useRef(0);
  const scrYR     = useRef((MIDI_HI-62)*NOTE_H);
  const zoomR     = useRef(120);
  const snapR     = useRef(0.5);
  const bpmR      = useRef(120);
  const timeSigR  = useRef(4);
  const snapModeR = useRef<SnapMode>('4');
  const durR      = useRef(180);
  const actPartR  = useRef(0);
  const selIdR    = useRef<string|null>(null);
  const visR      = useRef([true,true,true,true]);
  const ytTimeR   = useRef(0);
  const ytUrlR    = useRef('');
  const dragR     = useRef<Drag|null>(null);

  // Undo stack
  const undoR = useRef<SongNote[][]>([]);
  const pushUndo = useCallback((snap_: SongNote[]) => {
    undoR.current = [...undoR.current.slice(-40), snap_];
  }, []);

  // MIDI file import ref
  const midiInputRef = useRef<HTMLInputElement|null>(null);

  // MP3 background track
  const mp3Ref = useRef<HTMLAudioElement|null>(null);

  // Persist auto-generated harmony immediately so it's already in the DB —
  // not just local editor state — for the practice game to read.
  async function autoSaveHarmony(harmonizedNotes: SongNote[]) {
    const parts: SatbPart[] = [0,1,2,3].map(pi => ({
      name: PARTS[pi] as SatbPart['name'],
      rangeMin: PART_HZ[pi].min,
      rangeMax: PART_HZ[pi].max,
      curve: notesToCurve(harmonizedNotes, pi, durR.current, MIDI_LO, MIDI_HI),
      aiGen: true,
      edits: 0,
    }));
    try {
      const res = await fetch(`/api/songs?id=${songId}`, {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ notes: harmonizedNotes, parts, status: 'ready' }),
      });
      if (res.ok) {
        setSong(await res.json());
        toast_('✨ Harmony auto-generated — Alto/Tenor/Bass ready to edit');
      }
    } catch { /* non-fatal — harmonized notes are already in local editor state */ }
  }

  // Re-run harmonization from the current melody, replacing only Alto/Tenor/
  // Bass notes (part 1-3) — melody (part 0) and any still-unassigned notes
  // are left untouched. Warns before overwriting hand-edited harmony parts.
  // Does NOT auto-save — the user commits via the existing Save button.
  function handleRegenerateHarmony() {
    const melodyNotes = notes.filter(n=>n.part===0);
    if (!melodyNotes.length) { toast_('No melody (part 0) notes to harmonize from'); return; }
    const handEdited = song?.parts?.slice(1).some(p=>p.aiGen===false);
    if (handEdited && !window.confirm('Alto/Tenor/Bass contain manual edits. Regenerating harmony will overwrite them. Continue?')) {
      return;
    }
    pushUndo(notesR.current);
    const { notes: harmonized } = harmonizeSatb(melodyNotes);
    const newHarmony = harmonized.filter(n=>n.part!==0);
    const untouched = notes.filter(n=>n.part!==1 && n.part!==2 && n.part!==3);
    setNotes([...untouched, ...newHarmony]);
    setSelId(null);
    toast_('Harmony regenerated — click Save & Publish to commit');
  }

  function handleMidiImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = parseMidiBytes(new Uint8Array(ev.target!.result as ArrayBuffer));
        if (!parsed.length) { toast_('No notes found in MIDI file'); return; }
        const doImport = () => {
          pushUndo(notesR.current);
          setSelId(null);
          if (parsed.every(n=>n.part===-1)) {
            const { notes: harmonized } = harmonizeSatb(parsed);
            setNotes(harmonized);
            toast_(`✓ Imported ${parsed.length} notes — harmony auto-generated`);
            autoSaveHarmony(harmonized);
          } else {
            setNotes(parsed);
            toast_(`✓ Imported ${parsed.length} notes from MIDI`);
          }
        };
        if (notesR.current.length > 0) {
          if (window.confirm(`Replace the ${notesR.current.length} existing notes with ${parsed.length} notes from this MIDI file?`)) doImport();
        } else {
          doImport();
        }
      } catch(err) { toast_('MIDI parse error: '+String(err)); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = ''; // allow re-selecting same file
  }

  // Sync state → refs
  useEffect(()=>{ notesR.current   = notes;    },[notes]);
  useEffect(()=>{ scrXR.current    = scrollX;  },[scrollX]);
  useEffect(()=>{ scrYR.current    = scrollY;  },[scrollY]);
  useEffect(()=>{ zoomR.current    = zoom;     },[zoom]);
  useEffect(()=>{ durR.current     = duration; },[duration]);
  useEffect(()=>{ actPartR.current = actPart;  },[actPart]);
  useEffect(()=>{ selIdR.current   = selId;    },[selId]);
  useEffect(()=>{ visR.current     = vis;      },[vis]);
  useEffect(()=>{ ytUrlR.current   = ytUrl;    },[ytUrl]);
  useEffect(()=>{ selIdsR.current  = selIds;   },[selIds]);
  useEffect(()=>{
    drawModeR.current = drawMode;
    setCursor(drawMode==='select' ? 'default' : drawMode==='erase' ? 'cell' : 'crosshair');
  },[drawMode]);
  // Recompute snap seconds whenever BPM or snap mode changes
  useEffect(()=>{ bpmR.current = bpm; const s=snapModeSecs(snapModeR.current,bpm); snapR.current=s; setSnap(s); },[bpm]);
  useEffect(()=>{ timeSigR.current = timeSig; },[timeSig]);
  useEffect(()=>{ snapModeR.current=snapMode; const s=snapModeSecs(snapMode,bpmR.current); snapR.current=s; setSnap(s); },[snapMode]);

  // ── Load song ────────────────────────────────────────────────────────────────
  useEffect(()=>{
    fetch(`/api/songs?id=${songId}`).then(r=>r.json()).then((s: Song)=>{
      setSong(s);
      setTitle(s.title??'');
      setArtist(s.artist??'');
      const url = s.yt_url??'';
      setYtUrl(url); ytUrlR.current=url;
      const dur = s.duration??180;
      setDur(dur); durR.current=dur;
      const loadedBpm = s.bpm ?? 120;
      setBpm(loadedBpm); bpmR.current = loadedBpm;
      const loadedTimeSig = s.time_sig ?? 4;
      setTimeSig(loadedTimeSig); timeSigR.current = loadedTimeSig;

      if (s.notes && s.notes.length>0) {
        if (s.notes.every(n=>n.part===-1)) {
          // Fresh extraction/import with no harmony yet — auto-generate it.
          const { notes: harmonized } = harmonizeSatb(s.notes);
          setNotes(harmonized);
          autoSaveHarmony(harmonized);
        } else {
          setNotes(s.notes);
        }
      } else if (s.timed_lyrics?.length) {
        const conv: SongNote[] = [];
        s.timed_lyrics.forEach(sec=>{
          PART_HZ.forEach((rng,pi)=>{
            const norm = sec.pitches?.[pi] ?? 0.5;
            const freq = rng.min + norm*(rng.max-rng.min);
            const midi = clamp(hzToMidi(freq), MIDI_LO, MIDI_HI);
            conv.push({id:uid(),part:pi,midi,start:sec.start,end:sec.end,lyric:sec.primary??'',velocity:80});
          });
        });
        setNotes(conv);
      }
      // Load MP3 background track if present
      if (s.audio_url) {
        const el = new Audio(s.audio_url);
        el.preload = 'auto';
        mp3Ref.current = el;
      }

      setLoading(false);
    }).catch(()=>setLoading(false));
  },[songId]);

  // ── YouTube player ───────────────────────────────────────────────────────────
  const initYT = useCallback(()=>{
    const vid = ytVid(ytUrlR.current);
    if (!vid||!ytDivRef.current) return;
    try { playerRef.current?.destroy(); } catch { /**/ }
    playerRef.current = null;
    while (ytDivRef.current.firstChild) ytDivRef.current.removeChild(ytDivRef.current.firstChild);
    const el = document.createElement('div');
    ytDivRef.current.appendChild(el);
    playerRef.current = new window.YT.Player(el, {
      height:'100%', width:'100%', videoId:vid,
      playerVars:{playsinline:1, rel:0, modestbranding:1},
      events:{
        onReady:(e:{target:YTP})=>setYtDur(e.target.getDuration()||durR.current),
        onStateChange:(e:{data:number})=>{
          const playing = e.data===window.YT.PlayerState.PLAYING;
          setYtPlaying(playing);
          if (playing) {
            if (syncRef.current) clearInterval(syncRef.current);
            syncRef.current = setInterval(()=>{
              const t = playerRef.current?.getCurrentTime()??0;
              ytTimeR.current=t; setYtTime(t);
            },100);
          } else {
            if (syncRef.current){ clearInterval(syncRef.current); syncRef.current=null; }
          }
        },
      },
    });
  },[]);

  useEffect(()=>{
    if (!ytUrl) return;
    ytUrlR.current = ytUrl;
    loadYT(initYT);
  },[ytUrl, initYT]);

  useEffect(()=>()=>{
    if (syncRef.current) clearInterval(syncRef.current);
    try { playerRef.current?.destroy(); } catch { /**/ }
    previewStopRef.current?.();
    try { audioCtxRef.current?.close(); } catch { /**/ }
    try { mp3Ref.current?.pause(); mp3Ref.current = null; } catch { /**/ }
  },[]);

  function seekTo(t: number) {
    ytTimeR.current=t; setYtTime(t);
    playerRef.current?.seekTo(t,true);
  }

  // ── Web Audio helpers ─────────────────────────────────────────────────────────
  function getAudioCtx() {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    if (audioCtxRef.current.state==='suspended') audioCtxRef.current.resume();
    return audioCtxRef.current;
  }
  function midiToHz(midi: number) { return 440*Math.pow(2,(midi-69)/12); }

  function playMidiNote(midi: number, dur=0.45) {
    const ctx=getAudioCtx(), now=ctx.currentTime;
    const osc=ctx.createOscillator(), gain=ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type='sine'; osc.frequency.value=midiToHz(midi);
    gain.gain.setValueAtTime(0,now);
    gain.gain.linearRampToValueAtTime(0.28, now+0.01);
    gain.gain.setValueAtTime(0.28, now+Math.max(0.01,dur-0.06));
    gain.gain.linearRampToValueAtTime(0, now+dur);
    osc.start(now); osc.stop(now+dur);
  }

  function stopPreview() {
    previewStopRef.current?.();
    previewStopRef.current=null;
    setPreviewing(false);
  }

  function startPreview(fromStart=false) {
    if (previewing) { stopPreview(); return; }
    const ctx=getAudioCtx();
    const origin = fromStart ? 0 : ytTimeR.current;
    const wallNow=ctx.currentTime;
    const horizon=origin+120; // preview up to 2 min ahead

    const relevant=notesR.current.filter(n=>n.end>origin&&n.start<horizon);
    if (!relevant.length) { toast_('No notes to preview'); return; }

    const oscs: Array<{osc:OscillatorNode;gain:GainNode}>=[];
    relevant.forEach(n=>{
      const t0=wallNow+Math.max(0,n.start-origin);
      const t1=wallNow+Math.max(0.01,n.end-origin);
      const osc=ctx.createOscillator(), gain=ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type='sine'; osc.frequency.value=midiToHz(n.midi);
      gain.gain.setValueAtTime(0,t0);
      gain.gain.linearRampToValueAtTime(0.15,t0+0.01);
      gain.gain.setValueAtTime(0.15,Math.max(t0+0.01,t1-0.04));
      gain.gain.linearRampToValueAtTime(0,t1);
      osc.start(t0); osc.stop(t1);
      oscs.push({osc,gain});
    });

    // Start MP3 background track at the correct offset
    const mp3 = mp3Ref.current;
    if (mp3) {
      mp3.currentTime = origin;
      mp3.play().catch(()=>{/*autoplay blocked — user can still hear oscillators*/});
    }

    setPreviewing(true);
    const maxEnd=Math.max(...relevant.map(n=>n.end-origin));
    const tid=setTimeout(()=>{
      mp3?.pause();
      setPreviewing(false);
      previewStopRef.current=null;
    },(maxEnd+0.3)*1000);

    // Advance playhead during preview
    if (fromStart) { seekTo(0); }
    const phInterval=setInterval(()=>{
      // If MP3 is playing, use its time for accuracy; otherwise use wall clock
      const elapsed = mp3 && !mp3.paused ? mp3.currentTime - origin : ctx.currentTime - wallNow;
      ytTimeR.current=origin+elapsed; setYtTime(origin+elapsed);
    },100);

    previewStopRef.current=()=>{
      clearTimeout(tid); clearInterval(phInterval);
      mp3?.pause();
      const now2=ctx.currentTime;
      oscs.forEach(({osc,gain})=>{ try{ gain.gain.setValueAtTime(gain.gain.value,now2); gain.gain.linearRampToValueAtTime(0,now2+0.04); osc.stop(now2+0.04); }catch{/***/} });
      setPreviewing(false);
    };
  }

  // ── Canvas sizing (useLayoutEffect = runs before paint) ───────────────────────
  const resizeCanvas = useCallback(()=>{
    const canvas = canvasRef.current;
    const wrap   = wrapRef.current;
    if (!canvas||!wrap) return;
    const dpr  = window.devicePixelRatio||1;
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    dprRef.current  = dpr;
    cssWRef.current = cssW;
    cssHRef.current = cssH;
    canvas.width  = Math.round(cssW*dpr);
    canvas.height = Math.round(cssH*dpr);
    canvas.style.width  = cssW+'px';
    canvas.style.height = cssH+'px';
  },[]);

  useLayoutEffect(()=>{
    resizeCanvas();
    draw();
  });

  useEffect(()=>{
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(()=>{ resizeCanvas(); draw(); });
    ro.observe(wrapRef.current);
    return ()=>ro.disconnect();
  },[resizeCanvas]); // eslint-disable-line

  // ── Non-passive wheel handler (React synthetic events can't preventDefault wheel) ──
  useEffect(()=>{
    const canvas = canvasRef.current; if (!canvas) return;
    function onWheelNative(e: WheelEvent) {
      e.preventDefault();
      if (e.ctrlKey||e.metaKey) {
        setZoom(z=>clamp(z*(e.deltaY>0?0.85:1.18),20,800));
      } else if (e.shiftKey || Math.abs(e.deltaX)>Math.abs(e.deltaY)) {
        // Shift+scroll OR trackpad horizontal → scroll timeline
        const delta = Math.abs(e.deltaX)>Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setScrX(x=>{ const v=Math.max(0, x+delta/zoomR.current*2); scrXR.current=v; return v; });
      } else {
        const maxY=(MIDI_HI-MIDI_LO+3)*NOTE_H;
        setScrY(y=>{ const v=clamp(y+e.deltaY*0.6,0,maxY); scrYR.current=v; return v; });
      }
    }
    canvas.addEventListener('wheel', onWheelNative, {passive:false});
    return ()=>canvas.removeEventListener('wheel', onWheelNative);
  },[]); // eslint-disable-line

  // ── Draw ─────────────────────────────────────────────────────────────────────
  const draw = useCallback(()=>{
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx    = canvas.getContext('2d'); if (!ctx) return;
    const dpr    = dprRef.current;
    const W      = cssWRef.current || canvas.width/dpr;
    const H      = cssHRef.current || canvas.height/dpr;
    if (W<=0||H<=0) return;

    ctx.save();
    ctx.scale(dpr, dpr);   // all drawing in CSS pixels

    const sx   = scrXR.current;
    const sy   = scrYR.current;
    const z    = zoomR.current;
    const sid  = selIdR.current;
    const sids = selIdsR.current;
    const pv   = visR.current;
    const yt   = ytTimeR.current;

    // ── Background ──────────────────────────────────────────────────────────
    ctx.fillStyle='#0a0a12'; ctx.fillRect(0,0,W,H);

    // ── Pitch rows ───────────────────────────────────────────────────────────
    for (let m=MIDI_LO; m<=MIDI_HI; m++) {
      const y = noteY(m,sy);
      if (y+NOTE_H<RULER_H||y>H) continue;
      ctx.fillStyle = isBlack(m) ? '#0d0d1c' : '#111124';
      ctx.fillRect(KEY_W, y, W-KEY_W, NOTE_H);
      // octave line
      if (m%12===0) {
        ctx.strokeStyle='rgba(124,58,237,0.25)'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(KEY_W,y); ctx.lineTo(W,y); ctx.stroke();
      }
    }

    // ── Beat-based time grid ─────────────────────────────────────────────────
    const beatLen = 60 / bpmR.current;          // seconds per beat
    const barLen  = timeSigR.current * beatLen;  // seconds per bar
    const snapS   = snapR.current;               // seconds per subdivision
    const gStart  = Math.floor((sx - barLen) / barLen) * barLen;
    const gEnd    = sx + (W - KEY_W) / z + barLen * 2;

    // Subdivision lines (finest, only when they're >= 3px apart)
    if (snapS > 0 && snapS * z >= 3) {
      ctx.strokeStyle = 'rgba(124,58,237,0.07)'; ctx.lineWidth = 0.5;
      for (let t = gStart; t <= gEnd; t += snapS) {
        const rem = Math.abs(t % beatLen);
        if (rem < snapS * 0.01 || rem > beatLen - snapS * 0.01) continue; // skip beats
        const x = noteX(t, sx, z);
        if (x < KEY_W || x > W) continue;
        ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, H); ctx.stroke();
      }
    }
    // Beat lines
    ctx.strokeStyle = 'rgba(124,58,237,0.15)'; ctx.lineWidth = 0.5;
    for (let t = gStart; t <= gEnd; t += beatLen) {
      const rem = Math.abs(t % barLen);
      if (rem < beatLen * 0.01 || rem > barLen - beatLen * 0.01) continue; // skip bars
      const x = noteX(t, sx, z);
      if (x < KEY_W || x > W) continue;
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, H); ctx.stroke();
    }
    // Bar lines
    ctx.strokeStyle = 'rgba(124,58,237,0.40)'; ctx.lineWidth = 1;
    for (let t = gStart; t <= gEnd; t += barLen) {
      if (t < 0) continue;
      const x = noteX(t, sx, z);
      if (x < KEY_W || x > W) continue;
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, H); ctx.stroke();
    }

    // ── Notes ────────────────────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath(); ctx.rect(KEY_W,RULER_H,W-KEY_W,H-RULER_H); ctx.clip();

    notesR.current.forEach(n=>{
      if (n.part>=0&&!pv[n.part]) return;
      const nx = noteX(n.start,sx,z);
      const nw = Math.max(4, (n.end-n.start)*z);
      const ny = noteY(n.midi,sy);
      if (nx+nw<KEY_W||nx>W||ny+NOTE_H<RULER_H||ny>H) return;

      const col     = n.part>=0 ? PCOL[n.part] : UNGREY;
      const isSel   = n.id===sid || sids.has(n.id);
      const isPlay  = yt>=n.start&&yt<n.end;

      // Fill
      ctx.fillStyle = isSel ? col : isPlay ? col+'cc' : col+'60';
      fillRRect(ctx, nx+1,ny+1,nw-2,NOTE_H-2,3);

      // Highlight stripe at top
      ctx.fillStyle = isSel ? '#ffffff44' : isPlay ? '#ffffff22' : '#ffffff10';
      ctx.fillRect(nx+2,ny+1,nw-4,3);

      // Border
      ctx.strokeStyle = isSel ? '#ffffff' : isPlay ? col : col+'aa';
      ctx.lineWidth   = isSel ? 1.5 : 1;
      strokeRRect(ctx, nx+1,ny+1,nw-2,NOTE_H-2,3);

      // Resize grips (selected note only)
      if (isSel && nw>18) {
        ctx.fillStyle='#ffffff66';
        ctx.fillRect(nx+2,ny+3,3,NOTE_H-6);
        ctx.fillRect(nx+nw-5,ny+3,3,NOTE_H-6);
      }

      // Lyric text
      if (n.lyric && nw>16) {
        ctx.font      = `bold ${NOTE_H<=14?9:10}px system-ui,sans-serif`;
        ctx.fillStyle = isSel ? '#fff' : '#ffffffaa';
        ctx.fillText(n.lyric, nx+6, ny+NOTE_H-3, nw-10);
      }
    });

    ctx.restore();

    // ── Rubber-band selection rect ───────────────────────────────────────────
    const rb = rubberBandR.current;
    if (rb) {
      const rx=Math.min(rb.x0,rb.x1), ry=Math.min(rb.y0,rb.y1);
      const rw=Math.abs(rb.x1-rb.x0), rh=Math.abs(rb.y1-rb.y0);
      ctx.strokeStyle='#22d3ee'; ctx.lineWidth=1.5;
      ctx.setLineDash([4,3]);
      ctx.strokeRect(rx,ry,rw,rh);
      ctx.fillStyle='rgba(34,211,238,0.08)';
      ctx.fillRect(rx,ry,rw,rh);
      ctx.setLineDash([]);
    }

    // ── Piano keyboard ───────────────────────────────────────────────────────
    // Compute which MIDI pitches are currently active (for key glow)
    const playingNotes = notesR.current.filter(n => yt >= n.start && yt < n.end);
    const glowByMidi = new Map<number, string>();
    playingNotes.forEach(n => {
      const col = n.part >= 0 ? PCOL[n.part] : '#22d3ee';
      if (!glowByMidi.has(n.midi)) glowByMidi.set(n.midi, col);
    });

    for (let m=MIDI_LO; m<=MIDI_HI; m++) {
      const y  = noteY(m,sy);
      if (y+NOTE_H<RULER_H||y>H) continue;
      const blk = isBlack(m);
      const glowCol = glowByMidi.get(m);

      if (glowCol) {
        // ── GLOWING KEY ──────────────────────────────────────────────────────
        ctx.shadowColor = glowCol; ctx.shadowBlur = 14;
        ctx.fillStyle   = glowCol + 'dd';
        ctx.fillRect(1, y + 0.5, KEY_W - 2, NOTE_H - 1);
        ctx.shadowBlur = 0;
        // inner rim
        ctx.strokeStyle = glowCol; ctx.lineWidth = 1.5;
        ctx.strokeRect(1.5, y + 1, KEY_W - 4, NOTE_H - 2);
      } else {
        // ── NORMAL KEY ───────────────────────────────────────────────────────
        ctx.fillStyle = blk ? '#2a2a2a' : '#f0ece8';
        ctx.fillRect(1, y + 0.5, blk ? KEY_BLK : KEY_W - 2, NOTE_H - 1);

        if (!blk) {
          ctx.fillStyle = '#c8c0b8';
          ctx.fillRect(KEY_W - 3, y + 1, 2, NOTE_H - 2);
          ctx.fillStyle = '#aaa8a4';
          ctx.fillRect(1, y + NOTE_H - 1, KEY_W - 3, 1);
        } else {
          ctx.fillStyle = '#484848';
          ctx.fillRect(1, y + 1, KEY_BLK - 2, 3);
        }
      }

      // Note name (white keys only) — always visible
      if (!blk) {
        const isOct = m % 12 === 0;
        ctx.fillStyle = glowCol ? '#fff' : (isOct ? '#7c6aaa' : '#888');
        ctx.font = `${isOct ? 'bold ' : ''}${NOTE_H <= 16 ? 8 : 9}px monospace`;
        ctx.textAlign = 'right';
        ctx.fillText(midiName(m), KEY_W - 5, y + NOTE_H - 3);
        ctx.textAlign = 'left';
      }
    }
    ctx.strokeStyle = 'rgba(124,58,237,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(KEY_W - 1, RULER_H); ctx.lineTo(KEY_W - 1, H); ctx.stroke();

    // ── Time ruler (bar:beat) ────────────────────────────────────────────────
    ctx.fillStyle='#14142a'; ctx.fillRect(0,0,W,RULER_H);
    ctx.strokeStyle='rgba(124,58,237,0.3)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,RULER_H); ctx.lineTo(W,RULER_H); ctx.stroke();
    ctx.fillStyle='rgba(124,58,237,0.6)'; ctx.font='bold 9px monospace';
    let lastLblX = KEY_W - 60;
    for (let t = gStart; t <= gEnd; t += beatLen) {
      const x = noteX(t, sx, z);
      if (x < KEY_W || x > W) continue;
      if (x - lastLblX < 38) continue;
      const bar     = Math.floor(t / barLen + 0.001) + 1;
      const beatIdx = Math.round((t % barLen) / beatLen) + 1;
      const lbl     = beatIdx === 1 ? `${bar}` : `${bar}.${beatIdx}`;
      const isBar   = beatIdx === 1;
      ctx.strokeStyle = isBar ? 'rgba(124,58,237,0.4)' : 'rgba(124,58,237,0.2)';
      ctx.lineWidth   = isBar ? 1 : 0.5;
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 6); ctx.lineTo(x, RULER_H - 1); ctx.stroke();
      ctx.fillStyle = isBar ? 'rgba(180,160,255,0.85)' : 'rgba(124,58,237,0.45)';
      ctx.fillText(lbl, x + 2, RULER_H - 6);
      lastLblX = x;
    }
    ctx.fillStyle='#14142a'; ctx.fillRect(0,0,KEY_W-1,RULER_H);

    // ── Playhead ─────────────────────────────────────────────────────────────
    const phx = noteX(yt,sx,z);
    if (phx>=KEY_W&&phx<=W) {
      ctx.strokeStyle='#facc15'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(phx,RULER_H); ctx.lineTo(phx,H); ctx.stroke();
      ctx.fillStyle='#facc15';
      ctx.beginPath(); ctx.moveTo(phx-5,1); ctx.lineTo(phx+5,1); ctx.lineTo(phx,RULER_H); ctx.fill();
    }

    ctx.restore();  // undo dpr scale
  },[]);

  // Redraw on state changes
  useEffect(()=>{ draw(); },[draw, notes, scrollX, scrollY, zoom, selId, ytTime, duration, vis, snap, bpm, timeSig, snapMode]);

  // ── Hit-test ─────────────────────────────────────────────────────────────────
  function hitNote(cx: number, cy: number): {note:SongNote; zone:'left'|'right'|'body'}|null {
    const sx=scrXR.current, sy=scrYR.current, z=zoomR.current, pv=visR.current;
    for (let i=notesR.current.length-1; i>=0; i--) {
      const n=notesR.current[i];
      if (n.part>=0&&!pv[n.part]) continue;
      const nx=noteX(n.start,sx,z), nw=Math.max(4,(n.end-n.start)*z);
      const ny=noteY(n.midi,sy);
      if (cx>=nx&&cx<=nx+nw&&cy>=ny&&cy<=ny+NOTE_H) {
        const zone = cx-nx<EDGE?'left':nx+nw-cx<EDGE?'right':'body';
        return {note:n, zone};
      }
    }
    return null;
  }

  function cursorFor(hit:{zone:string}|null): string {
    const dm = drawModeR.current;
    if (dm === 'erase') return hit ? 'cell' : 'cell';
    if (!hit) return dm === 'select' ? 'default' : 'crosshair';
    if (hit.zone==='left'||hit.zone==='right') return 'ew-resize';
    return 'grab';
  }

  // ── Mouse events ─────────────────────────────────────────────────────────────
  function getXY(e: React.MouseEvent<HTMLCanvasElement>): [number,number] {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX-r.left, e.clientY-r.top];
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (e.button===2) return;
    setCtx2(null);
    const [cx,cy] = getXY(e);
    const sx=scrXR.current, sy=scrYR.current, z=zoomR.current;

    if (cy<RULER_H&&cx>KEY_W) {
      seekTo(Math.max(0,xTime(cx,sx,z)));
      dragR.current={k:'ph'};
      return;
    }
    if (cx<KEY_W) return;

    const hit = hitNote(cx,cy);

    // ── Erase mode: single-click deletes ────────────────────────────────────
    if (drawModeR.current === 'erase') {
      if (hit) {
        pushUndo(notesR.current);
        setNotes(prev => prev.filter(n => n.id !== hit.note.id));
        setSelId(null);
      }
      e.preventDefault(); return;
    }

    if (!hit) {
      if (drawModeR.current==='select' || e.ctrlKey||e.metaKey) {
        // Select mode OR Ctrl+drag → rubber-band select
        dragR.current={k:'sel',x0:cx,y0:cy,x1:cx,y1:cy};
        rubberBandR.current={x0:cx,y0:cy,x1:cx,y1:cy};
        setSelIds(new Set()); selIdsR.current=new Set(); setSelId(null);
        setCursor('crosshair');
      } else {
        // Draw mode: clear multi-select, start note creation
        setSelIds(new Set()); selIdsR.current=new Set();
        const t0   = snapTo(Math.max(0,xTime(cx,sx,z)), snapR.current);
        const midi = clamp(yMidi(cy,sy), MIDI_LO, MIDI_HI);
        dragR.current = {k:'cr', t0, midi, createdId:null};
        setSelId(null);
        setCursor('crosshair');
      }
    } else {
      playMidiNote(hit.note.midi, Math.min(hit.note.end-hit.note.start, 0.5));
      if (e.ctrlKey||e.metaKey) {
        // Ctrl+click → toggle in multi-select
        setSelIds(prev=>{
          const s=new Set(prev);
          s.has(hit.note.id)?s.delete(hit.note.id):s.add(hit.note.id);
          selIdsR.current=s;
          return s;
        });
        setSelId(null);
      } else {
        setSelId(hit.note.id);
        setSelIds(new Set()); selIdsR.current=new Set();
        const n=hit.note;
        if (hit.zone==='left')  { dragR.current={k:'rl',id:n.id,ox:cx,os:n.start,oe:n.end}; setCursor('ew-resize'); }
        else if (hit.zone==='right') { dragR.current={k:'rr',id:n.id,ox:cx,os:n.start,oe:n.end}; setCursor('ew-resize'); }
        else { dragR.current={k:'mv',id:n.id,ox:cx,oy:cy,os:n.start,oe:n.end,om:n.midi}; setCursor('grabbing'); }
      }
    }
    e.preventDefault();
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const [cx,cy] = getXY(e);
    const drag=dragR.current;
    const z=zoomR.current, sx=scrXR.current, sy=scrYR.current;

    if (!drag) {
      if (cx>KEY_W&&cy>RULER_H) setCursor(cursorFor(hitNote(cx,cy)));
      return;
    }
    e.preventDefault();

    if (drag.k==='ph') {
      if (cx>KEY_W) seekTo(Math.max(0,xTime(cx,sx,z)));
      return;
    }

    if (drag.k==='sel') {
      const rb={x0:drag.x0,y0:drag.y0,x1:cx,y1:cy};
      rubberBandR.current=rb;
      dragR.current={...drag,x1:cx,y1:cy};
      draw(); // live update rubber band
      return;
    }

    if (drag.k==='cr') {
      const t = snapTo(Math.max(0,xTime(cx,sx,z)), snapR.current);
      const t0=Math.min(drag.t0,t), t1=Math.max(drag.t0+MIN_LEN,t);
      const newNote: SongNote = {
        id: drag.createdId ?? uid(),
        part: actPartR.current,
        midi: drag.midi,
        start: t0, end: t1,
        lyric: '', velocity: 80,
      };
      if (!drag.createdId) {
        dragR.current = {...drag, createdId: newNote.id};
        setNotes(prev=>{ pushUndo(prev); return [...prev, newNote]; });
        setSelId(newNote.id);
      } else {
        setNotes(prev=>prev.map(n=>n.id===drag.createdId?newNote:n));
      }
      return;
    }

    const dxSec = (cx-drag.ox)/z;
    if (drag.k==='rl') {
      const ns = snapTo(clamp(drag.os+dxSec, 0, drag.oe-MIN_LEN), snapR.current);
      setNotes(prev=>prev.map(n=>n.id===drag.id?{...n,start:ns}:n));
    } else if (drag.k==='rr') {
      const ne = snapTo(Math.max(drag.os+MIN_LEN, drag.oe+dxSec), snapR.current);
      setNotes(prev=>prev.map(n=>n.id===drag.id?{...n,end:ne}:n));
    } else if (drag.k==='mv') {
      const ns = snapTo(Math.max(0,drag.os+dxSec), snapR.current);
      const ne = ns + (drag.oe-drag.os);
      const dm = yMidi(cy,sy) - yMidi(drag.oy,sy);
      const nm = clamp(drag.om+dm, MIDI_LO, MIDI_HI);
      setNotes(prev=>prev.map(n=>n.id===drag.id?{...n,start:ns,end:ne,midi:nm}:n));
    }
  }

  function endDrag(e: React.MouseEvent<HTMLCanvasElement>) {
    const drag=dragR.current; dragR.current=null;
    if (!drag) return;

    if (drag.k==='ph') return;

    if (drag.k==='sel') {
      rubberBandR.current=null;
      const z=zoomR.current, sx=scrXR.current, sy=scrYR.current;
      const x0=Math.min(drag.x0,drag.x1), x1=Math.max(drag.x0,drag.x1);
      const y0=Math.min(drag.y0,drag.y1), y1=Math.max(drag.y0,drag.y1);
      const selected=new Set<string>();
      notesR.current.forEach(n=>{
        if (n.part>=0&&!visR.current[n.part]) return;
        const nx=noteX(n.start,sx,z), nw=Math.max(4,(n.end-n.start)*z);
        const ny=noteY(n.midi,sy);
        if (nx+nw>=x0&&nx<=x1&&ny+NOTE_H>=y0&&ny<=y1) selected.add(n.id);
      });
      if (selected.size>0) { setSelIds(selected); selIdsR.current=selected; setSelId(null); }
      draw();
      return;
    }

    if (drag.k==='cr' && !drag.createdId && drawModeR.current==='draw') {
      // Pure click (no drag movement) — create a note at default length
      const newNote: SongNote = {
        id:uid(), part:actPartR.current, midi:drag.midi,
        start:drag.t0, end:drag.t0+DEF_LEN, lyric:'', velocity:80,
      };
      setNotes(prev=>{ pushUndo(prev); return [...prev,newNote]; });
      setSelId(newNote.id);
    }

    const [cx,cy] = getXY(e);
    setCursor(cursorFor(hitNote(cx,cy)));
  }

  function onDblClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const [cx,cy]=getXY(e);
    const hit=hitNote(cx,cy);
    if (hit) {
      setSelId(hit.note.id);
      setTimeout(()=>document.getElementById('lyric-input')?.focus(),30);
    }
  }

  function onContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const [cx,cy]=getXY(e);
    const hit=hitNote(cx,cy);
    if (hit) { setSelId(hit.note.id); setCtx2({x:e.clientX,y:e.clientY,id:hit.note.id}); }
    else setCtx2(null);
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  useEffect(()=>{
    function onKey(e: KeyboardEvent) {
      const tgt=e.target as HTMLElement;
      if (tgt.tagName==='INPUT'||tgt.tagName==='TEXTAREA') return;

      if (e.key==='Escape') {
        setSelId(null); setSelIds(new Set()); selIdsR.current=new Set(); e.preventDefault();
      }
      if (e.key==='Delete'||e.key==='Backspace') {
        const id=selIdR.current;
        const ids=selIdsR.current;
        if (ids.size>0) {
          pushUndo(notesR.current);
          setNotes(p=>p.filter(n=>!ids.has(n.id)));
          setSelIds(new Set()); selIdsR.current=new Set();
          e.preventDefault();
        } else if (id) {
          pushUndo(notesR.current);
          setNotes(p=>p.filter(n=>n.id!==id)); setSelId(null); e.preventDefault();
        }
        return;
      }
      if ((e.ctrlKey||e.metaKey)&&e.key==='d') {
        const id=selIdR.current; if (!id) return;
        const src=notesR.current.find(n=>n.id===id); if (!src) return;
        const clone: SongNote={...src,id:uid(),start:src.end,end:src.end+(src.end-src.start)};
        pushUndo(notesR.current);
        setNotes(p=>[...p,clone]); setSelId(clone.id); e.preventDefault();
      }
      if ((e.ctrlKey||e.metaKey)&&e.key==='z') {
        const prev=undoR.current.pop(); if (prev) { setNotes(prev); setSelId(null); } e.preventDefault();
      }
      if (e.key===' ') {
        ytPlaying ? playerRef.current?.pauseVideo() : playerRef.current?.playVideo();
        e.preventDefault();
      }
      if (e.key==='ArrowUp'||e.key==='ArrowDown') {
        const id=selIdR.current;
        const ids=selIdsR.current;
        if (id) {
          // Note selected → transpose semitone
          const d=e.key==='ArrowUp'?1:-1;
          pushUndo(notesR.current);
          setNotes(p=>p.map(n=>n.id===id?{...n,midi:clamp(n.midi+d,MIDI_LO,MIDI_HI)}:n));
        } else if (ids.size>0) {
          const d=e.key==='ArrowUp'?1:-1;
          pushUndo(notesR.current);
          setNotes(p=>p.map(n=>ids.has(n.id)?{...n,midi:clamp(n.midi+d,MIDI_LO,MIDI_HI)}:n));
        } else {
          // Nothing selected → scroll vertically through octaves
          const maxY=(MIDI_HI-MIDI_LO+3)*NOTE_H;
          const d=e.key==='ArrowDown'?NOTE_H*3:-NOTE_H*3;
          setScrY(y=>{ const v=clamp(y+d,0,maxY); scrYR.current=v; return v; });
        }
        e.preventDefault();
      }
      if (e.key==='ArrowLeft'||e.key==='ArrowRight') {
        const id=selIdR.current;
        const ids=selIdsR.current;
        const snap=Math.max(snapR.current,0.0625);
        if (id) {
          // Note selected → move note
          const d=(e.key==='ArrowRight'?1:-1)*snap;
          pushUndo(notesR.current);
          setNotes(p=>p.map(n=>n.id===id?{...n,start:Math.max(0,n.start+d),end:n.end+d}:n));
        } else if (ids.size>0) {
          const d=(e.key==='ArrowRight'?1:-1)*snap;
          pushUndo(notesR.current);
          setNotes(p=>p.map(n=>ids.has(n.id)?{...n,start:Math.max(0,n.start+d),end:n.end+d}:n));
        } else {
          // Nothing selected → scroll horizontally through timeline
          const d=(e.key==='ArrowRight'?5:-5);
          setScrX(x=>{ const v=Math.max(0,x+d); scrXR.current=v; return v; });
        }
        e.preventDefault();
      }
    }
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[ytPlaying,pushUndo]);

  // ── Save ──────────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!song) return; setSaving(true);
    try {
      const sorted=[...notes].sort((a,b)=>a.start-b.start);
      const tl: TimedLyricSection[]=[];
      const by=new Map<string,SongNote[]>();
      sorted.forEach(n=>{ const k=`${n.start.toFixed(2)}|${n.end.toFixed(2)}`; if(!by.has(k))by.set(k,[]); by.get(k)!.push(n); });
      by.forEach((grp,k)=>{
        const [s,e]=k.split('|').map(parseFloat);
        const p:[number,number,number,number]=[0.5,0.5,0.5,0.5];
        grp.forEach(n=>{ if(n.part>=0&&n.part<4)p[n.part]=(n.midi-MIDI_LO)/(MIDI_HI-MIDI_LO); });
        tl.push({start:s,end:e,primary:grp[0]?.lyric??'',translation:'',pitches:p});
      });
      tl.sort((a,b)=>a.start-b.start);

      // A part's aiGen should only flip to false (and its edits count bump)
      // if that part's notes actually changed since load — otherwise an
      // unrelated save (e.g. just fixing the title) would silently stomp
      // "this harmony part is still AI-suggested" on every part, every time.
      const notesChangedForPart = (pi: number) => {
        const prev=(song.notes??[]).filter(n=>n.part===pi).sort((a,b)=>a.start-b.start);
        const curr=sorted.filter(n=>n.part===pi);
        if (prev.length!==curr.length) return true;
        return prev.some((p,i)=>{
          const c=curr[i];
          return p.midi!==c.midi || p.start!==c.start || p.end!==c.end || p.lyric!==c.lyric;
        });
      };

      const parts: SatbPart[]=[0,1,2,3].map(pi=>{
        const curve=notesToCurve(sorted,pi,duration,MIDI_LO,MIDI_HI);
        const prevPart=song.parts?.[pi];
        const changed=notesChangedForPart(pi);
        return {
          name:PARTS[pi] as SatbPart['name'],rangeMin:PART_HZ[pi].min,rangeMax:PART_HZ[pi].max,curve,
          aiGen:changed?false:(prevPart?.aiGen??false),
          edits:changed?(prevPart?.edits??0)+1:(prevPart?.edits??0),
        };
      });

      const res=await fetch(`/api/songs?id=${songId}`,{
        method:'PATCH',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({title,artist,yt_url:ytUrl,duration,timed_lyrics:tl,parts,notes:sorted,status:'ready',bpm,time_sig:timeSig}),
      });
      if(res.ok){setSong(await res.json());toast_('Saved & published!');}
      else {const er=await res.json();toast_('Error: '+(er.error??'save failed'));}
    } finally {setSaving(false);}
  }

  // ── Detect vocals (same Basic Pitch pipeline as Gen MIDI) ────────────────
  async function handleDetect() {
    if (!ytUrl||analyzing) return;
    setAnalyzing(true); toast_('Detecting vocals… takes 2-5 min');
    try {
      const res=await fetch(`/api/pipeline/vocals/${songId}`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({yt_url:ytUrl}),
      });
      if(!res.ok){
        const er=await res.json().catch(()=>({}));
        toast_('Detection failed: '+(er.error??res.statusText));
        setAnalyzing(false); return;
      }
      let tries=0;
      const poll=setInterval(async()=>{
        tries++;
        try {
          const r = await fetch(`/api/songs?id=${songId}`);
          if (!r.ok) {
            // Non-200: skip this tick but don't stop (pipeline may be mid-write)
            return;
          }
          const s: Song = await r.json();
          // Show pipeline log as live status
          if(s.pipeline_log) toast_(s.pipeline_log);
          // Error state
          if(s.pipeline_log?.startsWith('vocals-error:')){
            clearInterval(poll);
            toast_('Detection error: ' + s.pipeline_log.replace('vocals-error:','').trim().slice(0,120));
            setAnalyzing(false); return;
          }
          if(s.notes&&s.notes.length>0){
            clearInterval(poll);
            if (s.notes.every(n=>n.part===-1)) {
              const { notes: harmonized } = harmonizeSatb(s.notes);
              setNotes(harmonized);
              toast_(`✓ ${s.notes.length} notes detected — harmony auto-generated`);
              autoSaveHarmony(harmonized);
            } else {
              setNotes(s.notes);
              toast_(`✓ ${s.notes.length} notes detected — piano roll updated`);
            }
            setAnalyzing(false);
          } else if(tries>90){
            clearInterval(poll); toast_('Timed out — pipeline may still be running');
            setAnalyzing(false);
          }
        } catch { /* network hiccup — keep polling */ }
      },5000);
    } catch(err){toast_(String(err));setAnalyzing(false);}
  }

  function toast_(msg: string){setToast(msg);setTimeout(()=>setToast(''),5000);}

  const selNote = selId ? notes.find(n=>n.id===selId) : null;
  const vid     = ytVid(ytUrl);

  // ── Render ────────────────────────────────────────────────────────────────────
  if (loading) return <div className="h-screen flex items-center justify-center text-purple-400 text-sm font-mono" style={{background:'#0a0a12'}}>Loading…</div>;
  if (!song)   return <div className="h-screen flex items-center justify-center text-red-400 text-sm" style={{background:'#0a0a12'}}>Song not found.</div>;

  return (
    <>
    {/* eslint-disable-next-line @next/next/no-page-custom-font */}
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap"/>
    <div className="h-screen text-white flex flex-col overflow-hidden" style={{background:'#0a0a12',userSelect:'none'}}
      onClick={()=>setCtx2(null)}>

      {/* ── HEADER ── Title / Tempo / Save are the dominant controls; everything else is secondary. */}
      <header className="flex-none bg-[#14142a] border-b border-purple-900/30 px-4 py-3 flex items-center gap-3 flex-wrap">
        <button onClick={()=>router.back()}
          className="text-gray-500 hover:text-white text-xs px-2 py-1 transition-colors">
          ← Back
        </button>
        <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Untitled"
          className="bg-[#1a1a2e] border border-purple-900/30 rounded-lg px-3 py-2 text-base font-bold w-48 focus:outline-none focus:border-[#7c3aed]"
          style={{color:'#22d3ee',fontFamily:"'Orbitron',monospace",letterSpacing:'0.02em'}}/>
        <input value={artist} onChange={e=>setArtist(e.target.value)} placeholder="Artist"
          className="hidden sm:block bg-[#1a1a2e] border border-purple-900/30 rounded-lg px-2.5 py-2 text-sm w-32 focus:outline-none focus:border-[#7c3aed]"/>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 font-semibold">BPM</span>
          <input type="number" min={20} max={300} value={bpm}
            onChange={e=>setBpm(Math.max(20,Math.min(300,parseInt(e.target.value)||120)))}
            className="bg-[#1a1a2e] border border-purple-900/30 rounded-lg px-2 py-2 text-sm w-16 text-[#22d3ee] font-mono font-bold focus:outline-none focus:border-purple-500"/>
        </div>
        <div className="flex-1"/>
        <button onClick={handleSave} disabled={saving}
          className="disabled:opacity-50 text-white text-sm font-bold px-6 py-2.5 rounded-lg transition-colors" style={{background:'linear-gradient(135deg,#7c3aed,#6d28d9)'}}>
          {saving?'Saving…':'Save & Publish'}
        </button>
      </header>

      {/* ── SECONDARY TOOLBAR ── view tabs + import/detect/harmony actions, visually quiet */}
      <div className="flex-none bg-[#10101e] border-b border-purple-900/20 px-4 py-1.5 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0.5 bg-[#1a1a2e] border border-purple-900/20 rounded p-0.5">
          <button onClick={()=>setView('pianoroll')}
            className={`text-[11px] px-2 py-0.5 rounded transition-colors ${view==='pianoroll'?'bg-purple-900/50 text-purple-300':'text-gray-600 hover:text-gray-400'}`}>
            Piano Roll
          </button>
          <button onClick={()=>setView('arrangement')}
            className={`text-[11px] px-2 py-0.5 rounded transition-colors ${view==='arrangement'?'bg-purple-900/50 text-purple-300':'text-gray-600 hover:text-gray-400'}`}>
            Arrangement
          </button>
        </div>
        <div className="w-px h-3.5 bg-purple-900/30"/>
        {/* Hidden MIDI file input */}
        <input ref={midiInputRef} type="file" accept=".mid,.midi,audio/midi,audio/x-midi"
          className="hidden" onChange={handleMidiImport}/>
        <button onClick={()=>midiInputRef.current?.click()}
          className="text-[11px] text-gray-500 hover:text-gray-300 px-2 py-0.5 rounded flex items-center gap-1 transition-colors"
          title="Upload a MIDI file to populate the piano roll (replaces AI detection)">
          🎹 Import MIDI
        </button>
        <button onClick={handleDetect} disabled={analyzing||!ytUrl}
          className="text-[11px] text-gray-500 hover:text-gray-300 disabled:opacity-40 px-2 py-0.5 rounded flex items-center gap-1 transition-colors">
          {analyzing
            ? <><span className="animate-spin inline-block w-2.5 h-2.5 border-2 border-purple-400 border-t-transparent rounded-full"/>Detecting…</>
            : '🎤 Detect Vocals'}
        </button>
        <button onClick={handleRegenerateHarmony} disabled={!notes.some(n=>n.part===0)}
          title="Regenerate Alto/Tenor/Bass from the current melody (part 0). Melody notes are left untouched."
          className="text-[11px] text-gray-500 hover:text-gray-300 disabled:opacity-40 px-2 py-0.5 rounded flex items-center gap-1 transition-colors">
          🎼 Regenerate Harmony
        </button>
      </div>

      {/* ── YOUTUBE + CONTROLS ── */}
      <div className="flex-none flex bg-[#14142a] border-b border-purple-900/30" style={{minHeight:0}}>

        {/* YouTube embed — fixed 200px wide, collapsible */}
        <div style={{width:ytHide||!vid?0:220,overflow:'hidden',transition:'width .2s',flexShrink:0}}>
          <div ref={ytDivRef} style={{width:220,height:148,background:'#000'}}/>
        </div>

        <div className="flex flex-col flex-1 min-w-0 py-1 px-2 gap-1">
          {/* Transport — kept fully functional, just visually quieter than the header */}
          <div className="flex items-center gap-1.5 flex-wrap opacity-90">
            {/* Tool mode: Select / Draw / Erase */}
            <div className="flex rounded overflow-hidden border border-purple-900/20 flex-shrink-0">
              <button onClick={()=>setDrawMode('select')} title="Select (S): click to select, drag to box-select"
                className={`text-[11px] px-2 py-0.5 transition-colors flex items-center gap-1 ${drawMode==='select'?'bg-[#22d3ee]/80 text-[#0a0a12] font-semibold':'bg-[#14142a] text-gray-600 hover:text-gray-400'}`}>
                ↖ Select
              </button>
              <button onClick={()=>setDrawMode('draw')} title="Draw (D): click to add note, drag to set length"
                className={`text-[11px] px-2 py-0.5 transition-colors flex items-center gap-1 ${drawMode==='draw'?'bg-[#7c3aed]/80 text-white font-semibold':'bg-[#14142a] text-gray-600 hover:text-gray-400'}`}>
                ✏ Draw
              </button>
              <button onClick={()=>setDrawMode('erase')} title="Erase (E): click any note to delete it"
                className={`text-[11px] px-2 py-0.5 transition-colors flex items-center gap-1 ${drawMode==='erase'?'bg-red-700/80 text-white font-semibold':'bg-[#14142a] text-gray-600 hover:text-gray-400'}`}>
                ⌫ Erase
              </button>
            </div>
            <div className="w-px h-3.5 bg-purple-900/20"/>
            {vid&&(
              <button onClick={()=>setYtHide(h=>!h)}
                className="text-[11px] text-gray-600 hover:text-gray-400 px-1.5 py-0.5 transition-colors">
                {ytHide?'▶ Video':'◀ Hide'}
              </button>
            )}
            <button onClick={()=>ytPlaying?playerRef.current?.pauseVideo():playerRef.current?.playVideo()}
              className="w-6 h-6 flex items-center justify-center bg-[#1a1a2e] hover:bg-[#1e1e3a] border border-purple-900/20 rounded text-xs transition-colors">
              {ytPlaying?'⏸':'▶'}
            </button>
            <button onClick={()=>seekTo(0)} title="Go to start"
              className="text-[11px] text-gray-600 hover:text-gray-400 px-1 transition-colors">⏮</button>
            <button
              onClick={()=>startPreview(false)}
              title={previewing ? 'Stop preview' : 'Preview notes from current position'}
              className={`text-[11px] px-1.5 py-0.5 rounded transition-colors ${previewing?'bg-amber-800/70 text-amber-200':'text-gray-500 hover:text-gray-300'}`}>
              {previewing ? '⏹ Stop' : '🔊 Preview'}
            </button>
            <button
              onClick={()=>startPreview(true)}
              title="Play all notes from start"
              disabled={previewing}
              className="text-[11px] px-1.5 py-0.5 text-gray-500 hover:text-gray-300 disabled:opacity-40 transition-colors">
              🔊↺
            </button>
            <span className="text-[11px] font-mono text-gray-500 tabular-nums min-w-[64px]">{fmtTime(ytTime)} / {fmtTime(ytDur||duration)}</span>
            <div className="w-px h-3.5 bg-purple-900/20"/>
            {/* Zoom */}
            <button onClick={()=>setZoom(z=>clamp(z*0.75,20,800))} className="text-[11px] text-gray-600 hover:text-gray-400 w-5 h-5 flex items-center justify-center transition-colors">−</button>
            <span className="text-[11px] text-gray-600 w-12 text-center tabular-nums">{Math.round(zoom)}px/s</span>
            <button onClick={()=>setZoom(z=>clamp(z*1.33,20,800))} className="text-[11px] text-gray-600 hover:text-gray-400 w-5 h-5 flex items-center justify-center transition-colors">+</button>
            <div className="w-px h-3.5 bg-purple-900/20"/>
            {/* Time signature */}
            <select value={timeSig} onChange={e=>setTimeSig(+e.target.value)}
              className="text-[11px] bg-[#1a1a2e] border border-purple-900/20 rounded px-1 py-0.5 text-gray-500 focus:outline-none">
              <option value={2}>2/4</option>
              <option value={3}>3/4</option>
              <option value={4}>4/4</option>
              <option value={6}>6/8</option>
            </select>
            <div className="w-px h-3.5 bg-purple-900/20"/>
            {/* Musical snap grid */}
            <span className="text-[11px] text-gray-600">Grid:</span>
            {(['off','32','16','8','4','4d','8d','2','1'] as SnapMode[]).map(v=>(
              <button key={v} onClick={()=>setSnapMode(v)}
                className={`text-[11px] px-1 py-0.5 rounded transition-colors ${snapMode===v?'bg-purple-900/40 text-purple-300':'text-gray-600 hover:text-gray-400'}`}>
                {v==='off'?'Off':v==='1'?'1':v==='2'?'½':v==='4'?'¼':v==='8'?'⅛':v==='4d'?'¼·':v==='8d'?'⅛·':v==='16'?'1/16':'1/32'}
              </button>
            ))}
          </div>
          {/* Part selector — bold pills, the main thing you interact with while editing */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500 font-semibold">Paint:</span>
            {PARTS.map((pn,pi)=>(
              <button key={pi}
                onClick={()=>{ actPartR.current=pi; setActPart(pi); setVis(v=>{const n=[...v];n[pi]=true;return n;}); }}
                onContextMenu={e=>{e.preventDefault();setVis(v=>{const n=[...v];n[pi]=!n[pi];return n;});}}
                title={`Left click: paint as ${pn} · Right click: toggle visibility`}
                className={`text-xs font-bold px-3.5 py-1.5 rounded-full border-2 transition-all ${actPart===pi?'scale-110 border-white':'border-transparent'} ${!vis[pi]?'opacity-25':''}`}
                style={{background:PCOL[pi]+(actPart===pi?'55':'22'),color:PCOL[pi]}}>
                {pn}
              </button>
            ))}
            <button onClick={()=>setVis([true,true,true,true])} className="text-xs text-gray-600 hover:text-gray-300 px-2 py-1 rounded-full border border-transparent hover:border-purple-900/30 transition-colors">All</button>
            <div className="flex-1"/>
            <span className="text-xs text-gray-700">{notes.length} notes</span>
            {notes.length>0&&(
              <button
                onClick={()=>{
                  if (!confirm('Clear all notes from the piano roll? This cannot be undone.')) return;
                  pushUndo(notes);
                  setNotes([]); setSelId(null);
                }}
                className="text-xs text-red-500 hover:text-red-300 border border-red-900 hover:border-red-700 rounded px-2 py-0.5 transition-colors ml-1">
                Clear All
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── PIANO ROLL ── */}
      {view==='pianoroll' && (()=>{
        const maxNoteEnd = notes.reduce((m,n)=>Math.max(m,n.end),0);
        const maxScrX = Math.max(duration, maxNoteEnd+10, 120);
        const maxScrY = (MIDI_HI-MIDI_LO+3)*NOTE_H;
        return (
          <div className="flex-1 flex flex-col" style={{minHeight:0,overflow:'hidden'}}>
            {/* Canvas row + vertical scrollbar */}
            <div className="flex-1 flex" style={{minHeight:0,overflow:'hidden'}}>
              <div ref={wrapRef} className="flex-1 relative" style={{minHeight:0,overflow:'hidden'}}>
                <canvas
                  ref={canvasRef}
                  style={{position:'absolute',top:0,left:0,cursor}}
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onMouseUp={endDrag}
                  onMouseLeave={endDrag}
                  onDoubleClick={onDblClick}
                  onContextMenu={onContextMenu}
                />
              </div>
              {/* Vertical scrollbar — scroll through octaves */}
              <div style={{width:18,background:'#0a0a12',borderLeft:'1px solid rgba(124,58,237,0.15)',display:'flex',alignItems:'stretch',paddingTop:RULER_H+'px',flexShrink:0}}>
                <input type="range" min={0} max={maxScrY} step={1}
                  value={scrollY}
                  onChange={e=>{const v=+e.target.value;scrYR.current=v;setScrY(v);}}
                  style={{writingMode:'vertical-lr' as React.CSSProperties['writingMode'],flex:1,width:14,margin:'0 2px',accentColor:'#7c3aed',cursor:'pointer'}}
                />
              </div>
            </div>
            {/* Horizontal scrollbar — scroll through time */}
            <div style={{height:22,background:'#0a0a12',borderTop:'1px solid rgba(124,58,237,0.15)',display:'flex',alignItems:'center',paddingLeft:KEY_W+'px',paddingRight:22,gap:8,flexShrink:0}}>
              <input type="range" min={0} max={maxScrX} step={0.25}
                value={scrollX}
                onChange={e=>{const v=+e.target.value;scrXR.current=v;setScrX(v);}}
                style={{flex:1,height:8,accentColor:'#7c3aed',cursor:'pointer'}}
              />
              <span style={{fontSize:10,fontFamily:'monospace',color:'rgba(124,58,237,0.55)',minWidth:88,textAlign:'right'}}>
                {fmtTime(scrollX)} / {fmtTime(maxScrX)}
              </span>
            </div>
          </div>
        );
      })()}

      {/* ── ARRANGEMENT (chord chart) ── */}
      {view==='arrangement' && (
        <ArrangementView songId={songId} notes={notes} bpm={bpm} timeSig={timeSig} duration={duration}/>
      )}

      {/* ── BOTTOM PANEL ── */}
      <div className="flex-none bg-[#14142a] border-t border-purple-900/30 px-3 py-2 flex items-center gap-2 flex-wrap min-h-[48px]">
        {selNote ? (
          <>
            <span className="text-xs font-mono bg-[#1a1a2e] text-[#22d3ee] px-2 py-1 rounded border border-purple-900/30">{midiName(selNote.midi)}</span>
            <span className="text-xs text-gray-600 font-mono">{selNote.start.toFixed(2)}→{selNote.end.toFixed(2)}s</span>
            <div className="w-px h-5 bg-purple-900/40"/>
            <label className="text-xs text-gray-500">Lyric:</label>
            <input id="lyric-input" autoComplete="off"
              className="bg-[#1a1a2e] border border-purple-900/30 focus:border-[#7c3aed] rounded px-3 py-1.5 text-sm text-white w-44 focus:outline-none"
              placeholder="Syllable / word…"
              value={selNote.lyric}
              onChange={e=>setNotes(p=>p.map(n=>n.id===selId?{...n,lyric:e.target.value}:n))}
              onKeyDown={e=>{
                if(e.key==='Enter'||e.key==='Escape'){e.currentTarget.blur();return;}
                if(e.key===' '||e.key==='Tab'){
                  e.preventDefault();
                  const sorted=[...notesR.current].sort((a,b)=>a.start-b.start);
                  const idx=sorted.findIndex(n=>n.id===selId);
                  if(idx>=0&&idx<sorted.length-1){
                    const next=sorted[idx+1];
                    setSelId(next.id);
                    setTimeout(()=>document.getElementById('lyric-input')?.focus(),30);
                  }
                }
              }}
            />
            <div className="w-px h-5 bg-purple-900/40"/>
            {PARTS.map((pn,pi)=>(
              <button key={pi}
                onClick={()=>setNotes(p=>p.map(n=>n.id===selId?{...n,part:pi}:n))}
                className="text-xs px-2 py-1 rounded border transition-all"
                style={{background:PCOL[pi]+(selNote.part===pi?'55':'15'),color:PCOL[pi],borderColor:selNote.part===pi?PCOL[pi]:PCOL[pi]+'30'}}>
                {pn[0]}
              </button>
            ))}
            <button onClick={()=>setNotes(p=>p.map(n=>n.id===selId?{...n,part:-1}:n))}
              className={`text-xs px-2 py-1 rounded border transition-colors ${selNote.part===-1?'border-gray-400 text-gray-300 bg-[#1a1a2e]':'border-purple-900/30 text-gray-600'}`}>?</button>
            <div className="w-px h-5 bg-purple-900/40"/>
            <button onClick={()=>{
              const src=notesR.current.find(n=>n.id===selId); if(!src) return;
              const c: SongNote={...src,id:uid(),start:src.end,end:src.end+(src.end-src.start)};
              pushUndo(notesR.current); setNotes(p=>[...p,c]); setSelId(c.id);
            }} className="text-xs text-[#22d3ee] hover:text-white px-2 py-1 border border-purple-900/30 hover:border-purple-500 rounded transition-colors">⊕ Dupe</button>
            <button onClick={()=>{pushUndo(notesR.current);setNotes(p=>p.filter(n=>n.id!==selId));setSelId(null);}}
              className="text-xs text-red-400 hover:text-red-300 px-2 py-1 border border-red-900 hover:border-red-700 rounded transition-colors">✕ Del</button>
          </>
        ) : selIds.size > 0 ? (
          <>
            <span className="text-xs font-semibold text-[#22d3ee]">{selIds.size} notes selected</span>
            <span className="text-xs text-gray-600">Assign to:</span>
            {PARTS.map((pn,pi)=>(
              <button key={pi}
                onClick={()=>{
                  pushUndo(notesR.current);
                  setNotes(p=>p.map(n=>selIdsR.current.has(n.id)?{...n,part:pi}:n));
                  toast_(`${selIds.size} notes → ${pn}`);
                }}
                className="text-xs px-3 py-1 rounded border transition-all"
                style={{background:PCOL[pi]+'22',color:PCOL[pi],borderColor:PCOL[pi]+'55'}}>
                {pn}
              </button>
            ))}
            <button onClick={()=>{pushUndo(notesR.current);setNotes(p=>p.map(n=>selIdsR.current.has(n.id)?{...n,part:-1}:n));}}
              className="text-xs px-2 py-1 border border-purple-900/30 text-gray-500 rounded">?</button>
            <div className="w-px h-5 bg-purple-900/40"/>
            <button onClick={()=>{pushUndo(notesR.current);setNotes(p=>p.filter(n=>!selIdsR.current.has(n.id)));setSelIds(new Set());selIdsR.current=new Set();}}
              className="text-xs text-red-400 hover:text-red-300 px-2 py-1 border border-red-900 rounded">✕ Delete all</button>
            <button onClick={()=>{setSelIds(new Set());selIdsR.current=new Set();}}
              className="text-xs text-gray-600 hover:text-gray-400 px-2 py-1 border border-purple-900/30 rounded">Deselect</button>
          </>
        ) : (
          <p className="text-xs text-gray-700">
            {drawMode==='select'
              ? <><b className="text-[#22d3ee]">↖ Select</b> &nbsp;·&nbsp; Click = select &nbsp;·&nbsp; Drag = box select &nbsp;·&nbsp; Del = remove &nbsp;·&nbsp; Esc = deselect</>
              : drawMode==='erase'
              ? <><b className="text-red-400">⌫ Erase</b> &nbsp;·&nbsp; Click any note to delete it instantly</>
              : <><b className="text-purple-400">✏ Draw</b> &nbsp;·&nbsp; Click = place note &nbsp;·&nbsp; Drag = set length &nbsp;·&nbsp; Ctrl+Drag = box select &nbsp;·&nbsp; Scroll = pitch pan &nbsp;·&nbsp; Shift+Scroll = timeline</>
            }
          </p>
        )}
      </div>

      {/* ── CONTEXT MENU ── */}
      {ctx2&&(
        <div className="fixed z-50 bg-[#14142a] border border-purple-900/40 rounded-xl shadow-2xl py-1 min-w-[160px]"
          style={{left:ctx2.x,top:ctx2.y}}
          onClick={e=>e.stopPropagation()}>
          <button onClick={()=>{
            const src=notesR.current.find(n=>n.id===ctx2.id); if(!src) return;
            const c: SongNote={...src,id:uid(),start:src.end,end:src.end+(src.end-src.start)};
            pushUndo(notesR.current); setNotes(p=>[...p,c]); setSelId(c.id); setCtx2(null);
          }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#1e1e3a] transition-colors">⊕ Duplicate</button>
          <div className="border-t border-purple-900/30 my-1"/>
          {PARTS.map((pn,pi)=>(
            <button key={pi} onClick={()=>{setNotes(p=>p.map(n=>n.id===ctx2.id?{...n,part:pi}:n));setCtx2(null);}}
              className="w-full text-left px-4 py-1.5 text-xs hover:bg-[#1e1e3a] transition-colors"
              style={{color:PCOL[pi]}}>
              → {pn}
            </button>
          ))}
          <div className="border-t border-purple-900/30 my-1"/>
          <button onClick={()=>{pushUndo(notesR.current);setNotes(p=>p.filter(n=>n.id!==ctx2.id));setSelId(null);setCtx2(null);}}
            className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-950 transition-colors">✕ Delete</button>
        </div>
      )}

      {/* ── TOAST ── */}
      {toast&&(
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 bg-[#14142a] border border-purple-700/50 text-white text-sm px-5 py-3 rounded-xl shadow-2xl z-50 pointer-events-none" style={{boxShadow:'0 0 20px rgba(124,58,237,0.3)'}}>
          {toast}
        </div>
      )}
    </div>
    </>
  );
}
