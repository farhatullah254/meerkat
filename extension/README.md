# Meerkat Live — Chrome overlay

Floating live concurrent-viewer cards in the corner of every Chrome tab, read from
the local Meerkat dashboard. Nothing to change in Meerkat itself.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `extension` folder

Chrome keeps it loaded across restarts. Reloading after a code change is the
circular-arrow button on the extension's card.

## How it works

- The service worker reads `http://localhost:3000/api/state` — the same endpoint
  the dashboard uses — and caches it for 20s, so one fetch serves every open tab.
- Each tab polls that cache every 15s and paints a shadow-DOM overlay, isolated
  from the page's own CSS.
- The container is `pointer-events: none`; only the cards themselves are
  clickable, so the overlay can never swallow a click meant for the page.
- Clicking a card opens Meerkat.

## Behaviour

- Hidden entirely when nobody is online, and when Meerkat is not running.
- Sites are ranked by active users, highest first, capped at **Max cards**.
- Resting opacity is 0.72; hovering the stack brings it to full.
- The network figure comes from Meerkat's own `totals.activeNow`, not re-summed
  here, so it always matches the dashboard.

## Settings

Click the toolbar icon. Everything saves as you type and applies on the next tab
poll (within ~15s), no reload needed.

| Setting | Default |
|---|---|
| Corner | Bottom right |
| Max cards | 5 |
| Resting opacity | 0.72 |
| Meerkat URL | `http://localhost:3000` |

**Blocklist** — hidden on the listed domains and their subdomains. Ships with
email, banking and password-manager domains; `localhost` is always excluded.

Changing **Meerkat URL** to a different port also needs that origin added to
`host_permissions` in `manifest.json`, then a reload of the extension.
