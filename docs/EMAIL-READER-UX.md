# Email cards and reader

Received email uses one shared source card across every radar template, public
radars, search results, and both dashboard widget types. It shows the blip's label
(or original subject), sender, received time, a two-line preview, and a count of
actual file attachments. Embedded message images do not become photo galleries
or count as downloadable files. Search cards use the matching text excerpt.
The subject and Read email open the same reader without navigating away.

The reader is a wide desktop dialog and a full-screen mobile surface. Message
shows the sanitized original formatting; Text shows the original readable text.
Older captures whose formatted source was never stored say so explicitly. The
reader fetches full content only when opened and does not retain it after closing.
Failed reads offer retry; loss of access never becomes an empty email.

The received message is immutable. Editing the blip changes its display label and
separate notes, while preserving the original text for search and agents. Notes
are labeled independently on the card and in the reader. Existing radar lanes,
triage, reactions, comments, and themed surroundings retain their normal roles.
Moving an email to another radar changes its context, not its original content.

Formatted content lives inside a sandboxed iframe with no scripts, same-origin
privilege, forms, or embedded frames. A deny-by-default document CSP permits only
trusted stored-image origins initially; inline formatting is allowed without
exposing the application DOM. Remote HTTPS images require the explicit Load
remote images action on this particular reader view, accompanied by a tracking
explanation. Links open separately without a referrer. Public reader responses
use the public radar permission path and omit envelope addresses and the original
message download; the UI does not reconstruct those fields.

Controls remain outside the message's own scrolling surface. The reader uses the
shared modal background isolation and focus restoration. Message/Text tabs support
arrow keys, and Close email remains available below the content as well as the
header Close control. A sandboxed document owns keyboard events while focus is
inside it, so iframe links remain natively keyboard navigable without injecting
scripts to intercept them. The Text view provides a straightforward reading
alternative. Attachments and notes expand separately from the message.

Regression coverage verifies lazy loading, explicit remote-image consent, CSP and
sandbox boundaries, public detail routing, truthful legacy fallback, focus return,
and notes updates that never send a replacement original body. Browser integration
covers phone and desktop views and observes network requests before image consent.
