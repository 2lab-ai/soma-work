---
name: using-eli5
description: Write every explanation twice — an ELI5 layer first, then the full detail underneath, with nothing dropped. Use for reports, docs, PR and issue bodies, research write-ups, code explanations, incident notes and any answer a non-expert reads before an expert does. Builds on using-govuk plain English. Triggers on "eli5", "using-eli5", "explain like I'm 5", "쉽게 설명해줘", "쉬운 말로", "풀어서 설명해줘", "초등학생도 알아듣게".
---

# using-eli5 — ELI5 first, then the detail

## In short

Every explanation gets two layers, always in this order. First the ELI5 layer: what this is, in words a smart outsider understands on the first read. Then the detail layer: the full, precise version with nothing taken out. The reader chooses their depth, and never has to choose between understanding it and getting it right.

Detail: everything below this line is the detail layer of this skill. Load using-govuk with it — this skill assumes that style and does not restate it.

## The contract

- Always write the ELI5 layer first, then the detail layer. Never the other way round, and never only one of the two.
- Nothing is exempt for looking easy. When the content is already plain, the ELI5 layer shrinks to one sentence. It never disappears. "It was already clear" is not a reason to skip, and neither is your own belief that the reader is an expert.
- The section "When not to add an ELI5 layer" holds the complete list of exceptions. It has 2 entries. Do not invent a third.
- The ELI5 layer is not a replacement for the detail. It is the way in. Nothing is removed from the detail layer to make room for it.
- The two layers must never contradict each other. The ELI5 layer is a simpler view of the same claim, not a softer or a different claim.
- Open it up, do not dumb it down. If a simplification would leave the reader believing something false, it is not a simplification. Rewrite it.
- Label both layers so the reader can skip. Use "In short" and "Detail" in English, or "쉽게 말하면" and "자세히" in Korean. Keep the same labels through one document.

## The ELI5 layer

- Aim at a clever adult from outside the domain, not a literal 5-year-old. No baby talk. Do not open with "basically", "simply" or "just".
- Answer three things, in this order: what it is, why it matters, what happens next.
- Make it self-contained. Every word is either everyday English or explained on the spot. If a term only makes sense after the detail layer, cut it.
- Keep the numbers that carry the point. "6 tries in 15 minutes" beats "a few tries". Dropping the number is not simplifying, it is vagueness.
- Name the concrete thing: the service that breaks, the person who waits, the file that changes.
- Add no new claims. Everything here appears again, in fuller form, in the detail layer.

## The detail layer

- Full precision. Names, versions, file paths, function signatures, edge cases, failure modes and caveats all stay.
- Written in using-govuk plain English: active voice, short sentences, everyday words, front-loaded paragraphs, sentence case headings, no Latin abbreviations, no bold or italics for emphasis. This line is the only restatement of using-govuk in this skill. For anything finer, read using-govuk itself.
- Ordered by the inverted pyramid: conclusion, then evidence, then background.
- It assumes the reader saw the ELI5 layer but does not depend on it. An expert who skipped ahead must still get everything.

## Length budget

- Hard cap: an ELI5 layer is 120 words maximum. A document-level ELI5 layer is 150 words maximum. Count them when you are near the line.
- Cap the shape too: one paragraph, or 5 bullets at most.
- If it will not fit, the thing you are explaining is usually 2 things. Splitting it and giving each its own pair of layers is the first thing to try.

## Where the layers go

- Document level: one ELI5 layer at the top, before any section.
- Section level: one ELI5 layer per major section, when that section carries a hard idea.
- Not paragraph level. Alternating every few lines gives the reader whiplash and doubles the length for nothing.
- PR and issue bodies: the calldiff call-flow block keeps the first position, as the calldiff skill requires. The ELI5 layer goes directly after it, ahead of context and the test plan.

## Analogies: the one rule this skill relaxes

using-govuk tells you to avoid metaphors and clichés. This skill relaxes that ban in one place: at most one analogy per ELI5 layer — not per document, not per section — and only if all 3 conditions hold:

- it maps onto the real mechanism part for part, not just in mood
- you state it as an analogy ("this works like knocking on a door"), never as fact
- the mechanism it stands for appears literally in the detail layer

Outside that single allowance the full using-govuk banned list applies, in both layers. Read the list there rather than trusting a copy here.

## When not to add an ELI5 layer

This is the complete list. There are 2 cases:

- The artifact is not explanatory prose: a config file, a schema, a log line, a commit message trailer, a machine-read payload.
- The user explicitly asked for the detail only, in words — "no eli5", "디테일만", "skip the simple version". Your own reading of the audience does not count.

Exact quotations, legal or contractual clauses and error strings are a different shape, not an exception. Quote them verbatim and put the ELI5 layer beside them, never inside them.

## Worked example

Before:

> The scheduler applies exponential backoff with jitter to retry dispatches that fail with a 5xx, capped at 6 attempts over 15 minutes, after which the job is dead-lettered.

After:

> In short: when a job fails because the far side is broken, we wait and try again. This works like knocking on a door: each knock waits longer than the last, and everyone pauses for a slightly different length of time so the knocks do not land together. We give it 6 tries over 15 minutes. If it still fails, we park the job somewhere safe instead of losing it.
>
> Detail: the scheduler retries any dispatch that fails with a 5xx status. Each retry waits longer than the last (exponential backoff), plus a random offset (jitter) so that retries do not all arrive together. It stops after 6 attempts or 15 minutes, whichever comes first, and moves the job to the dead-letter queue.

That is the one analogy this ELI5 layer is allowed, and both halves of it — the growing wait and the random pause — appear literally in the detail layer. Nothing was dropped either: the 5xx status, the backoff, the jitter, the 6 attempts, the 15 minutes and the dead-letter queue all survive.

## Before you finish: self-check

- Does the ELI5 layer come first, and is it labelled?
- Could someone outside the domain read the ELI5 layer alone and still be right about what happens?
- Does anything in the ELI5 layer contradict the detail layer, or promise more than it?
- Is the detail layer still complete — every number, name, caveat and failure mode intact?
- Is the ELI5 layer inside 120 words, and is it one paragraph or 5 bullets at most?
- Did you skip a layer? If so, name which of the 2 listed exceptions applies. If neither does, write the layer.
- Does the whole thing pass the using-govuk self-check? Load using-govuk if you have not.

## How this works with other skills

- using-govuk: the parent style. Load it alongside this one. using-eli5 adds the layer order and changes only the metaphor rule, exactly as bounded above.
- calldiff: in a PR body the calldiff block stays first. The ELI5 layer follows it.
- es and html reports: the top summary is the ELI5 layer, the sections beneath it are the detail layer.
- using-ha-thinking: its layers are about how you think; these layers are about who reads them. A thinking layer still needs its own ELI5 opening.
- Research briefs: pass this skill to the agent so its report arrives in the same two-layer shape.

---

Built on using-govuk (GOV.UK style guide and GDS content design principles). The ELI5 idea comes from the r/explainlikeimfive convention: explain it for a layperson, not for a child.
