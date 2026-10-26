// Tier 3: download the video, transcribe the audio, and pull frames for
// Claude to read on-screen text from. Everything lives in a temp dir that the
// caller deletes.
import { join } from "@std/path";
import { bin, paths } from "./config.ts";

const run = async (cmd: string, args: string[]) => {
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
  return { ok: out.success, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
};

export async function downloadVideo(url: string, cookiesFile: string, dir: string): Promise<string | null> {
  const r = await run(bin.ytDlp, [
    "--cookies", cookiesFile, "--no-warnings", "--no-playlist",
    "-S", "res:720", "--merge-output-format", "mp4",
    "-o", join(dir, "video.%(ext)s"), url,
  ]);
  if (!r.ok) return null;
  for (const e of Deno.readDirSync(dir)) if (e.name.startsWith("video.")) return join(dir, e.name);
  return null;
}

export async function transcribe(video: string, dir: string): Promise<string | null> {
  const wav = join(dir, "audio.wav");
  const a = await run(bin.ffmpeg, ["-y", "-v", "error", "-i", video, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  if (!a.ok) return null; // no audio track
  const model = join(paths.state, "models", "ggml-small.en.bin");
  const w = await run(bin.whisper, ["-m", model, "-f", wav, "-nt", "-np", "-t", "4"]);
  const text = w.stdout.replace(/\s+/g, " ").trim();
  // Music-only reels transcribe as "[Music]" and the like.
  return w.ok && text.replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim().length > 20 ? text : null;
}

async function duration(video: string): Promise<number> {
  const r = await run(bin.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]);
  return Number(r.stdout.trim()) || 0;
}

/** Up to 5 scene-change frames plus 5 evenly spaced ones, as JPEG bytes. */
export async function extractFrames(video: string, dir: string): Promise<Uint8Array[]> {
  const secs = await duration(video);
  await run(bin.ffmpeg, [
    "-v", "error", "-i", video,
    "-vf", "select='gt(scene,0.3)',scale=768:-2", "-fps_mode", "vfr",
    "-frames:v", "5", "-q:v", "5", join(dir, "scene%02d.jpg"),
  ]);
  if (secs > 0) {
    await run(bin.ffmpeg, [
      "-v", "error", "-i", video,
      "-vf", `fps=5/${secs.toFixed(2)},scale=768:-2`,
      "-frames:v", "5", "-q:v", "5", join(dir, "even%02d.jpg"),
    ]);
  }
  const files = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith(".jpg")).sort();
  return files.map((n) => Deno.readFileSync(join(dir, n)));
}
