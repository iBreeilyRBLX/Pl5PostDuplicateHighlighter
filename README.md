# Pl5PostDuplicateHighlighter

Highlights duplicate forum posts in the target PL5 forum channel by comparing title, invite code, and first-message content similarity.

## Warning

> ⚠️ Installing anything from community plugin repositories is not officially supported.
>
> Community plugins are not actively tested or vetted by the Vencord team. They may be unstable or malicious. Only install plugins if you trust the author and understand what you are doing.
>
> If you do not understand these instructions, do not install unofficial plugins.
>
> Do not ask for help in <#1026515880080842772>. Ask in the plugin thread instead.

## First Time Setup

Vencord is not modular, so custom plugins require building from source.

Follow the setup guide:
https://docs.vencord.dev/installing/custom-plugins/

## Install

1. Open a terminal in your Vencord source tree.
2. Change to the userplugins folder:

```sh
cd src/userplugins
```

3. Clone this repository:

```sh
git clone https://github.com/<your-username>/Pl5PostDuplicateHighlighter
```

## Update

From inside this plugin folder, pull the latest changes:

```sh
git pull
```

## Notes

- This repository contains one plugin.
- The plugin entry file is [index.ts](index.ts).
- No external APIs are used.
