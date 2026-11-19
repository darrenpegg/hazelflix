# Getting started

## Installing it

HazelFlix comes as a folder, from [its releases](https://github.com/darrenpegg/hazelflix). It's one JavaScript file run by Node.js, with nothing to install from npm. You'll need:

- [Node.js](https://nodejs.org) 22.5 or later,
- [ffmpeg](https://ffmpeg.org) and ffprobe (on a Mac, `brew install ffmpeg`),
- `curl` and `sqlite3`, which come with a Mac.

Then, in the folder:

```
./start.sh --library ~/Movies
```

and open `http://127.0.0.1:8095` on the same computer.

### Reaching it from your phone and TVs

Started as above, only the computer it's on can reach it. To use it from your phone and send films to your TVs, start it listening on your network:

```
./start.sh --web 0.0.0.0:8095 --library ~/Movies
```

Then, from your phone, open `http://this-computer.local:8095` (the computer's name, then `.local`), or scan the code on [HazelFlix on your phone](phone.md), and put it on your home screen.

| Option | What it's for |
|:--|:--|
| `--web HOST:PORT` | where it listens. `127.0.0.1:8095` (the default) is this computer only; `0.0.0.0:8095` is your whole network, which your phone and TVs need |
| `--library FOLDER` | a folder of films, series or music, as many as you like (you can add more in the page, and make them into [libraries](libraries.md)) |
| `--db PATH` | its database, with the rest of its data beside it |
| `--quiet` | less in the log |

### In Docker

The folder has a `Dockerfile`; its `README.md` says how to build and run it. TVs find HazelFlix by multicast, so on Linux it needs `--network host`.

### Your data, and updating

Your data (the database, settings, keys, photos, posters and converted copies) is kept outside the folder: on a Mac in `~/Library/Application Support/HazelFlix`, on Linux in `~/.local/share/hazelflix`, or wherever `HAZELFLIX_DATA` says. So to update, replace the folder with the new one and start it again.

> Back up your data folder before updating: a new version may change the database as it starts, and there's no going back.

## The first time

The first profile, **Owner**, is made for you, and with one profile and no code HazelFlix goes straight in. Rename it on *Your profile* (the circle at the top right). Only the owner changes Settings. More on [profiles](profiles.md).

## Your first library

Open *Libraries* (from Your profile, or Settings), and under **A new library**:

1. give it a name ("Films"),
2. choose what it holds (*Films and TV* reads each file's name to tell; *Films*, *TV*, *Music* and *Photos* say so),
3. give its first folder, such as `/Volumes/media/Videos`. A share on your network has to be mounted in Finder first; it's then under `/Volumes`.

Make it, and HazelFlix scans it straight away. Each video found is looked at (its length, its picture, its sound) and then looked up. More in [Libraries](libraries.md).

## The engines: finding what your films are

HazelFlix reads a file's name for its title and year (`Die Hard (1988) 1080p.mkv` is *Die Hard*, 1988), then asks the **engines** what it is: its poster, plot, people and ratings. In Settings, *Engines*:

- **TMDB** gives posters, backdrops, people's photos, collections and TV seasons. It needs a key: *Get a key* takes you to where it's free, then paste it in.
- **OMDb** adds ratings (IMDb's, Rotten Tomatoes', Metacritic's). It needs a key too.
- **IMDb** is IMDb's own datasets, downloaded and kept here (*Fetch now*; a few hundred MB). No key, and nothing asked over the network once it's here, but no pictures.

Their order is the order they're asked in. A library can also be looked up in IMDb's datasets alone, or not at all: see [indexing](libraries.md#how-its-indexed).

What no engine finds is under *Unmatched* (Settings), to be found by hand.

## Converting

Browsers play only some files as they are (MP4 with H.264, mostly). The rest play *live*, made playable as they play, which takes the computer's effort and can't skip ahead as freely. **Converting** (Settings) makes a browser-ready copy of each in the background, one or two at a time, and a converted file plays like any other. You can pause it, and a library can be left out of it. More in [Playing](playing.md#converting).
