# HazelFlix

Your films, series, music and photos, played in a browser or sent to the TVs on your network (DLNA).

- **Films and series** from your own folders, with posters, cast and ratings (TMDB, IMDb's datasets, Wikidata).
- **Plays anywhere on your network:** in a browser, or sent to a TV or games console that speaks DLNA, converted on the fly to what that screen can play.
- **Subtitles** beside your files or fetched from OpenSubtitles in your languages, styled as you like, sent to TVs too (or drawn into the picture for those that don't show them).
- **Music**, with each song's card shown on the TV while it plays.
- **Photos as a screen saver:** upload them from a phone, and every idle screen shows them, gently moving, with where and when each was taken.

HazelFlix is one JavaScript file, run by Node.js. There's nothing to install from npm.

> **A note: this is yak shaving.** HazelFlix is really a test of a compiler suite, currently known as lsp: a
> Scheme-like language whose programs compile to native code, JavaScript and C#. HazelFlix is written in it, and
> `reel.js` here is what lsp made of it for Node.js. It's a real program because a real program finds what a test
> suite doesn't, so expect it to be useful, but not a product.

**Help:** [`help/`](help/index.md), also in HazelFlix itself at `/help`. **What's new:** [RELEASE-NOTES.md](RELEASE-NOTES.md). HazelFlix is made to be run from your phone: [put it on your home screen](help/phone.md).

## What you need

- [Node.js](https://nodejs.org) 22.5 or later
- [ffmpeg](https://ffmpeg.org) and ffprobe (Mac: `brew install ffmpeg`)
- `curl` and `sqlite3`, for IMDb's and GeoNames' data (both come with macOS)
- optionally, an ffmpeg that can draw subtitles (libass's), for subtitles drawn into the picture on TVs that don't show them (Mac: `brew install ffmpeg-full`, kept beside ffmpeg; HazelFlix finds it)

It's made and checked on Macs (Apple silicon), and in Docker (Linux). On a Mac it converts video with the Mac's own encoder (VideoToolbox); elsewhere with x264 and x265, in software.

## Start it

```sh
./start.sh --library ~/Movies
```

then open <http://127.0.0.1:8095>. The Settings page there adds more folders, keys for the film databases, and which TVs show the screen saver.

To reach it from the other machines and TVs on your network:

```sh
./start.sh --web 0.0.0.0:8095 --library ~/Movies --library ~/Music
```

| Option | |
| --- | --- |
| `--web HOST:PORT` | where it listens (`127.0.0.1:8095`) |
| `--library FOLDER` | a folder of films, series or music; as many as you like |
| `--db PATH` | its database, with the rest of its data beside it |
| `--quiet` | less in the log |

## In Docker

```sh
docker build -t hazelflix .
docker run -d --name hazelflix --network host \
  -v hazelflix-data:/data -v ~/Movies:/media/movies:ro \
  hazelflix --library /media/movies
```

then open <http://127.0.0.1:8095>. Its data (the database, photos, converted copies) is in the `hazelflix-data` volume, so a new image keeps it. Each folder of films or music is mounted read-only and named with `--library`.

- **TVs need `--network host`** (Linux): they find HazelFlix by multicast (DLNA's discovery), which Docker's own network doesn't pass. With `-p 8095:8095` instead (Docker Desktop on a Mac or Windows), browsers work but TVs won't see it.
- **Video is made in software** (x264 and x265), so converting takes more of the machine than a Mac's encoder does.

## Your data

Your data is kept outside this folder, so a new version can simply replace the folder:

- Mac: `~/Library/Application Support/HazelFlix`
- Linux: `~/.local/share/hazelflix`
- or wherever `HAZELFLIX_DATA` says (in Docker, `/data`).

It holds the database, your settings and keys, uploaded photos, posters, IMDb's and GeoNames' data, and the converted copies of films (in `converted/` when `HAZELFLIX_DATA` is set; else `~/Movies/reel`, unless Settings says elsewhere).

## Updating

Replace this folder with the new release's and start it again. Your data stays where it is.

## Licence

HazelFlix is under the [MIT License](LICENSE). What it includes from others, and their licences, is in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

## Credits

- Lettering in [Inter](https://github.com/rsms/inter), under the SIL Open Font License 1.1 (`assets/fonts/Inter-LICENSE.txt`).
- Icons from [Heroicons](https://github.com/tailwindlabs/heroicons), under the MIT License.
- Film data from [TMDB](https://www.themoviedb.org) and [IMDb's non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/) (for personal and non-commercial use). Places from [GeoNames](https://www.geonames.org) (CC BY 4.0).
