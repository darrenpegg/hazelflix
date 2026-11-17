# HazelFlix

Your films, series, music and photos, played in a browser or sent to the TVs on your network (DLNA).

- **Films and series** from your own folders, with posters, cast and ratings (TMDB, IMDb's datasets, Wikidata).
- **Plays anywhere on your network:** in a browser, or sent to a TV or games console that speaks DLNA, converted on the fly to what that screen can play.
- **Music**, with each song's card shown on the TV while it plays.
- **Photos as a screen saver:** upload them from a phone, and every idle screen shows them, gently moving, with where and when each was taken.

HazelFlix is one JavaScript file, run by Node.js. There's nothing to install from npm.

## What you need

- [Node.js](https://nodejs.org) 22.5 or later
- [ffmpeg](https://ffmpeg.org) and ffprobe (Mac: `brew install ffmpeg`)
- `curl` and `sqlite3`, for IMDb's and GeoNames' data (both come with macOS)

It's made and checked on Macs (Apple silicon). It converts video with the Mac's own encoder (VideoToolbox), so other systems aren't supported yet.

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

## Your data

Your data is kept outside this folder, so a new version can simply replace the folder:

- Mac: `~/Library/Application Support/HazelFlix`
- Linux: `~/.local/share/hazelflix`
- or wherever `HAZELFLIX_DATA` says.

It holds the database, your settings and keys, uploaded photos, posters, and the converted copies of films.

## Updating

Replace this folder with the new release's and start it again. Your data stays where it is.

## Credits

- Lettering in [Inter](https://github.com/rsms/inter), under the SIL Open Font License 1.1 (`assets/fonts/Inter-LICENSE.txt`).
- Film data from [TMDB](https://www.themoviedb.org) and [IMDb's non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/) (for personal and non-commercial use). Places from [GeoNames](https://www.geonames.org) (CC BY 4.0).
