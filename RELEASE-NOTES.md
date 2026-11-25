# HazelFlix release notes

## HazelFlix 2391 (24 November 2026)

**Before you update:** back up your data folder. This version adds a table to the database the first time it starts.

- **Play history:** turn on Keep play history in Settings (it's off at first), and each time anyone plays a film or an episode is kept: who, on which screen, when, and how far they got. View history shows a week at a time, with the week before and after, and filters for who and which library. Clear history forgets it all.
- **The remote opens on the screen that's playing,** rather than the first one, unless you choose another.
- **Pages are lighter and quicker:** the look every page shares is now one small file your browser keeps, rather than sent again with each page; pages and the app's script are compressed on the way to your browser (the home page about a sixth of its size); and pages are put together several times faster.
- **Videos and songs that couldn't be read are tried again** on the next scan (or *Scan now* in Settings). Useful if ffprobe wasn't installed when HazelFlix first found them.
- **Add to Home Screen** gets HazelFlix's own name, icon and colour again: the browser had been refusing them.
- **`--timing`** (for `start.sh`) prints each request and how long HazelFlix took to answer it.
- **A series' episodes as a list or a grid:** List and Grid beside the season tabs. Your choice is remembered in this browser for every series.

## HazelFlix 2168 (18 November 2026)

**Before you update:** back up your data folder (on a Mac, `~/Library/Application Support/HazelFlix`). This version changes the database the first time it starts, and an older version can't read it afterwards.

### Libraries
- **Libraries of your own:** name them, give each its kind (films and TV, films, TV, music or photos) and its folders, and make as many as you like. Your existing folders become libraries automatically.
- **How each is indexed:** scanned hourly, daily or only when asked; found by the network engines, by IMDb's datasets kept locally, or simply named from the file names; converted for browsers or not.
- **Sharing:** a library belongs to whoever made it, who chooses which profiles can see it. Everyone can hide a library from their own home page and search.
- **A folder as one series:** "Treat as one series" on a folder makes every video in it an episode, with its folders as seasons. Good for home videos and lectures.
- **Each library's own Recently added** row on the home page. Search lists films, then TV, then music.

### Profiles
- **Who's watching:** each person has a profile, with a picture, a code if they want one (typed on a dial pad), and their own Continue watching, queues and playlists.
- **Hidden profiles** don't appear on Who's watching. They're for giving to a TV.
- **TVs and screens have profiles too,** and only ever play what that profile can see, whoever sends the film. Set them in Settings, TVs' profiles, including the default for new TVs.
- What isn't in your libraries is shown as *Not available* rather than played.

### Playing
- **Play where?** lists only the screens that can play what you chose.
- On a series, an episode's picture plays it.
- What a screen plays is remembered as the progress of whoever sent it.

### Editing
- **One Edit page** for each file, in place of Fix match and the audio page: its title and details, which film it is, and its sound track.
- **Pictures from the film itself:** play it frame by frame, place a box shaped like the poster or backdrop, and Set. Or upload a picture.
- **People:** change a part or its order, remove someone, or add someone new with a photo.
- **Genres and collections,** and an episode's and series' own title, description and pictures.
- **Your own collections:** make one by name, give it a description, poster and backdrop, and put films in or take them out. Collections are everyone's, but each person only sees the films they have access to.
- **Delete** takes a file out of HazelFlix without touching the file itself. It's shown only to the library's maker and the owner.

### Photos
- **Photo libraries:** your folders of photos, as well as uploads. Each screen's screen saver can show its own choice of them.

### Help
- **Help pages** in HazelFlix (Help in Settings), also at hazelflix.com/docs: getting started, libraries, profiles, TVs (including setting up a kids' TV), playing, editing, and putting HazelFlix on your phone.
- **A QR code of HazelFlix's address** on the phone page, to open it on your phone with its camera.

### Fixes
- A film watched on one profile no longer turns up in another's Continue watching.
- The code's dial pad works on a Mac (the intro no longer covers it).
- Rows of buttons are one height throughout, and pages no longer sit under the search box on a phone.

## HazelFlix 1937 (16 November 2026)

The first release.
