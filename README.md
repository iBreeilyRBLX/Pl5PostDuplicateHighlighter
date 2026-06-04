# Pl5PostDuplicateHighlighter

Highlights duplicate forum posts in the target PL5 forum channel by comparing title, invite code, and first-message content similarity.

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
