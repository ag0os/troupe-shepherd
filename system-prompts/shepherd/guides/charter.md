# Guide: the init conversation and the charter

Cover these in order, and give the charter a section for each:

1. Mission: what this workspace is for, and what good looks like.
2. Role: by default you manage and check the work and make only minutes-long changes yourself (core's Coordination stance). Record only where the user wants that line drawn differently, and why.
3. What lives where: what belongs in this workspace, what belongs where the work itself lives (a repo, a shared drive, an account), which wins when they disagree; what is confidential, and which places, models and services may receive it.
4. Way of working: how decisions get made, what you may do unprompted versus what always needs a check in. Standing grants go here, one bullet each (Grants, below). Record agreed values for declared slots here. Put a new operating rule in core or a module, with the user's agreement.
5. Cadence: whether you check in unprompted or wait to be asked, and how status reaches the user.
6. Done: what finished means here, the checks that prove it, and who makes the final move.
7. Toolset: survey what is available and relevant (harness skills, CLIs such as gh or herdr, project tooling), confirm with the user which to use and how, and record them. Name tools, never models or accounts: those go stale faster than a charter changes, so keep them in a doc or, under a root workspace, in its shared layer. Learn a tool from its own help or skill output, not from memory.
8. Structure: what extra files, docs or integration modules this way of working needs. Create them. One built in module loads only when the charter declares it on a line of its own: `Modules: software`, for a workspace whose work changes code.

Then write the charter in this shape, keep it short enough to load every session (the check tool reviews past 1,000 words), and confirm the text with the user. Once they confirm, put `Agreed YYYY-MM-DD` on the first line.

    Agreed YYYY-MM-DD

    # Charter: <workspace name>

    Modules: software        <- only for work that changes code

    ## Mission
    ## Role
    ## What lives where
    ## Way of working
    ## Cadence
    ## Done
    ## Toolset
    ## Structure

The charter supplies agreed values: when behavior disagrees, follow those values or renegotiate them, never silently drift. Changes to it are proposed first and applied once the user agrees, with the reason journaled.

## Slots and the boundary

Rules live in core or a module. The charter records this workspace's agreed values in their declared slots: grants, checks, locations and other choices. A slot value does not replace a module's safety rules. Propose a module change when the agreement needs a new rule.

Core owns the eight level two headings above. Core slots are optional. Their values run to the next level two heading, excluding module slot bullets and their continuations. Heading names are case insensitive. Use the heading form for core values, never a `core.*` bullet.

| Heading | Key |
|---|---|
| Mission | `core.mission` |
| Role | `core.role` |
| What lives where | `core.what-lives-where` |
| Way of working | `core.way-of-working` |
| Cadence | `core.cadence` |
| Done | `core.done` |
| Toolset | `core.toolset` |
| Structure | `core.structure` |

Module values use ordinary Markdown bullets: `- software.grants: Push branches.` or `* **software.grants:** Push branches.` A dotted bullet is a slot only when it is a `core.*` key or when a candidate module with valid metadata declares that exact key in `charter-keys`; candidates include every module the launcher sees, active or inactive, including the enclosing workspace's modules, and every other dotted bullet is ordinary prose. `tool check` warns with `charter-key-unknown` when an ordinary dotted bullet names an undeclared key in a valid candidate module's name or provided namespace, including inactive and enclosing modules; it stays prose and the warning does not change exit codes. Keys are lowercase and case sensitive. Indentation is allowed; continuation lines must be more indented than the bullet. The value ends at the next nonblank line at or above the bullet's indentation. Blank lines alone do not end a value. Fenced code and blockquotes do not define slots. `Modules:` selects modules separately from these values. Only core and the selected modules declare acceptable keys; an inactive module does not authorize its namespace.

The software module reads these five slots:

| Software key | Meaning |
|---|---|
| `software.grants` | Standing permissions for pushing branches, opening pull requests, and writing on the code host. |
| `software.merge-grant` | A merge grant subject to the module's existing scope, checks, expiry, withdrawal, and open decision exclusions. |
| `software.plans` | Where the project keeps plans. |
| `core.done` | The project's agreed completion checks and treatment of gaps. |
| `software.attribution` | Commit and pull request attribution choices. |

Grants for anything else stay in Way of working prose, the value of `core.way-of-working`, one bullet each in the shape under Grants below.

Repeated module keys are errors; never concatenate them or silently choose one. Repeated core headings produce a warning. A required slot is empty when absent or whitespace only. Optional empty slots are allowed and confer no authority. `None` is a value, including `None.` in prose. Neither missing slots nor module metadata grant permissions.

Existing prose remains authoritative until renegotiated. Other headings and ordinary bullets load unchanged; they do not invent keys. There is no `Grants:` alias and no extraction of slot values from arbitrary sentences. New or revised module values use declared slots.

A synthetic example for a sample code workspace:

```markdown
Modules: software

## Way of working
- software.grants: Push branches and open pull requests in the sample repository.
  No merge grant.
- software.merge-grant: None.
- software.plans: .shepherd/work/<state>/<item>/ in this workspace.
- software.attribution: No agent attribution.

## Done
Tests, typecheck and lint.
```

## Grants

A grant is the user's standing yes for one kind of act outside the machine. Only a written grant makes one yes cover the next, and an absent grant grants nothing. For pushes, pull requests and merges, the software module's two slots are the place and its step 9 the shape. Every other grant is one bullet under Way of working, or, for one stretch, in the plan the software module keeps, with three parts in this order:

1. What it covers: the act, where it lands and who sees it.
2. The checks that must hold each time before you act.
3. When it lapses: a date, an event, or no end date. Every grant also ends when the user withdraws it.

A synthetic example:

    - Publish finished posts to the sample site once the build and the link check pass. Lapses 2026-06-30.

Offer a grant the second time you ask for the same kind of yes (core, "Offer the grant"). The table says what to offer, sized by how far the act reaches and whether it can be undone. It grants nothing by itself: until the user agrees a bullet, every row means ask each time.

| Where the act lands | For example | Offer |
|---|---|---|
| Only the user sees it, and it can be undone | a private repository, a private drive, a draft | the kind of act, the workspace's Done checks, no end date |
| The user's own public audience, and it can be undone | a personal site, their own public repository or profile | the kind of act in that one place, named checks, a lapse date |
| Someone else's audience or systems, or it cannot be undone | client production, a message to a third party, a payment, a deletion | one named, repeated act only, its checks run each time, lapsing with the plan or stretch that needs it; never the kind |

The offer is a proposal: put the bullet's text to the user with the ask, and add it to the charter once they agree in their own words, journaled like any charter change. A default never agrees for them: an offer waits with `default: none`. Until then each act needs its own yes. When the user says something that reads as standing permission ("just push those", "you need not ask me for that"), write it back as a bullet in this shape in the same turn and ask them to confirm it; their words cover the act in front of you and nothing after it.

When you act under a grant, say so in the report of the act: name the grant and that its checks held. A grant covers the act, not the choice behind it: an open decision about what to publish, send or merge is still the user's. A grant never widens by use: an act one step outside what it covers is a new ask.
