# Campfire Meetup Tracker (Chrome extension)

Replaces the paste-into-devtools workflow of `campfire-checkin-scraper.js` with a panel on campfire.scopely.com.

## Install

1. Go to `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick this `extension` folder.
3. Open https://campfire.scopely.com (logged in). A 🔥 button appears bottom-right; the toolbar icon also toggles the panel.

## Use

1. **Collect events**: browse Campfire normally (club/group pages, your meetups list, individual meetups).
   Every event in Campfire's own GraphQL responses is added to the list, with no setup needed.
   The list queries that returned events are saved as *sources*; next time, **↻ Refresh events** re-runs them
   so you don't have to browse again. You can also paste meetup URLs/IDs with **+ Add by URL**.
2. **Pick events**: filter by text, group, or date range, then tick the ones you want ("Select shown" grabs all filtered).
3. **Fetch attendance**: runs `GetEvent` for each selected meetup (skips ones already loaded; "Re-fetch all" updates them).
   Opening a meetup page in Campfire also caches its attendance automatically.
4. **Results tab**: per-event totals plus a per-person table (times checked in / RSVP only across the selection).
   Export:
   - **Summary CSV**: one row per event
   - **Attendance CSV**: one row per person per event (long format, good for pivot tables)
   - **Attendee matrix CSV**: one row per person, one column per event
   - **Copy** buttons put tab-separated data on the clipboard to paste into Sheets

Everything is stored in `chrome.storage.local` in this browser only. Clear it from the Sources tab.

## Views

- **⛶ Full screen** expands the panel over the whole page (remembered); **↗ New tab** opens
  `campfire.scopely.com/#cf-tracker`, which auto-opens the tracker full-screen in its own tab.

## Troubleshooting

- After editing/reloading the extension, **refresh the Campfire tab** too, or requests will time out.
- **Logs tab**: every request the tracker makes, with each attempt (endpoint, credentials mode, headers
  with secrets redacted, HTTP status, response snippet). Use **Test connection** for a tiny `me` query and
  **Copy logs** to share them. Events whose fetch failed show a red **failed** pill that links here.
- The tracker copies the endpoint, headers, and credentials mode from Campfire's own GraphQL calls, so let the
  page finish loading before fetching. If it still fails, it falls back to cookies only, then headers without cookies.
- `Failed to fetch` is a network/CORS block; the browser hides the reason from scripts, but the DevTools
  console shows a red CORS line explaining it.

## Notes / limits

- Requests run in the page context with your Campfire session, the same as the old console script.
- Sources replay the exact variables they were captured with. If a list is paginated, only the pages you
  actually scrolled through are captured. Scroll further and those pages get saved too.
- Campfire returns at most 50 attendee names per event; check-in and RSVP counts are always complete (unnamed attendees show as "(unknown)").
