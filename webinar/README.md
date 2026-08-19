# Webinar registration + Zoom embed

Two files. Paste one into the page, run the other on the server.

| File | Where it goes |
|---|---|
| `registration-embed.html` | pasted into the masterclass page body |
| `server-example.js` | runs on the Kotak box, next to Strapi |

No n8n, no Make.com, no third-party form service.

---

## 1. Put the block on the page

Open the page HTML:

```
https://www.kotakneo.com/uploads/Option_Trading_Live_Masterclass_6ccd7c88f5.html
```

Find the **Register Now** section and paste the whole contents of
`registration-embed.html` where the form should appear.

It is self-contained: its own `<style>`, its own `<script>`, no libraries, no
network calls except to your endpoint and to Zoom. Every CSS rule is scoped
under `.knw`, so it cannot collide with the page's existing styles.

It uses HTML entities instead of literal `–` `·` `…` characters, so it renders
correctly no matter what charset the host page declares.

## 2. Run the endpoint

```bash
export ZOOM_ACCOUNT_ID=...
export ZOOM_CLIENT_ID=...
export ZOOM_CLIENT_SECRET=...
export ZOOM_WEBINAR_ID=93315444846
node webinar/server-example.js          # listens on :8787
```

Credentials come from a **Server-to-Server OAuth** app in the Zoom App
Marketplace, with scope `webinar:write:registrant:admin`.

Proxy `/api/webinar/register` to it. Nginx:

```nginx
location /api/webinar/register {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header X-Forwarded-For $remote_addr;
}
```

If the event is a Zoom **Meeting** rather than a Webinar, change `REG_PATH` in
`server-example.js` to `/v2/meetings/${id}/registrants` and use scope
`meeting:write:admin`. Nothing else changes.

## 3. Turn the fallback off

`registration-embed.html` currently carries a hardcoded link so it works before
the endpoint exists:

```js
fallbackJoinUrl: 'https://zoom.us/j/93315444846?pwd=...',
```

**Set this to `''` before go-live.** A shared link means anyone who has the URL
joins without registering, and Zoom cannot attribute attendance to a registrant.

---

## How it behaves

1. Person fills name / email / +91 mobile, ticks consent.
2. Browser POSTs to `/api/webinar/register`.
3. Server registers them with Zoom, gets back a **join_url unique to them**.
4. Browser shows: **Join on Zoom** (opens the app), **Join in this page**
   (loads the iframe), **Add to calendar** (.ics download).
5. Zoom emails its own confirmation — this matches the page's stated
   "01 Fill The Form → 02 Get Your Joining Link by Mail → 03 Join live on Zoom".

If the endpoint is down and `fallbackJoinUrl` is set, step 3 is skipped and the
fallback link is used. If it is down and the fallback is empty, the person sees
an error and the mail-and-address to contact.

## The iframe

`/j/<id>` links bounce to the desktop app; only the web-client path renders in a
frame. `embed()` rewrites it:

```
https://zoom.us/j/93315444846?pwd=X   ->   https://zoom.us/wc/93315444846/join?pwd=X
```

The iframe carries `allow="camera; microphone; fullscreen; display-capture;
autoplay; clipboard-write"`. Without those the Zoom client loads but the person
cannot speak or turn on video, with no visible reason.

**Two things can still stop the embed, neither of them in this code:**

- The host page must not send a `Permissions-Policy` header that strips
  `camera`/`microphone`. A parent cannot delegate what it does not have.
- Corporate networks commonly block embedded video. That is why **Join on Zoom**
  stays on screen next to the frame, and why the note under it says so.

Zoom sends no `X-Frame-Options` and no CSP `frame-ancestors`, so framing itself
is not blocked. Verified with `curl -sI`.

## Validation

Same rules in both places. The browser copy is a courtesy; the server copy is the
one that counts, because anyone can POST to the endpoint directly.

| Field | Rule |
|---|---|
| Name | 2–120 chars. One word is fine — `last_name` is optional to Zoom. |
| Email | Permissive pattern. Over-strict regexes reject valid addresses. |
| Mobile | 10 digits starting 6–9. Accepts `+91`, `91`, and a leading `0`. |

Server also rate-limits to 5 posts per IP per minute so the webinar cannot be
enumerated. Swap for the reverse proxy's limiter if there is one — the built-in
map resets on restart and does not span processes.

## Checked before shipping

Chromium, 390px and 1280px, light and dark:

- Form → success → embed completes in all four combinations.
- Iframe `src` resolves to the `/wc/` form in all four.
- No horizontal overflow.
- Tap targets ≥24px (WCAG 2.2 SC 2.5.8). The inline "terms and privacy policy"
  link is 133×15 and is exempt — it sits inside a sentence.
- No console errors over `http://`.
- Server validation: 8 cases, 4 accepted, 4 rejected with the right message.

Screenshots are not committed. Reproduce with any static server:

```bash
python3 -m http.server 8099
# then open http://127.0.0.1:8099/webinar/registration-embed.html
```

## Not done here

- **Storing registrations locally.** Zoom holds them. If Kotak needs its own
  copy, write to the DB in `register()` before returning.
- **Email template.** Zoom's own confirmation mail is used as-is.
- **Reminder mails.** Zoom sends these when the webinar has them enabled.
