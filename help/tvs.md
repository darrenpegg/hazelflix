# TVs and what they can play

A TV that plays from HazelFlix doesn't choose a profile on Who's watching: it can't. Instead each TV, player and browser screen is given a profile in Settings, and **it sees only that profile's libraries**, whoever is using it and whoever sends a film to it. That's how a kids' TV is kept to the kids' films.

## How a TV gets its profile

There are three kinds of screen:

| Screen | What it is | Where its profile is set |
|:--|:--|:--|
| A DLNA TV or player | a TV, console, VLC or Infuse that finds HazelFlix on the network | Settings, TVs' profiles |
| A browser screen | a browser set to Play, showing Ready to play | Settings, TVs' profiles |
| Anything else | a player that only browses, or a browser that's lost its cookie | the default, New ones |

- **New ones** is the profile a screen gets until you give it one. It starts as the owner's, which sees everything, so change it first if you'd rather a new TV saw less.
- Each screen listed under TVs' profiles has its own drop-down. Leaving it on *The default* means it follows New ones.
- What a TV sees when it browses HazelFlix (Films, TV, Collections, Genres) is only what's in that profile's libraries, and HazelFlix won't send it a file from any other.

## A TV of its own: hidden profiles

You don't want a "Kids TV" profile on Who's watching for someone to choose by mistake. A **hidden profile** is for this: it's never on Who's watching, but it's there to give a TV.

### Setting up a kids' TV

1. **Make the profile.** Settings, Profiles: type its name ("Kids TV") and Add.
2. **Hide it.** Beside it, press *Hide from Who's watching*. (It says *Show on Who's watching* after, to undo it.)
3. **Share the right libraries with it.** Libraries: on each library the TV may play (say, *Kids films* and *Cartoons*), tick *Kids TV* under Shared with, and Save. Share nothing else.
4. **Give the TV that profile.** Settings, TVs' profiles: find the TV (by its name, or the name you gave it under Players on the network), choose *Kids TV (hidden)*, and Save.

That's all. Now:

- Browsing HazelFlix on that TV shows only the kids' libraries.
- If you send it a film from your phone with Play where?, and that film isn't in a library Kids TV sees, you're told *Not available on that TV.*, even if your own profile could play it.
- What it plays is still remembered as yours: Continue watching follows whoever sent it.

> **Tip:** to make every *new* TV safe until you've set it up, set **New ones** to the hidden profile too. Then a TV you plug in tomorrow sees only the kids' libraries until you give it something else.

### A TV for the whole family

The same steps with a hidden *Living room* profile, sharing every library but the ones for grown-ups. The owner's profile always sees everything, so a TV left on the owner's sees everything too.

## Subtitles on a TV

A film's subtitles (your first language's) go to a TV with it, for the TV to show: its own menu turns them on and off. Samsung TVs take them; some TVs and players (an Xbox) don't.

For those, **Your profile**, On TVs, **Subtitles in the picture** draws them into the picture instead: a film you send to a TV, or a TV given your profile browses, plays as a stream with them in it. It needs an ffmpeg that can draw them, Homebrew's *ffmpeg-full* (`brew install ffmpeg-full`); the page says when there isn't one. The stream is made as it plays, so a TV browsing can't skip ahead in it itself.

## Screen savers

Each screen has its own screen saver: the photos of the photo libraries ticked for it in Settings (under Players on the network, or Browsers), of those its profile sees. Nothing ticked means every photo library it sees. So the kids' TV can show the holiday photos, and not the ones from the office party. More in [Music and photos](music-and-photos.md#screen-savers).

## When a TV doesn't show up

- HazelFlix must be listening on your network, not just this computer: run it with `--web 0.0.0.0:8095`. Started on `127.0.0.1` (the default) TVs can't see it, and Settings says so.
- Settings, *TVs on the LAN* must be on.
- HazelFlix looks for players when it starts and every ten minutes; a TV that was off appears when it's next heard from.
