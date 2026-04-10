---
name: register-group
description: Register a new WhatsApp group for the agent. Use when the user asks to add/connect/register a group. Main channel only.
---

# Register a WhatsApp Group

Use this when the user asks you to add, connect, or register a WhatsApp group.

**Main-channel check:** This skill requires `/workspace/project` access. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond:
> I can only register groups from the main chat. Send this request there.

Then stop.

## Step 1: Find the group

The user will provide a group name. Search for it in the chats database:

```bash
sqlite3 /workspace/project/store/messages.db "SELECT jid, name FROM chats WHERE name LIKE '%<search_term>%'"
```

If multiple matches, ask the user which one they mean. If no match, the group hasn't been seen yet — ask the user to send a message in that group first, then try again.

Check if already registered:

```bash
sqlite3 /workspace/project/store/messages.db "SELECT jid, name FROM registered_groups WHERE jid = '<jid>'"
```

If already registered, tell the user and skip to Step 4 (check mappings).

## Step 2: Register the group

Generate a folder name from the group name (lowercase, ascii-safe, prefixed with `whatsapp_`). Examples: "סבאח אל חיר" → `whatsapp_sabach`, "Justt R&D Leaders" → `whatsapp_justt_rd`.

Insert into the database:

```bash
sqlite3 /workspace/project/store/messages.db "INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main) VALUES ('<jid>', '<name>', '<folder>', '@Evyatar|@אביתר', '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 1, 0)"
```

Create the group folder and copy the CLAUDE.md template:

```bash
mkdir -p /workspace/project/groups/<folder>/logs
cp /workspace/project/groups/global/CLAUDE.md /workspace/project/groups/<folder>/CLAUDE.md
```

## Step 3: Check LID→phone mappings

Get the known senders from this group:

```bash
sqlite3 /workspace/project/store/messages.db "SELECT DISTINCT sender, sender_name FROM messages WHERE chat_jid = '<jid>' AND sender LIKE '%@lid'"
```

Check existing mappings:

```bash
cat /workspace/project/data/contacts/lid-phone-map.json
```

Try to match new senders against the contacts file:

```bash
npx tsx /workspace/project/scripts/match-lid-phones.ts 2>/dev/null
```

Read the updated map and count how many of this group's senders are now mapped.

## Step 4: Report to user

Tell the user:
1. **Group registered** (or already was)
2. **Mapping status**: X out of Y known members are mapped
3. If all mapped: "The group is ready — you can trigger me with @אביתר there."
4. If some unmapped: "X members still need to send a message in the group before I can respond there. The daily mapping task will handle this automatically."
5. If no messages yet: "No messages from this group yet. Once members start chatting, I'll automatically map them. The daily report will keep you updated."

**Important:** After registering, the NanoClaw service needs to restart to pick up the new group. Tell the user:
> I've registered the group. It will be active after the next service restart. You can restart it now by running `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` on your Mac.
