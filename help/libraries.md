# Libraries

A **library** is a named set of folders holding one kind of thing. Everything in HazelFlix comes from a library, and who sees what is decided by library.

## Kinds

| Kind | How its files are read |
|:--|:--|
| Films and TV | each from its name: `S01E02`, `1x02` or a `Season 2` folder is TV, the rest films |
| Films | every video a film |
| TV | every video an episode; one that doesn't read as one is an extra of the series its folder names |
| Music | songs and music videos, by their tags |
| Photos | photos, as the gallery takes them |

## Folders

A library has one folder or many: add them under *Another folder*. A folder belongs to one library. **Remove** takes it off: what was in it leaves HazelFlix, but everything known about its films is kept, so adding the folder again (to any library) finds them as they were. Your files themselves are never touched.

### A folder as one series

Some folders are a series that doesn't name itself as one: home videos, lectures, a show whose files are just titles. Beside such a folder, press **Treat as one series**. Every video under it becomes an episode of one series named after the folder (`Our Holidays (2019)` is *Our Holidays*, 2019):

- **Seasons** are the folders just inside it. `Season 2`, or a folder whose name starts with a number, keeps that number; the others follow the last numbered one, in name order. Videos right in the folder are season 1.
- **Episodes** are numbered from `S01E02` or `1x02` if a name has it; otherwise by the number every file in the season starts with (`01 Arrival.mp4`); otherwise in name order. The rest of the name is its title.
- `Featurettes`, `Extras` and the like inside it are its extras.

The engines look the series up by its name; if they don't know it, it's named from the folder and given a poster from a frame of its first episode. Edit it like any series. Press **✓ One series** to undo it.

## How it's indexed

On a library's own form:

- **Scanned** hourly, daily, or only when asked (*Scan now* in Settings). A video or song that couldn't be read (ffprobe wasn't installed yet, or the share dropped for a moment) is tried again on the next scan.
- **Found by** the network engines, the local IMDb only, or *named from their files* (nothing asked anywhere: the name's title and year, and a poster from a frame). The last suits home videos.
- **Converted for browsers**, or not: one that isn't plays live, never queued for converting.

## Sharing and Shown

- **A library is its maker's.** Anyone can make one; only its maker, and the owner, change it.
- **Shared with:** tick the profiles that may see it, and Save. The owner sees every library.
- **Shown** is each profile's own choice: a library not shown stays off *your* home page and out of *your* search, and is still there to anyone else.

What's in a library a profile doesn't see is shown to it as *Not available*: a person's films or a series list it, dimmed, with nothing to play. Collections are the exception: what's not yours in a collection isn't shown at all. TVs follow their profile's libraries: see [TVs](tvs.md).

## Deleting a library

*Delete this library*, at the bottom of its form: its files leave HazelFlix, the files themselves aren't touched, and what's known of their films is kept for when they come back.
