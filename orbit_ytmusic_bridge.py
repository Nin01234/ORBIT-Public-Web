#!/usr/bin/env python3
"""ORBIT YouTube Music metadata and audio URL bridge.

This helper only returns metadata and short-lived URLs for publicly accessible
tracks. It never downloads or transcodes media.
"""
import argparse
import gettext
import json
import re
import sys
from urllib.parse import urlparse, parse_qs
_original_gettext_translation = gettext.translation
def _translation_with_fallback(domain, localedir=None, languages=None, class_=None, fallback=False):
    return _original_gettext_translation(domain, localedir=localedir, languages=languages, class_=class_, fallback=True)
gettext.translation = _translation_with_fallback

from ytmusicapi import YTMusic
from yt_dlp import YoutubeDL

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

def duration_seconds(value):
    if isinstance(value, (int, float)):
        return int(value)
    if not value:
        return 0
    try:
        parts = [int(p) for p in str(value).split(":")]
        total = 0
        for part in parts:
            total = total * 60 + part
        return total
    except Exception:
        return 0

def search_songs(query):
    query = (query or "").strip()[:120]
    if not query:
        raise ValueError("Enter a song or artist to search.")
    results = YTMusic().search(query, filter="songs", limit=18)
    tracks = []
    seen = set()
    for item in results or []:
        video_id = item.get("videoId")
        title = (item.get("title") or "").strip()
        if not video_id or not VIDEO_ID_RE.fullmatch(video_id) or not title:
            continue
        if video_id in seen:
            continue
        seen.add(video_id)
        artists = item.get("artists") or []
        artist = ", ".join(str(a.get("name") or "") for a in artists if a.get("name")) or "Unknown artist"
        album = item.get("album") or {}
        thumbnails = item.get("thumbnails") or []
        artwork = thumbnails[-1].get("url", "") if thumbnails else ""
        tracks.append({
            "id": "ytmusic:" + video_id,
            "videoId": video_id,
            "source": "YouTube Music",
            "title": title[:180],
            "artist": artist[:180],
            "album": str(album.get("name") or "")[:180],
            "duration": duration_seconds(item.get("duration_seconds") or item.get("duration")),
            "artwork": artwork[:1500],
            "previewOnly": False,
            "canDownload": False
        })
        if len(tracks) >= 18:
            break
    emit({"tracks": tracks})

def extract_audio(video_id):
    if not VIDEO_ID_RE.fullmatch(video_id or ""):
        raise ValueError("Invalid YouTube Music track identifier.")
    watch_url = "https://music.youtube.com/watch?v=" + video_id
    options = {
        "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "cachedir": False,
        "socket_timeout": 20,
        "retries": 2,
        "extractor_retries": 2,
        "fragment_retries": 2,
        "ignoreerrors": False
    }
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(watch_url, download=False)
    if not info or not info.get("url"):
        raise RuntimeError("YouTube Music did not provide an audio stream for this track.")
    if info.get("vcodec") not in (None, "none"):
        raise RuntimeError("The selected stream is not audio-only.")
    stream_url = info["url"]
    parsed = urlparse(stream_url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise RuntimeError("The provider returned an invalid audio stream URL.")
    expires = 0
    try:
        expires = int(parse_qs(parsed.query).get("expire", ["0"])[0])
    except Exception:
        pass
    emit({
        "videoId": video_id,
        "url": stream_url,
        "format": info.get("ext") or "",
        "mimeType": info.get("format") or "",
        "duration": int(info.get("duration") or 0),
        "expiresAt": expires
    })

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("search", "stream"))
    parser.add_argument("--query", default="")
    parser.add_argument("--video-id", default="")
    args = parser.parse_args()
    try:
        if args.action == "search":
            search_songs(args.query)
        else:
            extract_audio(args.video_id)
    except Exception as exc:
        emit({"error": str(exc)[:500] or "The music service is temporarily unavailable."})
        sys.exit(2)

if __name__ == "__main__":
    main()
