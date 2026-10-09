# Library

A personal design library that sorts itself.

Paste, drop or add anything: a poster layout, a pattern, a 3D render, a font file, a PDF, a link, a note. Claude looks at each one, decides what it is, and files it into the right folder. If nothing fits, it makes a new folder, so the library keeps growing new folders as your collection widens. You never sort anything by hand, though you can whenever you want to.

The interface is deliberately minimal (inspired by [cosmos.so](https://www.cosmos.so/)): a search bar, a masonry grid, and your folders.

## Setup

You need [Node.js](https://nodejs.org/) 20.12 or newer and an Anthropic API key from [platform.claude.com](https://platform.claude.com/).

```bash
npm install
cp .env.example .env      # then paste your API key into .env
npm start
```

Open **http://localhost:4321**.

Without an API key the app still works, but everything except fonts lands in **Unsorted**. Add a key later, restart, open an item and press **Re-sort**.

## Using it

| To do this | Do this |
| --- | --- |
| Add images or files | Paste (⌘V / Ctrl V) anywhere, drag them onto the page, or press **+** |
| Save something from another website | Drag the image from the other tab onto the page, or paste its link |
| Save a link or a note | Paste the link or the text anywhere on the page |
| Find something | Press **/** and type. Search covers titles, descriptions, tags, folders and note text |
| See all folders | Click **Folders** |
| Move something | Open it and pick another folder, or **+ New folder…** |
| Ask Claude again | Open it and press **Re-sort** |
| Rename or merge folders | Open a folder and press **Rename**. Renaming a folder to the name of an existing one merges them |
| Steer how a folder is used | **Add description** on a folder. Claude reads these descriptions when it sorts |

Each item also shows its colors (click a swatch to copy the hex), its tags, and where it sits on disk. Fonts get a live type specimen you can type into.

## How sorting works

- **Images, PDFs, links and notes** are shown to Claude together with your current list of folders and their descriptions. Claude either picks an existing folder or creates a new one, and writes a title, a one-line description and tags for search.
- **Links** are saved with the page's preview image, which is what Claude looks at.
- Some types are sorted by rule, without asking Claude: fonts go to **Fonts**, videos to **Motion**, `.psd` / `.ai` / `.fig` / `.sketch` files to **Source Files**, 3D models to **3D Models**, archives to **Archives**.
- Near-duplicate folder names are merged automatically ("Poster Layout" and "poster layouts" are the same folder).
- Saving the exact same file twice is detected and skipped.
- A folder Claude created disappears again once it's empty. Folders you created, renamed or described stay put.

## Where your files live

Everything is stored on your own computer, in the `library/` folder, as real folders named after each category:

```
library/
  Poster Layouts/
    swiss-jazz-poster-a1b2c3.png
  Patterns/
  3D Illustrations/
  Fonts/
    big-shoulders-bold-d4e5f6.ttf
  .library.json      ← titles, tags and folder info
  .thumbs/           ← small previews for the grid
```

You can browse it in Finder or Explorer like any folder. Originals are never resized or recompressed; only a small copy is sent to Claude.

There is no storage limit beyond your disk. To keep the library somewhere bigger, such as an external drive or a synced Dropbox / iCloud folder, set `LIBRARY_DIR` in `.env`.

Move or rename files from inside the app rather than in Finder, so the app's index stays in step with the folders.

## Settings (`.env`)

| Setting | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Turns on auto-sorting |
| `LIBRARY_DIR` | `library` | Where your folders and files are stored |
| `PORT` | `4321` | The port the app runs on |
| `SORT_MODEL` | `claude-opus-5-5` | The Claude model that sorts things |
| `SORT_EFFORT` | `low` | How hard the model thinks about each item. Raise it to `medium` if sorting feels off |
| `SORT_CONCURRENCY` | `3` | How many items are sorted at the same time |

The app only listens on your own machine (`127.0.0.1`), so nobody else on your network can open it.

## Cost

Each item you add makes one Claude API request with a downsized image, roughly a cent per image at the default settings. Long PDFs cost more because Claude reads every page. Fonts and other rule-sorted files cost nothing.

## Project layout

```
server.js          web server and API
src/classify.js    the sorting prompt and the rules
src/ingest.js      reading files, links and notes; thumbnails and colors; the sort queue
src/store.js       folders on disk and the library index
src/fontname.js    reads a font's real name from the file
public/            the interface (plain HTML, CSS and JavaScript)
```
