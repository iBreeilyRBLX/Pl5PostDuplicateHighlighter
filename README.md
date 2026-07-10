# Pl5PostDuplicateHighlighter

Highlights duplicate forum posts in the target PL5 forum channel by comparing title, invite code, and first-message content similarity.

It also flags posts that appear to violate the Conduct 2 Advertising Guidelines (cyan tint + a corner badge listing the rule codes, with details in the hover tooltip):

- **C2-1** — more than one server invite in the post
- **C2-4** — post is missing both the Faction and Community Hub tags
- **C2-5/C2-7** — title uses custom unicode letters/fonts, decorative symbols, sensationalist language, excessive caps, or excessive punctuation
- **C2-11** — post looks AI-written (em-dashes, typographic quotes, AI-typical phrasing, templated formatting) with no plain-text AI disclosure

Tint priority is: tracked (blacklisted) guild > duplicate > violation > unique. The violation badge and tooltip still appear on tracked/duplicate posts. Each rule can be toggled in plugin settings, and the C2-11 signal threshold is adjustable (higher = fewer false positives). These are heuristics meant to aid manual review, not verdicts.

Note that this plugin does collect live data from this repo [located here](https://raw.githubusercontent.com/iBreeilyRBLX/Pl5PostDuplicateHighlighter/refs/heads/master/trackedGuilds.json)
If you wish to turn this settings off them put the "Tracked Guild List Url" to Blank.

## First Time Setup

Vencord is not modular, so custom plugins require building from source.

Follow the setup guide:
<https://docs.vencord.dev/installing/custom-plugins/>

## Install

1. Open a terminal in your Vencord source tree.
2. Change to the userplugins folder:

```sh
cd src/userplugins
```

1. Clone this repository:

```sh
git clone https://github.com/iBreeilyRBLX/Pl5PostDuplicateHighlighter.git
```

## Update

From inside this plugin folder, pull the latest changes:

```sh
git pull
```
