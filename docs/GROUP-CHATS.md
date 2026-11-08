# Group chats

Several agents in one chat, each with its own account, model and effort: group rooms are folded into chats. Every
room that isn't a chat with one agent is a group chat now, so the multi-agent rooms from before open in the chat
screen with everything they had.

## Data

- `rooms.group_chat` (hub/src/db.ts): set for group chats. Kept on the room, not in `chats`, so an older hub opening the
  database still sees rooms there (and never takes them for one-agent chats it would sync with the Mac's apps).
  `Store.foldRooms()` runs on every open: a room with no `chats` row becomes a group chat. Tested on 0.5-era and
  0.2-era databases (hub/test/group-chats-migration.test.ts).
- `Room.chat` for a group chat is `{ provider: <the lead's kind>, origin: "web", group: true }` (`ChatInfo.group`):
  every `room.chat` path (rewind, Try again, Send now, Ask others, pins, search) applies; one-agent-only paths check
  `!room.chat.group` (Mac session sync, the teamwork helper, messages from other chats' agents).
- Who answers a message that @mentions nobody is `Room.mode`: `direct` the lead (`leadMemberId`, else the first agent),
  `roundrobin` everyone in turn, the lead first (`turnOrder` in shared), `review` Build & review. Old lead and relay
  rooms work like `direct`; round-robin isn't folded into `direct` any more.

## Hub

- `POST /api/chats/group` (`Chats.createGroup`): 2 to 6 agents (`GROUP_MIN`/`GROUP_MAX`), Claude Code or Codex, each
  with its settings or Settings → Defaults; handles from the name given, else the account's name, else the agent's own
  (`Chats.groupHandle`, also used when an agent joins later). `POST /api/rooms` makes a group chat too.
- Turns (engine.ts): group chats get the room-style briefing (`buildSystemNote`, group wording) and labelled digest
  (`buildTurnPrompt`), with `messageIds` for rewinds. Drivers get `DriverContext.chat.group`: the room tools (pre-allowed:
  they only reach that chat) and a group system prompt; Codex keeps a private app-server for them.
- Edit and unsend (`reviseGroupMessage`): each agent that read the message goes back to before the turn that brought it
  (its driver's `msgRefs`); the chat goes back to just before the message, never further, and an agent re-reads what it
  forgot from before it. An agent that read it before rewinds existed says to start it fresh.
- Try again (`POST /api/rooms/:id/retry {memberId}`) is that agent's: what of yours for it that it hasn't read, else its
  failed reply again with the note to carry on (never a message for another agent). Answer now (no `memberId`) sends your
  newest message to whoever it's for that hasn't read it, else tries the reply that failed last again.
- Send now and Read it now (`/send-now`, `/read-now`, both `{memberId}`) go into that agent's running reply (two can work
  at once with parallel work); Send now labels the messages as in its turns, and one for other agents says they answer it.
  While an agent's helpers work, a message for it goes on by itself, with no bar or button, unless Settings → "Keep going while
  helpers work" is off (Send now), and what
  still holds one agent's message (an account switch, say) doesn't hold the next agent's. With everyone in turn or Build &
  review it goes as a turn when the reply ends, and agents are told to let helpers finish before a reply hands the work on.
  Each agent's status line has its own Stop (`/stop {memberId}`); the button under the box stops them all.
- A reply that fails gives your message back as unread only when its agent says when it has a message (`sink.taken`:
  Claude Code and Codex). Another kind in a group chat (a room's Gemini) may have done some of it: the message stays read.
  Such an agent can't go back either: edit and unsend say to start it fresh first.
- An agent may switch its helpers' model at once only when you asked it (`Engine.humanWordsFor` counts only your messages
  for that agent: an @mention of it, @all, or none when it answers those); otherwise it asks with a card.
- Ask others offers whoever isn't in the chat; Duplicate copies a group chat with the same agents (`{ group: true }`, each
  forks its own conversation or gets a handoff note) or to one agent anywhere (a handoff); Markdown export and search name
  each agent (`@handle`); other chats' agents can read a group chat, not message it. In a copy each agent has read what it
  had read in the original (an agent behind, or one that never spoke, reads the rest on its next turn; a Codex fork ends
  at its last finished reply); one with a handoff note has read it all.
- After an edit or unsend, an agent that went back reads again from its own reply before the message (`Store.lastReplySeq`),
  and replies it was still owed stay owed.

## Web

- `web/src/groupChat.ts` (pure, groupChat.test.ts): `whoAnswers`, `answersLine`, `sendLabel`/`sendName`, `workQueue`,
  `notAnswered` (Answer now, "Not answered by @codex": another agent's reply after your message doesn't answer it),
  `retriedTurns` (a failed reply is answered only by a later reply of the same agent), `suggestHandles`. Views:
  `NewGroupDialog` (New chat → Group chat, and Home), `GroupSettings` (who answers, lead, review rounds, parallel work,
  agents through `AgentDialog`, reachability, pin, duplicate, export, delete twice), `GroupAvatar`; `ChatScreen`,
  `Composer`, `ChatControls` (an agent picker), `WorkingPanel` (`GroupStatus`: a line and a Stop per agent at work),
  `ChatSidebar` (a Group chats section), `DuplicateDialog` (These agents) handle `room.chat.group`.
- In a group chat `@name` means that agent answers (the @ popup lists the chat's agents and @all); the line above the box
  says who answers and in what order, and Send reads "Send to @codex". Ask others is in a message's actions.
- `RoomView` stays only for rooms on hubs from before group chats.

## Older apps (for the release notes)

- The native apps bundle their own web build. One from before group chats opens a group chat (every former room, after
  the hub folds them) in its one-agent chat screen: its controls change the lead only, it has no agents panel, and a
  draft naming another agent becomes an Ask others question instead of a message for that agent. Update the apps with
  the hub. The hub can't tell them apart: only `/api/ws` and history carry the app's protocol version (`?v=`), not
  `/api/state` or the other calls that return a room, so it can't hide `chat.group` from them.
