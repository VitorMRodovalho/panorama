# Licensing FAQ

Short answers for people evaluating Panorama. For the legal text, see
[`LICENSE`](../../LICENSE) and ADR-0005.

## Is Panorama open source?

Yes. The Community edition is licensed under the
**GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**.
AGPL is OSI-approved and FSF-endorsed.

## Does the AGPL trigger when I run Panorama inside my company?

No. Running unmodified Panorama internally — even for your customers, as
long as they are your customers — does **not** require you to share code.
The AGPL's network clause kicks in only if you:

1. **Modify** the source, and
2. Make the modified version **available over a network** to users

If you modify Panorama and run it as a public SaaS, you must offer the
modified source to your users on request. If you modify Panorama and run it
for internal use only, you do not.

## Can I build a proprietary product on top of Panorama?

If your product bundles Panorama's code, your bundle has to ship under AGPL
too. If your product talks to Panorama over a network API, your product is
yours. Plugins installed into Panorama count as bundling.

## What about the Enterprise edition?

Enterprise modules live in a separate private repository under a
**commercial licence**. You can use them only if you have a valid
subscription. Enterprise depends on the Community codebase as a published
artefact; it does not copy Community code.

## Can I remove the "Powered by Panorama" notice?

In Community: yes. Community has no mandatory branding.

In Enterprise with white-label: yes. White-label is the whole point.

In the default Enterprise without white-label: the footer notice stays. It's
a small concession and it's not in Community so it doesn't affect anyone who
prefers pure OSS.

## Can I fork Panorama and rename it?

Yes, subject to the [trademark policy](./trademark.md). You can fork the
code under AGPL; you can't call your fork "Panorama" in a way that implies
endorsement. "Based on Panorama" phrasing is fine.

## What if I find Panorama's code in a commercial product?

If that product doesn't offer source code access to its users (under AGPL
rules), that's a licence violation. Please open an issue with details. We
take compliance seriously.

## I'm in procurement and your licence is flagged — what do I do?

AGPL often gets red-flagged by automated scans because it's mistaken for
requiring source release of all company code. That's incorrect for internal
use. Point your team at this page, and if you need, email
legal@vitormr.dev for a written statement.
