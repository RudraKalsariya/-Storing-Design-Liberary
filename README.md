# Design Library

A personal design library for your desktop. Drop in posters, patterns, 3D renders, fonts, PDFs, links and notes, and keep them organised in folders.

You can sort things yourself, or turn on auto-sorting and let Claude look at each item and file it for you, creating new folders as your collection grows. Auto-sorting is optional.

The interface is deliberately minimal, inspired by [cosmos.so](https://www.cosmos.so/).

## Install the desktop app

1. Open the **[Releases](https://github.com/RudraKalsariya/-Storing-Design-Liberary/releases/latest)** page of this repository.
2. Under **Assets**, download the installer for your computer:
   - **…-mac-arm64.dmg**: Macs with an M1, M2, M3 or M4 chip
   - **…-mac-x64.dmg**: older Intel Macs
   - **…-win-x64.exe**: Windows
3. Install it:
   - **Mac:** open the `.dmg` and drag **Design Library** into **Applications**.
   - **Windows:** run the `.exe` installer.

The app isn't signed with a paid Apple or Microsoft developer certificate, so the first launch needs one extra step:

- **Mac:** if it says the app "is damaged" or "can't be opened", open the **Terminal** app, paste this line and press Enter, then open the app again:
  ```
  xattr -cr "/Applications/Design Library.app"
  ```
- **Windows:** if a blue "Windows protected your PC" box appears, click **More info → Run anyway**.

After that it opens like any other app.

## Using it

| To do this | Do this |
| --- | --- |
| Add things and choose the folder | Press **+**, choose or drop files (or paste a link or note), pick a folder under **Put it in**, then **Add** |
| Add straight into a folder | Open the folder, then paste (⌘V / Ctrl V) or drop files onto the window |
| Add with auto-sorting | With auto-sorting on, paste or drop anywhere on the main view |
| Save something from a website | Drag the image from your browser into the window, or paste its link |
| Make a folder | **Folders → New folder**, or **+ New folder…** in the Add dialog |
| Move something | Open it and pick another folder at the top, or drag it onto a folder chip |
| Find something | Press **/** and type. Search covers titles, tags, folders and note text |
| Rename or merge folders | Open a folder and press **Rename**. Renaming it to an existing folder's name merges the two |
| See the file on disk | Open an item and press **Show in Finder** (Mac) or **Show in folder** (Windows) |

With auto-sorting off, things you paste or drop on the main view open the Add dialog so you can pick a folder.

## Fonts

**Fonts** is a permanent folder: it can't be renamed or deleted, and font files always go there. Inside it are subfolders for each type of font (**Sans Serif**, **Serif**, **Display**, **Script** and **Monospace** to start). You can rename or delete those, or add your own with **+ Subfolder**.

- A new font goes straight into the matching subfolder when its type is clear, either from the classification stored in the font file or from its name ("Work Sans", "DM Mono"). With auto-sorting on, Claude also recognises well-known typefaces by name.
- Fonts whose type isn't clear wait at the top of **Fonts**.
- To arrange fonts, open **Fonts** and drag a font onto a subfolder chip, or open the font and pick a subfolder at the top. Dragging works for any item onto any folder chip.
- On disk the subfolders are real folders: `Design Library/Fonts/Serif/…`.

## Auto-sorting (optional)

Open **Settings** (the gear icon), paste an Anthropic API key, and switch on **Sort new things automatically**.

- Get a key at [platform.claude.com](https://platform.claude.com/settings/keys). It is pay-as-you-go: roughly a cent per image with the most accurate model, and much less with **Claude Haiku 5.5**, which you can pick under **Model**. Long PDFs cost more because every page is read.
- Claude looks at each new item along with your folder list and their descriptions. It either picks a folder or makes a new one, and writes a title, a description and search tags.
- Folder descriptions steer it: open a folder and press **Add description**.
- **Re-sort** on an item asks Claude again.
- Some file types never need Claude: fonts go to **Fonts**, videos to **Motion**, `.psd`, `.ai`, `.fig` and `.sketch` files to **Source Files**, 3D models to **3D Models**, archives to **Archives**.
- The key is checked when you save it and is stored only on your computer, in the app's settings file.

## Where your files live

Your library is a normal folder, **Documents/Design Library**, with one subfolder per category:

```
Design Library/
  Poster Layouts/
    swiss-jazz-poster-a1b2c3.png
  Patterns/
  Fonts/
    big-shoulders-bold-d4e5f6.ttf
  .library.json      ← titles, tags and folder info
  .thumbs/           ← small previews for the grid
```

There is no storage limit beyond your disk. Originals are never changed. To keep the library somewhere else, such as an external drive or a Dropbox or iCloud folder, use **Settings → Library folder → Change…**.

Move and rename things inside the app rather than in Finder or Explorer, so the app's index stays in step with the folders.

## Updating

Installing a newer version over the old one keeps everything, because your library lives in `Documents/Design Library`, outside the app. Your settings are kept too. You can check which version you have at the bottom of **Settings**.

To publish a new version:

1. Raise the version number in `package.json` (`1.1.0` → `1.1.1` for fixes, `1.2.0` for new features).
2. Commit, then push a tag with the same number: `git tag v1.2.0 && git push origin v1.2.0`.
3. GitHub builds the Mac, Windows and Linux installers and publishes them on the Releases page, usually within 15 minutes.

## Run from source (for development)

Needs [Node.js](https://nodejs.org/) 20.12 or newer.

```bash
npm install
npm run app        # the desktop app
npm start          # or: in your browser at http://localhost:4321
```

In browser mode the library is stored in `./library` and settings in `./settings.json`. You can also preset things in a `.env` file (see `.env.example`).

Build installers locally with `npm run build:mac`, `npm run build:win` or `npm run build:linux`; they appear in `dist/`. Every push to GitHub also builds test installers, which you can download from that run's page on the **Actions** tab.

## Project layout

```
electron/          the desktop app window (main.js) and its bridge to the page (preload.cjs)
server.js          starts the library in browser mode
src/server.js      the web server and API used by both modes
src/classify.js    the auto-sorting prompt and the file-type rules
src/ingest.js      reading files, links and notes; thumbnails and colors; the sort queue
src/store.js       folders on disk and the library index
src/config.js      settings
public/            the interface (plain HTML, CSS and JavaScript)
```
