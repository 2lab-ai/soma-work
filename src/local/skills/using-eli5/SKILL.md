---
name: using-eli5
description: Write every explanation twice — an ELI5 layer first, then the full detail underneath, with nothing dropped. Use for reports, docs, PR and issue bodies, research write-ups, code explanations, incident notes and any answer a non-expert reads before an expert does. Builds on using-govuk plain English. Triggers on "eli5", "using-eli5", "explain like I'm 5", "쉽게 설명해줘", "쉽게 먼저 설명해줘", "초등학생도 알아듣게".
---

# using-eli5 — ELI5 first, then the detail

## In short

Every explanation gets two layers, always in this order. First the ELI5 layer: what this is, in words a smart outsider understands on the first read. Then the detail layer: the full, precise version with nothing taken out. The reader chooses their depth, and never has to choose between understanding it and getting it right.

This skill sits on top of using-govuk. Everything there still applies — plain English, active voice, front-loaded content, sentence case, no bold or italics for emphasis. using-eli5 adds one thing: the entry ramp that comes first.

## The contract

- Always write the ELI5 layer first, then the detail layer. Never the other way round, and never only one of the two.
- The ELI5 layer is not a replacement for the detail. It is the way in. Nothing is removed from the detail layer to make room for it.
- The two layers must never contradict each other. The ELI5 layer is a simpler view of the same claim, not a softer or a different claim.
- Open it up, do not dumb it down. If a simplification would leave the reader believing something false, it is not a simplification. Rewrite it.
- Label both layers so the reader can skip. Use "In short" and "Detail" in English, or "쉽게 말하면" and "자세히" in Korean. Keep the same labels through one document.

## The ELI5 layer

- Aim at a clever adult from outside the domain, not a literal 5-year-old. No baby talk. Do not open with "basically", "simply" or "just".
- Answer three things, in this order: what it is, why it matters, what happens next.
- Make it self-contained. Every word is either everyday English or explained on the spot. If a term only makes sense after the detail layer, cut it.
- Keep the numbers that carry the point. "6 tries in 15 minutes" is clearer than "a few tries"; dropping the number is not simplifying, it is vagueness.
- Prefer the concrete. Name the thing that breaks, the person who waits, the file that changes.
- Add no new claims. Everything here appears again, in fuller form, in the detail layer.

## The detail layer

- Full precision. Names, versions, file paths, function signatures, edge cases, failure modes and caveats all stay.
- Written in using-govuk plain English: active voice, short sentences, everyday words, sentence case headings, no Latin abbreviations, no emphasis formatting.
- Ordered by the inverted pyramid: conclusion, then evidence, then background.
- It assumes the reader saw the ELI5 layer but does not depend on it. An expert who skipped ahead must still get everything.

## Length budget

- The ELI5 layer runs to about 120 words at most, or roughly a fifth of the section it opens — whichever is shorter.
- Keep it to one paragraph, or up to 5 bullets. If it will not fit, the thing you are explaining is 2 things. Split it and give each its own pair of layers.
- A document-level ELI5 sits at the top, covers the whole document, and stays under about 150 words.

## Where the layers go

- Document level: one ELI5 layer at the top, before any section.
- Section level: one ELI5 layer per major section, when that section carries a hard idea.
- Not paragraph level. Alternating every few lines gives the reader whiplash and doubles the length for nothing.

## Analogies: the one rule this skill relaxes

using-govuk tells you to avoid metaphors and clichés. Inside the ELI5 layer you may use one analogy, if it meets all 3 conditions:

- it maps onto the real mechanism part for part, not just in mood
- you state it as an analogy ("this works like a queue at a till"), never as fact
- the mechanism it stands for appears literally in the detail layer

Decorative metaphors and tired clichés stay banned in both layers: drive, unlock, deep dive, robust, ecosystem, landscape, going forward.

## When not to add an ELI5 layer

- The content is already plain to anyone. "The build failed. Run it again." needs no ramp.
- The artifact is read by a machine or by convention: a config file, a schema, a log line, a commit message trailer.
- The text is a direct quotation, a legal or contractual clause, or an exact error string. Quote it exactly and put your ELI5 beside it, never inside it.
- The reader is inside the domain and asked for the detail only. Say that you are skipping the layer, then skip it.

## Worked example

Before:

> The scheduler applies exponential backoff with jitter to retry dispatches that fail with a 5xx, capped at 6 attempts over 15 minutes, after which the job is dead-lettered.

After:

> In short: when a job fails because the far side is broken, we wait and try again, waiting longer each time. We give it 6 tries over 15 minutes. If it still fails, we park the job somewhere safe instead of losing it.
>
> Detail: the scheduler retries any dispatch that fails with a 5xx status. Each retry waits longer than the last (exponential backoff), plus a random offset (jitter) so that retries do not all arrive together. It stops after 6 attempts or 15 minutes, whichever comes first, and moves the job to the dead-letter queue.

Nothing was dropped. The 5xx status, the backoff, the jitter, the 6 attempts, the 15 minutes and the dead-letter queue all survive into the detail layer. The ELI5 layer only gets the reader there.

## Before you finish: self-check

- Does the ELI5 layer come first, and is it labelled?
- Could someone outside the domain read the ELI5 layer alone and still be right about what happens?
- Does anything in the ELI5 layer contradict the detail layer, or promise more than it?
- Is the detail layer still complete — every number, name, caveat and failure mode intact?
- Is the ELI5 layer inside its word budget, and is it one paragraph or 5 bullets at most?
- Does the whole thing still pass the using-govuk self-check?

## How this works with other skills

- using-govuk: the parent style. Read it first. using-eli5 changes the order and adds a layer; it changes none of the language rules.
- es and html reports: the top summary is the ELI5 layer, the sections beneath it are the detail layer.
- PR and issue bodies: open with what the change does for someone who has not seen the code, then give the technical sections.
- using-ha-thinking: the layers are about who reads them, not about how you think. A thinking layer can still need its own ELI5 opening.
- Research briefs: pass this skill to the agent so its report arrives in the same two-layer shape.

---

Built on using-govuk (GOV.UK style guide and GDS content design principles). The ELI5 idea comes from the r/explainlikeimfive convention: explain it for a layperson, not for a child.
