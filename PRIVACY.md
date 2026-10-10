# Magpie privacy policy

_Last updated: 10 October 2026_

Magpie is a design library that runs on your own computer. This policy explains what happens to your information when you use it.

## The short version

- Everything you save stays on your computer.
- Magpie has no accounts, no analytics, no tracking and no ads, and it doesn't send anything to us.
- Magpie only connects to the internet when you paste a link, or when you turn on optional auto-sorting with your own Anthropic API key.

## What Magpie stores, and where

| What | Where |
| --- | --- |
| The files you add (images, fonts, PDFs, notes, links) | Your library folder, by default `Documents/Magpie` |
| Titles, tags, colours and folder names | A file inside your library folder (`.library.json`) |
| Small preview images | Inside your library folder (`.thumbs`) |
| Your settings, including your Anthropic API key if you add one | The app's settings file in your computer's app-data folder |

None of this is uploaded anywhere by Magpie. You can see, copy, back up or delete your library folder at any time. Uninstalling Magpie doesn't delete it.

Your API key is stored in the settings file on your computer and is only sent to Anthropic, to make the auto-sorting requests you've turned on.

## When Magpie uses the internet

**When you paste or drop a link,** Magpie downloads that page (or the image or file it points to) directly from that website, to save it and show a preview. That website sees an ordinary request from your computer, as it would if you opened the link in a browser.

**When auto-sorting is on** (it's off unless you add an Anthropic API key in Settings), Magpie sends Anthropic's Claude API what it needs to choose a folder for each new item:

- a smaller copy of the image, or the PDF, or the text of a note, or a link's address, title, description and preview image;
- the original file name;
- the names and descriptions of your folders;
- for fonts whose type isn't stored in the font file, the font's name and designer.

These requests go from your computer straight to Anthropic, using your own API key, and Anthropic's [privacy policy](https://www.anthropic.com/legal/privacy) and terms apply to them. Magpie's developer never receives them. You can turn auto-sorting off, or remove your key, in **Settings** at any time.

## Children

Magpie isn't directed at children and doesn't knowingly collect information from anyone.

## Changes

If Magpie starts doing something new with your information, for example checking a licence when paid plans are added, this policy will be updated before that version is released, and the date at the top will change.

## Contact

Questions about privacy: open an issue at https://github.com/RudraKalsariya/-Storing-Design-Library/issues
