# Better Intra Worker

Backend 'cloud' worker for Better Intra extension, managing user synchronization and persistence via Cloudflare KV and D1.
Automated deployment through GitHub Actions.

## Setup

```bash
npm install
npx wrangler secret put ANNOUNCEMENT_SECRET   # required for the announcement endpoint
npx wrangler dev                               # local dev
npx wrangler deploy --remote                   # deploy
```

## Announcement endpoint

Broadcasts a notice banner to Better Intra users on profile pages (set manually when intra is broken).

### Set a message

```bash
curl -X POST https://api.betterintra.com/api/v1/public/announcement \
  -H "Content-Type: application/json" \
  -d '{"secret":"YOUR_SECRET","message":"Intra is currently broken — profiles may fail to load."}'
```

Optional `level` controls banner intensity (defaults to `critical`):
- `info` — blue, low visibility
- `warning` — amber
- `critical` — red, highest visibility

```bash
curl -X POST https://api.betterintra.com/api/v1/public/announcement \
  -H "Content-Type: application/json" \
  -d '{"secret":"YOUR_SECRET","message":"Maintenance window tonight.","level":"info"}'
```

Message is trimmed and capped at 500 chars. An empty message removes the banner.

### Add links to the banner

Pass an optional `links` array (up to 5, only `http(s)` URLs allowed):

```bash
curl -X POST https://api.betterintra.com/api/v1/public/announcement \
  -H "Content-Type: application/json" \
  -d '{
    "secret":"YOUR_SECRET",
    "message":"Intra is currently broken.",
    "level":"critical",
    "links":[
      {"text":"Switch to v2","url":"https://profile.intra.42.fr"},
      {"text":"Check status","url":"https://status.intra.42.fr"}
    ]
  }'
```

### Clear the message

```bash
curl -X DELETE "https://api.betterintra.com/api/v1/public/announcement?secret=YOUR_SECRET"
```

### Read (public, used by the extension)

```bash
curl https://api.betterintra.com/api/v1/public/announcement
# => {"message": "...", "updatedAt": 1710000000000, "level": "critical", "links": [{"text":"...","url":"..."}]}
```
