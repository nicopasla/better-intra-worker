# Evaluations — Testing

## Get your hash

```bash
node -e "const crypto = require('crypto'); console.log(crypto.createHash('sha256').update('yourlogin'.toLowerCase().trim()).digest('hex'))"
```

---

## Register for evaluations

The extension auto-registers on install. To verify:

```bash
npx wrangler d1 execute better-intra-d1 --remote --command="SELECT * FROM eval_users WHERE hash = '<YOUR_HASH>'"
```

To manually register / unregister (simulates extension):

```bash
npx wrangler d1 execute better-intra-d1 --remote --command="INSERT OR IGNORE INTO eval_users (hash) VALUES ('<YOUR_HASH>')"
npx wrangler d1 execute better-intra-d1 --remote --command="DELETE FROM eval_users WHERE hash = '<YOUR_HASH>'"
```

---

## Manual notification test

Create `test-notif.sql`:

```sql
-- booked: roles are hidden, just project + time
INSERT INTO pending_notifs (hash, eval_id, role, data)
VALUES ('<YOUR_HASH>', 1, 'evaluator',
'{"type":"booked","role":"evaluator","id":1,"projectName":"Libft","beginAt":"2026-06-14T15:00:00.000Z","endAt":"2026-06-14T15:15:00.000Z","teamName":null}');

-- revealed: names are visible (15min before)
INSERT INTO pending_notifs (hash, eval_id, role, data)
VALUES ('<YOUR_HASH>', 2, 'evaluator',
'{"type":"revealed","role":"evaluator","id":2,"projectName":"Libft","beginAt":"2026-06-14T15:00:00.000Z","endAt":"2026-06-14T15:15:00.000Z","logins":"elmo","teamName":null}');
```

Run:

```bash
npx wrangler d1 execute better-intra-d1 --remote --file=test-notif.sql
```

Wait up to 5 min for the extension to poll. You'll get two Chrome notifications:

1. "Evaluation booked — Evaluation for Libft at 15:00"
2. "Evaluation — You're correcting elmo for Libft at 15:00"

---

## "evaluated" role (being corrected)

Same structure, different `role` and response fields:

```sql
-- booked: someone booked you, name hidden
INSERT INTO pending_notifs (hash, eval_id, role, data)
VALUES ('<YOUR_HASH>', 3, 'evaluated',
'{"type":"booked","role":"evaluated","id":3,"projectName":"Minishell","beginAt":"2026-06-14T16:00:00.000Z","endAt":"2026-06-14T16:15:00.000Z","teamName":null}');

-- revealed: evaluator's name appears
INSERT INTO pending_notifs (hash, eval_id, role, data)
VALUES ('<YOUR_HASH>', 4, 'evaluated',
'{"type":"revealed","role":"evaluated","id":4,"projectName":"Minishell","beginAt":"2026-06-14T16:00:00.000Z","endAt":"2026-06-14T16:15:00.000Z","login":"elmo","teamName":null}');
```

Expected Chrome notifications:

1. "Evaluation booked — Minishell will be evaluated at 16:00"
2. "Evaluation — elmo is about to evaluate Minishell at 16:00"

---

## Notification field reference

| Field | "booked" | "revealed" | Notes |
|---|---|---|---|
| `type` | `"booked"` | `"revealed"` | Required |
| `role` | `"evaluator"` | `"evaluator"` | `"evaluated"` for being corrected |
| `id` | scale_team id | scale_team id | Int, unique per eval per role per user |
| `projectName` | string or null | string or null | Displayed in notification |
| `beginAt` | ISO string | ISO string | Parsed for HH:MM in notification |
| `endAt` | ISO string | ISO string | Not displayed, used internally |
| `teamName` | string or null | string or null | Not displayed currently |
| `logins` | — | string | **evaluator** role: comma-separated corrected logins |
| `login` | — | string | **evaluated** role: single evaluator login |

---

## Notification preference toggles

These `chrome.storage.local` keys control which notifs show (all default `true`):

| Key | Suppressed when `false` |
|---|---|
| `EVALUATIONS_NOTIFY_AS_EVALUATOR` | Skips all notifs with `role: "evaluator"` |
| `EVALUATIONS_NOTIFY_AS_EVALUATED` | Skips all notifs with `role: "evaluated"` |
| `EVALUATIONS_NOTIFY_REVEAL` | Skips all notifs with `type: "revealed"` |

To test suppression: open the Better Intra popup, go to the Evaluations tab, toggle one off, then re-insert a matching notif. It should be silently consumed (marked `consumed = 1`) without a Chrome notification.

---

## Duplicate prevention

`pending_notifs` has `PRIMARY KEY (hash, eval_id, role)`. `INSERT OR IGNORE` blocks duplicates:

```sql
-- Insert the same row twice
INSERT INTO pending_notifs (hash, eval_id, role, data)
VALUES ('<YOUR_HASH>', 99, 'evaluator',
'{"type":"booked","role":"evaluator","id":99,"projectName":"DedupTest","beginAt":"2026-06-14T17:00:00.000Z","endAt":"2026-06-14T17:15:00.000Z","teamName":null}');

-- This is silently ignored (no error, no insert)
INSERT INTO pending_notifs (hash, eval_id, role, data)
VALUES ('<YOUR_HASH>', 99, 'evaluator',
'{"type":"booked","role":"evaluator","id":99,"projectName":"DedupTest","beginAt":"2026-06-14T17:00:00.000Z","endAt":"2026-06-14T17:15:00.000Z","teamName":null}');

-- Verify only 1 row stored
SELECT hash, eval_id, role FROM pending_notifs WHERE eval_id = 99;
```

The same constraint protects `eval_states` — no duplicate state transitions.

---

## Full flow simulation (booked → revealed)

Simulate what the cron does for a real eval lifecycle:

```sql
-- Step 1: cron detects new booked eval, writes state + pending
INSERT INTO eval_states (hash, eval_id, role, state)
VALUES ('<YOUR_HASH>', 100, 'evaluator', 'booked');

INSERT INTO pending_notifs (hash, eval_id, role, data)
VALUES ('<YOUR_HASH>', 100, 'evaluator',
'{"type":"booked","role":"evaluator","id":100,"projectName":"ft_irc","beginAt":"2026-06-14T18:00:00.000Z","endAt":"2026-06-14T18:30:00.000Z","teamName":null}');

-- Step 2: cron detects names revealed (15min before), updates state, inserts new notif
UPDATE eval_states SET state = 'revealed', updated_at = unixepoch()
WHERE hash = '<YOUR_HASH>' AND eval_id = 100 AND role = 'evaluator';

INSERT INTO pending_notifs (hash, eval_id, role, data)
VALUES ('<YOUR_HASH>', 100, 'evaluator',
'{"type":"revealed","role":"evaluator","id":100,"projectName":"ft_irc","beginAt":"2026-06-14T18:00:00.000Z","endAt":"2026-06-14T18:30:00.000Z","logins":"elmo,kermit","teamName":"IRC"}');

-- Verify both states exist
SELECT hash, eval_id, role, state, updated_at FROM eval_states WHERE eval_id = 100;
```

---

## Debug queries

```bash
# All registered eval users
npx wrangler d1 execute better-intra-d1 --remote --command="SELECT hash, datetime(created_at, 'unixepoch') FROM eval_users"

# All eval states ever recorded
npx wrangler d1 execute better-intra-d1 --remote --command="SELECT hash, eval_id, role, state, datetime(updated_at, 'unixepoch') FROM eval_states ORDER BY updated_at DESC"

# All pending notifs (not yet consumed by extension)
npx wrangler d1 execute better-intra-d1 --remote --command="SELECT hash, eval_id, role, consumed, datetime(created_at, 'unixepoch') FROM pending_notifs WHERE consumed = 0"

# All notifs including consumed
npx wrangler d1 execute better-intra-d1 --remote --command="SELECT hash, eval_id, role, consumed, datetime(created_at, 'unixepoch') FROM pending_notifs ORDER BY created_at DESC"

# Counts per table
npx wrangler d1 execute better-intra-d1 --remote --command="SELECT 'eval_users' AS tbl, COUNT(*) FROM eval_users UNION ALL SELECT 'eval_states', COUNT(*) FROM eval_states UNION ALL SELECT 'pending_notifs', COUNT(*) FROM pending_notifs"
```

---

## Cleanup

```bash
# Delete all test data for a specific hash
npx wrangler d1 execute better-intra-d1 --remote --command="DELETE FROM pending_notifs WHERE hash = '<YOUR_HASH>'"
npx wrangler d1 execute better-intra-d1 --remote --command="DELETE FROM eval_states WHERE hash = '<YOUR_HASH>'"
npx wrangler d1 execute better-intra-d1 --remote --command="DELETE FROM eval_users WHERE hash = '<YOUR_HASH>'"

# Reset everything (destructive — wipes all eval data for all users)
npx wrangler d1 execute better-intra-d1 --remote --command="DELETE FROM pending_notifs"
npx wrangler d1 execute better-intra-d1 --remote --command="DELETE FROM eval_states"
npx wrangler d1 execute better-intra-d1 --remote --command="DELETE FROM eval_users"
```
