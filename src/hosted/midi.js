// Standard MIDI files (type 0/1), including KAR text/lyric meta events.
export function parseMidi(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  let p = 0, count = 0;
  const check = (n) => { if (p + n > bytes.length) throw new Error("invalid_midi"); };
  const u8 = () => { check(1); return bytes[p++]; };
  const u16 = () => { check(2); const n = view.getUint16(p); p += 2; return n; };
  const u32 = () => { check(4); const n = view.getUint32(p); p += 4; return n; };
  const tag = () => String.fromCharCode(u8(), u8(), u8(), u8());
  const vlq = () => { let n = 0; for (let i = 0; i < 4; i++) { const b = u8(); n = n * 128 + (b & 127); if (!(b & 128)) return n; } throw new Error("invalid_midi_vlq"); };
  if (tag() !== "MThd") throw new Error("invalid_midi_header");
  const header = u32(), format = u16(), tracks = u16(), division = u16();
  if (header < 6 || format > 1 || !division || division & 0x8000 || tracks > 128) throw new Error("unsupported_midi");
  p += header - 6;
  const events = [];
  for (let track = 0; track < tracks; track++) {
    if (tag() !== "MTrk") throw new Error("invalid_midi_track");
    const length = u32(), end = p + length;
    check(length);
    let tick = 0, running = 0;
    while (p < end) {
      if (++count > 200000) throw new Error("midi_event_limit");
      tick += vlq();
      let status = u8();
      if (status < 128) { if (!running) throw new Error("invalid_running_status"); p--; status = running; }
      if (status === 255) {
        const type = u8(), length = vlq(); check(length);
        const data = bytes.slice(p, p + length); p += length;
        if (type === 81 && length === 3) events.push({ tick, tempo: data[0] * 65536 + data[1] * 256 + data[2] });
        if (type === 5 || type === 1) events.push({ tick, text: new TextDecoder().decode(data), lyric: type === 5 });
      } else if (status === 240 || status === 247) { running = 0; const length = vlq(); check(length); p += length; }
      else {
        if (status >= 240) throw new Error("invalid_midi_status");
        running = status;
        const kind = status >> 4, channel = status & 15, a = u8(), b = [12, 13].includes(kind) ? 0 : u8();
        if (a > 127 || b > 127) throw new Error("invalid_midi_data");
        events.push({ tick, kind, channel, a, b });
      }
      if (p > end) throw new Error("invalid_midi_track");
    }
  }
  events.sort((a, b) => a.tick - b.tick);
  let tick = 0, time = 0, tempo = 500000;
  const active = new Map(), notes = [], lyrics = [], programs = new Array(16).fill(0);
  const hasLyrics = events.some((e) => e.lyric);
  let line = "";
  for (const e of events) {
    time += (e.tick - tick) * tempo / division / 1000000; tick = e.tick;
    if (time > 1200) throw new Error("midi_duration_limit");
    if (e.tempo) tempo = e.tempo;
    if (e.kind === 12) programs[e.channel] = e.a;
    const key = `${e.channel}:${e.a}`;
    if (e.kind === 9 && e.b) {
      const previous = active.get(key);
      if (previous) { previous.duration = time - previous.time; notes.push(previous); }
      active.set(key, { time, pitch: e.a, velocity: e.b / 127, channel: e.channel, program: programs[e.channel] });
    } else if (e.kind === 8 || e.kind === 9) {
      const note = active.get(key);
      if (note) { note.duration = Math.max(0.02, time - note.time); notes.push(note); active.delete(key); }
    }
    if (e.text && (!hasLyrics || e.lyric) && !e.text.startsWith("@")) {
      if (/^[\\/\r\n]/.test(e.text)) line = "";
      line += e.text.replace(/[\\/\r\n]/g, "");
      lyrics.push({ time, text: line });
    }
  }
  for (const note of active.values()) { note.duration = Math.max(0.05, time - note.time); notes.push(note); }
  notes.sort((a, b) => a.time - b.time);
  return { notes, lyrics, duration: Math.max(1, time + 1) };
}

// Portable fallback synthesizer. No native engine, downloaded soundfont or remote assets.
export async function renderMidi(midi) {
  if (midi.notes.length > 30000) throw new Error("midi_note_limit");
  const context = new OfflineAudioContext(1, Math.ceil(midi.duration * 22050), 22050);
  const master = context.createGain(); master.gain.value = 0.16; master.connect(context.destination);
  for (const note of midi.notes) {
    const oscillator = context.createOscillator(), envelope = context.createGain();
    oscillator.type = note.channel === 9 ? "triangle" : ["sine", "triangle", "sawtooth", "square"][Math.floor(note.program / 32)];
    oscillator.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12);
    const end = note.time + Math.min(note.duration, note.channel === 9 ? 0.12 : 30);
    envelope.gain.setValueAtTime(0, note.time);
    envelope.gain.linearRampToValueAtTime(note.velocity * 0.35, note.time + 0.008);
    envelope.gain.setValueAtTime(note.velocity * 0.35, Math.max(note.time + 0.008, end));
    envelope.gain.linearRampToValueAtTime(0, end + 0.04);
    oscillator.connect(envelope); envelope.connect(master);
    oscillator.start(note.time); oscillator.stop(end + 0.05);
  }
  const audio = await context.startRendering(), samples = audio.getChannelData(0);
  const wav = new ArrayBuffer(44 + samples.length * 2), view = new DataView(wav);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, wav.byteLength - 8, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 22050, true); view.setUint32(28, 44100, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true));
  return new Blob([wav], { type: "audio/wav" });
}
