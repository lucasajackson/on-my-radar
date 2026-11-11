/** Copy for the radar and blip every new account starts with. */

export const WELCOME_RADAR = {
  name: 'First Radar',
  tagline: 'Anything and everything',
  description: 'Your default radar. Rename it, recolour it, or delete it once you have your own.',
} as const;

export const WELCOME_BLIP_BODY = `**This is a blip.** A blip is any thought you want out of your head and somewhere safe — a sentence, a link, a photo, a half-formed idea, a whole essay. Drop it here now, sort it out later.

### The thirty-second version

- **Capture first.** The box at the top of every radar is always focused. Type, hit ⌘/Ctrl+Enter, move on. Paste a URL on its own and it becomes a link blip with a preview. Drag in an image or a file and it becomes an attachment.
- **Tag inline.** Any \`#word\` you type in a blip becomes a tag you can filter by.
- **Triage later.** Every blip starts in **Inbox**. Move it to *Active*, *Later*, *Done* or *Dropped* when you know what it is. That's the sorting-out part.
- **Search everything.** The search box searches titles, bodies, links and tags across the radar.

### Radars are just containers

Make one per project, per obsession, per client, per anything. Give each a colour and a glyph so you can tell them apart at a glance. Move a blip between radars whenever it turns out to belong somewhere else.

### Dashboards

Your **Mission Control** dashboard starts with this radar, an **Inbox** count and an **Active work** view. The count and work view are live queries across the radars you can read; move a blip to Active to see it appear. An empty work view means you have no active blips yet.

Drag and resize widgets, edit their queries, add more radars or create a dashboard for another project. Everything here can be changed or removed.

### Sharing

Share a radar with someone by email and they get their own view of it — read-only or with edit rights, your call. Or flip a radar to **public** and it gets an unguessable link anyone can open. Public radars are read-only to the world and hidden from search engines unless you say otherwise.

### Point an AI at it

This is the good part. On My Radar speaks **MCP**, so you can connect Claude — or any MCP-capable agent — straight to your radars and say *"read my New App radar and start building what's in it."* The agent can read, search, create and re-file blips, and manage radars and sharing, using exactly the same permissions you have.

Set it up under **Settings → Connections**: create an access token and add the URL it shows you to your agent's MCP config.

---

*You can delete this blip. Nothing depends on it — it's an ordinary blip like any other.*
`;
