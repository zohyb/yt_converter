# TubeSnap — YouTube to MP3 / MP4 converter

Free, no-signup converter in the style of ytmp3.cc. **100% static — no backend, no API key, no quota.**

## How it works

1. **Stream info** — the browser asks a free public [Piped](https://github.com/TeamPiped/Piped) API instance
   (`GET /streams/{videoId}`) for the video's audio/video stream URLs. 15 public instances are tried
   in rotation; the last working one is tried first.
2. **Conversion** — [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (loaded from jsDelivr CDN)
   converts audio to MP3 (128/192/320 kbps) or merges separate video+audio streams into MP4,
   entirely inside the browser tab. Nothing is uploaded anywhere.
3. **Fast path** — muxed MP4 streams (video+audio in one file, up to 360p) download directly
   with no conversion at all.

## Deploy

Any static host works. Vercel example:

```bash
cd yt-converter
vercel deploy
```

`vercel.json` sets the `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers
required for `SharedArrayBuffer` (which ffmpeg.wasm needs). `credentialless` is used instead of
`require-corp` so cross-origin thumbnails keep loading.

Netlify / Cloudflare Pages / GitHub Pages: upload the folder and add the same two headers
(`_headers` file on Netlify/Cloudflare).

## Local dev

The COOP/COEP headers are required for the converter engine to load, so `file://` won't do.
Serve with headers, e.g.:

```bash
npx serve --cors .   # then add headers via a local proxy, or just test on a Vercel preview deploy
```

## Known limitations

- Public Piped instances go up and down; if all 15 are unreachable the app shows a retry message.
  (Same story on every free converter site.)
- Fetching stream bytes needs CORS on the stream host. If blocked, the app falls back to a
  direct download of the raw file.
- Very long videos (>60 min MP3, >30 min MP4 merge) are refused to avoid running out of
  browser memory.
- Only download videos you own, that are Creative Commons, or where the owner permits it.
