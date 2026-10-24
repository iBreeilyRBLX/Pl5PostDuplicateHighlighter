# Pl5PostDuplicateHighlighter

Highlights duplicate forum posts in the target PL5 forum channel. A post is a duplicate when it matches an earlier post inside the duplicate window (default 12 hours) on any enabled check:

- **title**: titles are compared after folding fancy unicode letters (𝔹𝕃𝔸ℂ𝕂, ＦＵＬＬＷＩＤＴＨ, Ⓒⓘⓡⓒⓛⓔⓓ) to plain text and dropping case, emoji and symbols, so "★ 𝐁𝐋𝐀𝐂𝐊𝐎𝐔𝐓 𝐏𝐌𝐂 ★" matches "Blackout PMC". Small-caps letters (ʙʟᴀᴄᴋ) and negative-squared letters (🅱) have no plain-text equivalent, so they aren't folded.
- **invite**: same invite code, or different invite codes for the same server. Invites are only resolved for posts inside the duplicate window, a few at a time.
- **content**: the first 200 characters of the first message, after stripping custom emoji, Discord timestamps, mentions, links and markdown symbols, must reach the similarity threshold. The tooltip shows the score, e.g. `content (87%)`.
- **author**: the same author posted another ad inside the window (`checkAuthor` setting, on by default).

The hover tooltip and the history modal show the nearest earlier match within two duplicate windows.

It also flags posts that appear to violate the Conduct 2 Advertising Guidelines (cyan tint + a corner badge listing the rule codes, with details in the hover tooltip):

- **C2-1** — more than one server invite in the post
- **C2-4** — post is missing both the Faction and Community Hub tags
- **C2-5/C2-7** — title uses custom unicode letters/fonts, decorative symbols, sensationalist language, excessive caps, or excessive punctuation. Excessive caps needs at least 6 letters, at least 70% of them uppercase, and at least 4 all-caps words. A caps faction name on its own ("BLACKOUT PMC", "US ARMY RANGERS") passes; "BLACKOUT PMC NOW RECRUITING" doesn't.
- **C2-11** — post looks AI-written (em-dashes, typographic quotes, AI-typical phrasing, templated formatting) with no plain-text AI disclosure

It also checks each post against the FD blacklist/warning records (`https://pl5fd.com/api/records`, synced from the FD spreadsheet):

1. The post author's Discord ID is looked up (this also matches server owners on community records).
2. The post title is looked up as a faction name (substring match, then filtered client-side).
3. Only if either hits, the post's invite is resolved and its server ID is compared with the records.

Matches get a red (blacklist) or orange (warning) outline and a top-left badge: `BL ✓` = confirmed by server ID, `BL` = author ID match, `BL?` = possible name match only (thinner outline). Once the post's invite resolves, a name-only match is re-checked by server ID: it becomes `BL ✓` if the server is in FD, disappears if every matched record lists a different server ID, and shows as a dimmed `BL? not in DB` if the server isn't in FD but a matched record has no server ID to compare. Expired and appealed records are still shown, with a grey `PAST` badge and outline, so mods see the history too. Details are in the hover tooltip and the violation notice modal. Lookups are cached for 15 minutes and throttled to stay under the API's 30 requests/minute limit, so a fresh forum view fills in gradually.

The violation notice modal pre-fills the faction name from the title, with fonts, emoji, region tags like `[EU]`, and taglines like "| Now Recruiting" stripped. It then searches #faction-discussion once for prior warnings. Edit the name and press "Search again" to search for something else.

Tint priority is: duplicate > violation > unique. FD records never change the tint; they add an outline and badge on top of it. The violation badge and tooltip still appear on duplicate posts. Each rule can be toggled in plugin settings, and the C2-11 signal threshold is adjustable (higher = fewer false positives). These are heuristics meant to aid manual review, not verdicts.

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
