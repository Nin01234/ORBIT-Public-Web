import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const MAX_YOUTUBE_DOWNLOAD_BYTES = 250 * 1024 * 1024;
export const YOUTUBE_DOWNLOAD_TIMEOUT_MS = 8 * 60 * 1000;

export function isValidYouTubeVideoId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);
}

export async function cleanupYouTubeDownload(directory) {
  if (typeof directory !== "string" || !directory.startsWith(path.join(os.tmpdir(), "orbit-ytdlp-"))) return;
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
}

export async function downloadYouTubeVideo(videoId, { signal } = {}) {
  if (!isValidYouTubeVideoId(videoId)) throw new Error("Invalid YouTube video identifier.");
  if (signal?.aborted) throw new Error("Download cancelled.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-ytdlp-"));
  const outputTemplate = path.join(directory, "%(title).140B [%(id)s].%(ext)s");
  const command = process.env.ORBIT_PYTHON ? path.resolve(process.cwd(), process.env.ORBIT_PYTHON) : (process.platform === "win32" ? "py" : "python3");
  const args = [
    ...(process.platform === "win32" && !process.env.ORBIT_PYTHON ? ["-3"] : []),
    "-m", "yt_dlp", "--no-playlist", "--max-downloads", "1",
    "--no-warnings", "--no-progress", "--restrict-filenames",
    "--socket-timeout", "20", "--retries", "1", "--fragment-retries", "1",
    "--max-filesize", "250M",
    "--format", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "--output", outputTemplate,
    "--print", "after_move:filepath",
    "https://www.youtube.com/watch?v=" + videoId
  ];
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => { try { child.kill(); } catch {} finish(new Error("Download cancelled.")); };
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(new Error("Download timed out."));
      }, YOUTUBE_DOWNLOAD_TIMEOUT_MS);
      child.stdout.on("data", chunk => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 16000) { try { child.kill(); } catch {} finish(new Error("Download tool returned an invalid response.")); }
      });
      child.stderr.on("data", chunk => { if (stderr.length < 12000) stderr += chunk.toString("utf8"); });
      child.once("error", error => finish(new Error("Could not start the download service: " + error.message)));
      child.once("close", code => {
        if (code !== 0) {
          const error = new Error("yt-dlp exited with code " + code + (stderr.trim() ? ": " + stderr.trim().slice(-700) : ""));
          error.publicMessage = "This video could not be downloaded. It may be unavailable, too large, restricted, or the download tools may be unavailable.";
          finish(error); return;
        }
        finish(null, stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "");
      });
    });
    const filePath = path.resolve(output);
    if (!filePath.startsWith(directory + path.sep)) throw new Error("Download output path was invalid.");
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_YOUTUBE_DOWNLOAD_BYTES) throw new Error("The downloaded file is empty or exceeds the 250 MB limit.");
    return { directory, filePath, size: stat.size };
  } catch (error) {
    await cleanupYouTubeDownload(directory);
    throw error;
  }
}
