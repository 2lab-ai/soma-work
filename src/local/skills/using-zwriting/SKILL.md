---
name: using-zwriting
description: "Use when writing or rewriting anything a person will read — an answer, report, summary, PR or issue body, doc, research write-up, incident note, plan — or when asked to explain, simplify, structure or tidy up a text. Triggers: 'using-zwriting', 'zwriting', '쉽게 설명해줘', '풀어서 설명', '구조화해줘', '정리해줘', 'eli5', 'plain english', 'govuk style'. Not for code, config, logs or machine-read payloads."
---

# using-zwriting — write so a person understands it on the first read

## In short

Every explanation is a ladder. The top rung is one line a smart outsider understands. Each rung below adds detail in its own words. The bottom rung keeps every fact. The reader stops at the rung that answers them, and wherever they stop, what they read is true.

This skill replaces using-govuk, using-eli5, using-ha-thinking and structurize. Their rules live on here, merged and corrected.

## The rules

Everything below is the full version of this skill. Load the references when you reach the step that names them:

- `references/plain-language.md` — sentence rules: English (GOV.UK A to Z) and Korean
- `references/structure-engine.md` — restructuring someone else's text without losing anything
- `references/renderers.md` — tree, collapsible HTML, Mermaid and table templates

## The contract

1. Always a ladder, never one flat layer. At least 2 rungs: one line, then the detail. A long document adds a map; its sections may open with their own one line.
2. Top first. Conclusion before evidence, evidence before background — in the document, each section, each paragraph.
3. Each rung closes in its own words. A sentence on one rung uses no term from the rung below it. File paths, function names, environment variables and jargon appear first on the rung that explains or uses them.
4. Every rung is true at its depth. A reader who stops anywhere believes nothing false. A simpler rung is a smaller view of the same claim, not a softer or different one.
5. Nothing is lost. The bottom rung keeps every number, name, condition, caveat and failure mode of the source.
6. Say each fact in full once. The detail states it; an upper rung names only what the reader must know to act, in fewer words, and does not copy the detail. A rung that repeats the one below is a wasted rung.
7. Nothing is added. No fact that is not in the source or your own evidence, and no placeholder link.
8. Plain sentences on every rung (`references/plain-language.md`).

Nothing is exempt for looking easy. When the content is already plain, the top rung shrinks to one sentence. It never disappears.

## The rungs

**One line.** What it is, why it matters to this reader, what happens next — in that order, in at most 2 sentences. It carries what the reader must do and any warning that could hurt them if missed. Keep the number that carries the point: "6 tries in 15 minutes" beats "a few tries". Write for a clever outsider, not a child: no baby talk, and do not open with "basically", "simply" or "just". Name the concrete thing: the service that breaks, the person who waits.

**The map.** Only for a long document — about 4 sections or more. The whole structure in plain words, before any detail: a short tree, or 3 to 7 bullets. Each node is a summary of its content ("the fix needs a restart"), not a label ("fix"). End with a reading guide: which part to read for which question. A map node uses no term from the detail rung.

**The detail.** Full precision, ordered conclusion → evidence → background. An expert who skipped the top rungs still gets everything. A section's opening line is its first sentence — never a separate summary followed by the same facts again.

How many rungs: ask how many times the idea must be split before it can be acted on. Fewer is cheaper — add a rung only when a rung would otherwise mix "why" and "how". Never fix the count in advance, and never label rungs with numbers like L1 or L7.

Caps: one line ≤ 2 sentences; a map ≤ 7 nodes per level and ≤ 150 words. If a top rung will not fit, you are explaining 2 things: split them and give each its own ladder. A rewrite stays within about 1.2 times the length of its source (the note for the writer not counted); when it runs longer, cut repetition first.

Label the top rung so the reader can stop there: "In short:" in English, "요약:" in Korean. Below it, use headings that name their content — no "Map", "Detail", "구조" or "자세히" labels in a document meant for its readers.

**One analogy, at most.** Allowed only on the top rung, and only when it maps onto the real mechanism part for part, is stated as an analogy ("this works like knocking on a door"), and the mechanism it stands for appears literally in the detail. Outside that, no metaphors.

## Building the ladder

1. **Reader and need.** Who reads this, and what do they decide or do after reading? Write for that reader. Explain a necessary term or acronym the first time it appears, for them.
2. **Structure first.** Decide what kind of thing it is — explanation (cause), argument (claim and grounds), comparison (criteria), process (steps), classification (parts) — and let that pick the skeleton. When the input is someone else's text to reorganise, run `references/structure-engine.md` before writing a word.
3. **Hierarchy.** A parent summarises its children. Siblings are the same kind (all reasons, or all steps), do not overlap, and leave nothing out. 3 siblings is about right; more than 7 needs a middle rung.
4. **Write top-down.** One line, then the map, then each section. Each rung in its own vocabulary.
5. **Sentences.** Apply `references/plain-language.md` on every rung.
6. **Render last.** Pick the format from the structure and the medium — chat, document, Slack, HTML (`references/renderers.md`). Never pick the format first and bend the structure to fit it.

## Faithful to the source

- Do not guess at gaps. If the source is vague, contradicts itself, or leaves out who acts, where to send something or when a period starts, never smooth it over, fill it in, or pick one side silently.
- Keep the reader's text clean and the gaps visible. When you rewrite someone else's text for their readers, list every gap and contradiction once, in a note for the writer after the text ("For the writer — not stated in the source: …" / "작성자 확인 — 원문에 없음: …"). Inside the reader's text, keep the source's wording where a gap sits (both sides of a contradiction) and add no remarks about the source. When you are the author, state an unknown as an unknown, in the reader's terms ("we do not know yet when …").
- Substance wins over plainness. When a defined, legal, eligibility or technical term has no everyday word with the same meaning, keep the term and explain it once. A stated reason, condition or exception stays even if it sounds like marketing.
- Repeat a key date, amount or deadline where a reader who skims straight to that heading needs it.
- Bring implicit structure to the surface — the unstated assumption that links evidence to a claim — only when the source grounds it. Promotion is not invention.

## Planning artifacts: one artifact, one rung

An epic, an issue and a PR are rungs of one ladder. Titles, goals and summaries of upper artifacts carry no file paths, function names, environment variables or code blocks — those belong in the leaf (the PR, or an issue's implementation-spec section). Symptoms of a broken ladder: a plan that names functions, a paragraph that mixes "why" and "how", a review that stops at implementation detail, a document no one can re-enter after a session break. Move up a rung when you cannot say why; move down when you cannot say what to do next. Every upper rung needs a way down. Inside one artifact the ladder uses only that artifact's vocabulary; when one document must carry two of these rungs, mark the boundary with `---` and a new heading, one boundary per rung.

## Where the rungs go

- Answers and chat: one line first, then the map, then the detail.
- PR and issue bodies: the calldiff block keeps the first position, as the calldiff skill requires. The one line and the map come directly after it.
- Reports (es, html): the top summary is the top rung; the sections are the detail.
- Rungs sit at document and section level, never paragraph by paragraph.
- Asked for a summary: the top rungs are the summary; the bottom rung still keeps every fact.
- Briefing a research agent: pass this skill so its report comes back in the same shape.
- Korean text: run the `zkorean` agent on the finished draft when a Korean sentence reads stiffly.

## When there is no ladder

The complete list — do not invent a third case:

- The artifact is not explanatory prose: code, config, a schema, a log line, a commit trailer, a machine-read payload.
- The user asked for the detail only, in words ("no eli5", "디테일만"). Your own reading of the audience does not count.

Exact quotations, legal clauses and error strings are not exceptions: quote them verbatim and put the plain rung beside them, never inside them.

## Worked example

Before:

> The scheduler applies exponential backoff with jitter to retry dispatches that fail with a 5xx, capped at 6 attempts over 15 minutes, after which the job is dead-lettered.

After:

> In short: when a job fails because the far side is broken, we wait and try again — 6 tries over 15 minutes. If it still fails, we park the job somewhere safe instead of losing it.
>
> The scheduler retries any dispatch that fails with a 5xx status. Each retry waits longer than the last (exponential backoff), plus a random offset (jitter) so retries do not all arrive together. It stops after 6 attempts or 15 minutes, whichever comes first, and moves the job to the dead-letter queue.

Nothing was dropped: the 5xx status, the backoff, the jitter, the 6 attempts, the 15 minutes and the dead-letter queue all survive below the top rung.

## Before you finish

- Does the top rung come first, labelled, and could an outsider act on it alone without being wrong?
- Does any rung use a term from the rung below it, or contradict another rung?
- Is every fact of the source on the bottom rung? Did anything get added?
- Are the gaps in the source visible and listed?
- Do the sentences pass the self-check in `references/plain-language.md`?
- Did you skip the ladder? Name which of the 2 listed cases applies. If neither does, write the ladder.

Sources: GOV.UK A to Z style guide and GDS content design principles; the r/explainlikeimfive convention (explain for a layperson, not a child); RST, Minto pyramid and Toulmin for structure (see `references/structure-engine.md`).
