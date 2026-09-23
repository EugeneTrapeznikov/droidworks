---
source: https://www.youtube.com/watch?v=Spn-F83ZHH0
title: Fake Jev demos are taking over the internet
duration: 09:30
watched_at: 2026-09-22T20:00:07.834613-07:00
intent: Understand the JEV technique (exact term + expansion), its mechanism for just-in-time loading of skills/tools/instructions out of an agent's initial context window, as implemented in github.com/BuilderIO/agent-native; goal is porting it to a custom Pi coding-agent harness
hero_frames: [frame_0001.jpg, frame_0006.jpg, frame_0011.jpg, frame_0016.jpg, frame_0027.jpg]
transcript_source: captions
---

# Fake Jev demos are taking over the internet

## TL;DR

- **"Jev" is not a technique or acronym — it is a product.** Jev is a *model* by **TypeSafe** (typesafe.ai; auto-captions mis-hear it as "Typeset AI" and repeatedly as "Jeff"). Speaker at [00:19]: "Jev by TypeSafe is actually very cool, but **it's a decision model, not an LLM**. It's fast, it's cheap, it's a new type of model which we don't see very often." On-screen site copy: "The First (Public) System One Model; Jev Gives AI The Properties Of Code" / "Introducing Jev — Intelligence beyond chat". The video gives **no acronym expansion**.
- **What Jev does, exactly** [00:53]: "Jev only makes decisions. It can basically tell you a **probability of yes, no, or a choice from a set of options**." It cannot see images/video [02:37], cannot type free text [06:40], cannot generate — it only ranks/selects from a supplied finite candidate set and returns calibrated probabilities.
- **The context technique the user is after is the last 90 seconds** [07:29–08:53]: Agent-Native is "the first framework to use Jev fundamentally in the core agent loop." Instead of packing every MCP tool, skill and resource into the system prompt, Agent-Native runs Jev **on every prompt** to pick the few relevant tools/skills/resources and injects only those. On-screen label for it: **"Jev tool compaction"**.
- **The framing is a three-way comparison** (on-screen card at [07:50]): `all tools listed` → "100k+ tokens" (red); `tool search` → "agents don't know what to search" (red); `Jev tool compaction` → "efficient, accurate" (green). Second card at [08:05]: an `LLM Message` box containing `prompt / tool 1 / tool 2 / skill 1 / skill 2` with arrows labelled **"Jev chooses"** pointing at `tool 1` and `skill 1`.
- **Claimed payoff** [08:41]: "you can have a **smarter agent for cheaper than ever before**, higher quality results from lower cost faster models, meaning your apps just work better and cost less to run." Card at [08:35]: `LLM + Jev = ❤️`. The video gives **no benchmark, no eval method, and only one number (100k+ tokens)**.

## Key moments

- **[00:00] Cold open, contrarian hook** — two viral clips play; "This viral Jev demo you may have seen, this is fake. This demo, too, very fake." (`frame_0001.jpg`)
- **[00:16] Jev defined** — "Jev by TypeSafe is actually very cool, but it's a decision model, not an LLM." TypeSafe landing page on screen: "The First (Public) System One Model; Jev Gives AI The Properties Of Code" (`f2/intro_002.jpg`).
- **[00:53] The whole mental model in one line** — "Jev only makes decisions. It can tell you a probability of yes, no, or a choice from a set of options."
- **[01:03] The universal cheat** — "they hardcode a bunch of options and they have Jev pick from the options and then go, 'Wow, look what Jev did.'"
- **[02:37] Hard capability limits** — "Jev cannot take in images or video input"; Doom/driving demos feed it internal game state, not pixels.
- **[03:38]–[06:28] Demo triage** — Postgres NL filter (won't scale), Nader's cmd-K autocomplete (first genuinely practical one, [04:12]), "instant compaction for code" (makes no sense, [04:29]), Riley's email classification (shipped into Agent-Native Mail, [04:57]), browser use over HTML with IDs (coolest realistic one, [05:27]), trading, Cloudflare flow syntax.
- **[07:29] Pivot to the real technique** — "But here's what I have used Jev to implement… Agent-Native is now the first framework to use Jev fundamentally in the core agent loop."
- **[07:42] The mechanism stated** — "Agent Native uses Jev, now for **every prompt**. Based on your prompts, it'll search through and find the most relevant tools and put that in the LLM context."
- **[07:50] Three-way comparison card** — `all tools listed / 100k+ tokens` vs `tool search / agents don't know what to search` vs `Jev tool compaction / efficient, accurate` (`f2/seg_009.jpg`).
- **[08:05] Injection diagram** — `LLM Message` box: prompt + tool 1/tool 2/skill 1/skill 2, green arrows "Jev chooses" → tool 1, skill 1 (`f2/seg_011.jpg`).
- **[08:35] Payoff card** — `LLM + Jev = ❤️`; "smarter agent for cheaper than ever before" (`f2/seg_017.jpg`).
- **[09:04] Outro / thesis restated** — "I wish people would stop misleading people online with demos that are… highly fuzzed over the details."

## Hook microscope (0-10s)

- Frames: 20 at 2 fps

**Pattern: demo-first, then contrarian debunk.** No title card, no intro, no face for the first ~4 seconds.

- **0.0–3.5s** — Cold open *inside someone else's demo*: a drawing-canvas screen recording with voice-over from the original clip ("Add a red diamond here. I'll make it bigger. Move this over here."). The viewer is dropped into the artifact being critiqued before being told it is being critiqued.
- **~3.5s** — Speaker's own voice cuts in over the same footage: "This viral Jev demo you may have seen — **this is fake**." The reversal lands on footage the viewer was still reading as impressive. This is the hook.
- **~6–10s** — Hard cut to a second clip; "This demo, too, very fake." Then a widening claim: "The internet right now is littered with tons of fake demos about Jev with every type of claim including *I built Tesla full self-driving*. What?" (`frame_0006.jpg`, the Justin Schroeder X post with a driving-sim video).
- The speaker's talking head only enters as a picture-in-picture over the X post; the screen recording, not the face, carries the first 10 seconds.
- Mechanic worth stealing: the hook is a **negation of borrowed credibility** — use the strongest available third-party artifact as your opening, then invalidate it. No question, no promise, no "in this video".

## Editorial profile

- Shots: 27
- Cuts/min: 2.84
- Mean shot length: 21.13s
- Median shot length: 6.53s
- Talking-head ratio: n/a (opencv not installed)

Reaction-channel format: continuous talking-head PiP over long, uncut screen recordings of other people's X posts (mean shot 21s, median 6.5s — the long tail is "sit on one tweet and narrate"), switching to black-background hand-lettered concept cards only for the final 90-second pitch, which is where every cut and every piece of on-screen text is spent.

## Quotable moments

- **[00:53]** "Jev only makes decisions. It can basically tell you a probability of yes, no, or a choice from a set of options."
- **[01:03]** "The trick most of these demos use is they hardcode a bunch of options and they have Jev pick from the options and then go, 'Wow, look what Jev did.'"
- **[07:42]** "Agent-Native uses Jev, now for every prompt. Based on your prompts, it'll search through and find the most relevant tools and put that in the LLM context."
- **[08:02]** "Tool search is a cool idea, but kind of doesn't work amazingly in practice."
- **[08:16]** "To pack every skill and a description into context is expensive, bloats the window, and slows down responses."
- **[08:41]** "You can have a smarter agent for cheaper than ever before — higher quality results from lower cost faster models."

## Entities mentioned

- People: [[steve-sewell]] (narrator, Builder.io), [[jack]] / [[justin-schroeder]] (viral drawing + "Tesla FSD" demos, @jpschroeder), [[hugo-duprez]] (game-level generation), [[zacky]] (Jev Postgres function), [[nader-dabit]] (cmd-K autocomplete), [[tomorrow]] (code-compaction visualization), [[riley]] (email classification), [[cj-coding-garden]] (@CodingGarden, "chat bot with jev, no LLM at all"), [[chris]], [[steve-at-cloudflare]] (flow syntax with probabilistic decisions)
- Companies: [[typesafe]] (typesafe.ai), [[builder-io]], [[cloudflare]], [[tesla]], [[google]] (Gmail spam filter), [[apple]] (macOS local transcription)
- Tools / products: [[jev]], [[system-one-models]], [[agent-native]], [[agent-native-mail]], [[mcp]], [[postgres]], [[doom]], [[gmail]]
- Places: —

## Concepts surfaced

- **Jev** — TypeSafe's first public "System One" model: a decision model, not an LLM. Input = a state blob + a question with a finite set of labelled criteria; output = a choice plus calibrated probabilities over the options. Fast, cheap, no generation, no vision, no free-text typing.
- **System One model** — TypeSafe's category name (their site: "a new class of AI model built for decisions inside software"), positioned against "System Two" LLM chat. The video only calls it "a decision model, not an LLM" and "a new type of model which we don't see very often."
- **Jev tool compaction** (on-screen term, [07:50]) — replace "put all tools/skills/resources in context" and "let the agent call a tool-search tool" with a deterministic pre-model-call ranking pass done by a cheap decision model, injecting only the top-k.
- **The finite-options cheat** — the video's central debunk: a Jev demo looks generative only because the developer hardcoded the option set; the demo does not extend because "this doesn't get better unless you're going to make infinity options."
- **Hybrid decision-model + LLM architecture** [08:34] — "using Jev where Jev shines, and LLMs where they're strong, in combination." Deterministic selection from the cheap model; generation from the expensive one.
- **Why agent-side tool search underperforms** [07:55] — it requires the agent to know it should search, know what to search for, and requires your search logic to actually be good; three chances to fail, all removed if the harness does the selection.
- **Small/cheap models are bad skill-routers** [08:08] — "agents, especially the more cost-effective ones… are not the best judges on when they should find a skill and apply a skill" — so the harness, not the model, should decide.

## Timestamped outline

| Time | Segment |
|---|---|
| 00:00 | Cold open on someone else's drawing demo; "this is fake. This demo, too, very fake." |
| 00:10 | The internet is littered with fake Jev demos, up to "I built Tesla full self-driving" |
| 00:16 | What Jev actually is: TypeSafe's decision model, not an LLM; fast, cheap, new model class |
| 00:32 | Thesis + roadmap: what Jev does, how the demos cheat, what's actually cool |
| 00:44 | Jack's drawing demo dissected; "Jev only makes decisions… probability of yes/no or a choice from a set of options" |
| 01:03 | The hardcoded-options cheat, illustrated with the "Jev designed the UI" component demo |
| 01:41 | Back to the drawing demo: add circle / blue square / diamond / undo are fixed actions at cursor |
| 02:07 | "This is your typical misleading AI demo"; real workflows need precision Jev cannot provide |
| 02:37 | Tesla FSD / Doom debunked: Jev takes no image or video input, only internal game state + control options |
| 03:07 | Charitable read ("maybe it's a joke") but the misimpression stands |
| 03:17 | Floor-tile level builder: genuinely is Jev choosing, from a fixed height set; cool but monotonous |
| 03:38 | Zacky's Jev Postgres function (NL row filter) — exciting, but only viable on tiny datasets |
| 04:12 | Nader's cmd-K semantic autocomplete — "one of the first real practical demos" |
| 04:29 | "Instant compaction for code" — great visualization, technique makes no sense; compaction is summarization, not line-picking |
| 04:57 | Riley's email classification — the one he liked enough to ship into Agent-Native Mail (custom tag prompts + smarter spam filter, free/open source) |
| 05:27 | Browser use — pass unstyled HTML with IDs on clickables, Jev picks the next ID; fast and cheap when markup is clean; worse than LLM computer use on canvas/WebGL |
| 06:03 | Some browser-use demos faked: Jev can only "type" from a predefined string set |
| 06:18 | Trading demos — possible, but not competitive with real HFT |
| 06:28 | Cloudflare (Steve) flow syntax with probabilistic decisions inline — coolest idea, but a language switch |
| 06:47 | Launch-app demos; probable hidden local transcription or a fast LLM doing the text |
| 07:08 | "Jev chatbot" demos — actually a wacky tool-chooser harness; "I don't buy it" |
| **07:29** | **Pivot: Agent-Native is the first framework to use Jev fundamentally in the core agent loop** |
| **07:42** | **Mechanism: Jev runs on every prompt, ranks tools, injects only the relevant ones into LLM context** |
| **07:50** | **Card: all tools listed = 100k+ tokens / tool search = agents don't know what to search / Jev tool compaction = efficient, accurate** |
| **08:06** | **Same applied to skills and resources; cheap models are poor judges of when to invoke a skill; packing every skill description bloats the window and slows responses** |
| **08:05** | **Diagram: LLM Message { prompt, tool 1, tool 2, skill 1, skill 2 }, "Jev chooses" → tool 1 + skill 1** |
| **08:34** | **Hybrid thesis: Jev where Jev shines, LLMs where they're strong. `LLM + Jev = ❤️`** |
| **08:41** | **Claim: smarter agent for cheaper; higher quality from lower-cost faster models** |
| 08:52 | Other real Jev use cases are "a bit more boring, like classification style" |
| 09:04 | Closing rant about misleading demos; CTA to Agent-Native + comments |

## Implementation in BuilderIO/agent-native (outside the video — read from the repo, not stated on camera)

The video never shows code. The actual implementation lives in two files:

- `packages/core/src/agent/jev-tool-prefetch.ts` — `rankJevCandidates()` (generic ranker) and `preloadJevTools()` (tools).
- `packages/core/src/server/agent-chat/prompt-resources.ts` — `collectJevPromptCandidates()` + `preloadJevContextForPrompt()` (skills/resources).
- Call site: `packages/core/src/agent/production-agent.ts` ~line 10684 — both run in a single `Promise.all` **once per user request, before the first model call**, not per turn and not on tool results.

Shape of the Jev call (`model: "jev-latest"`, 750 ms timeout, 0 retries):

```
{ model, state: { task: <user request>, candidate_tools|candidate_context: [{id, description, ...metadata}] },
  questions: { best_tool|best_context: { type: "choice", instructions, criteria: {id: description} } } }
```

Response `answers[key].{choice, probabilities}` → sort by probability, take top-k (default 3, max 5).

Key constants and behaviours:
- `MAX_JEV_CANDIDATES = 128`; above that a **lexical token-overlap shortlist** trims the catalog first.
- Tools: selected schemas are *prepended* to the curated initial tool list (additive, nothing is removed).
- Skills/resources: selected SKILL.md contents are inlined into the system prompt inside a `<jev-prefetched-context>` block, capped at 10,000 chars/item and 24,000 chars total (6,000 / 16,000 in compact mode).
- **Fail-open by design:** no API key, timeout, malformed response or provider error → return the existing deterministic context. Comment in-repo: "Jev is an accelerator, not a dependency of agent execution."
- Transport: Builder gateway proxy (`/agent-native/jev/v1/system-one`) first, falling back to the direct `@typesafe-ai/sdk` `client.systemOne` call.

## Transcript

_Source: captions._

```
[00:02] Add a red diamond here. I'll make it bigger.
[00:03] I'll make it bigger. Move this over here.
[00:04] Move this over here. &gt;&gt; This viral Jev demo you may have seen,
[00:06] &gt;&gt; This viral Jev demo you may have seen, this is fake. This demo, too, very fake.
[00:10] this is fake. This demo, too, very fake. The internet right now is littered with
[00:12] The internet right now is littered with tons of fake demos about Jev with every
[00:14] tons of fake demos about Jev with every type of claim including I built Tesla
[00:16] type of claim including I built Tesla full self-driving. What? Now Jev by
[00:19] full self-driving. What? Now Jev by Typeset AI is actually very cool, but
[00:21] Typeset AI is actually very cool, but it's a decision model, not an LLM. It's
[00:24] it's a decision model, not an LLM. It's fast, it's cheap, it's a new type of
[00:25] fast, it's cheap, it's a new type of model which we don't see very often. But
[00:28] model which we don't see very often. But oh my god, people are posting so many
[00:30] oh my god, people are posting so many demos that are so fake, it's killing me.
[00:32] demos that are so fake, it's killing me. Let me explain to you what Jev actually
[00:34] Let me explain to you what Jev actually does. How these demos are cheating in
[00:36] does. How these demos are cheating in completely unviable ways and show you
[00:38] completely unviable ways and show you some actually cool things you could do
[00:39] some actually cool things you could do with Jev and how they work. Here's the
[00:41] with Jev and how they work. Here's the list of the coolest and most BS Jev
[00:43] list of the coolest and most BS Jev demos right now. Now let's go back to
[00:45] demos right now. Now let's go back to Jack. Now Jack is not a developer. When
[00:46] Jack. Now Jack is not a developer. When people ask, "How does this work?" he
[00:48] people ask, "How does this work?" he just says, "I don't really know, Fable
[00:50] just says, "I don't really know, Fable did it for me." And that's fine, to be
[00:52] did it for me." And that's fine, to be honest. But let's see what's actually
[00:53] honest. But let's see what's actually going on here. Jev only makes decisions.
[00:55] going on here. Jev only makes decisions. It can basically tell you a probability
[00:57] It can basically tell you a probability of yes, no, or a choice from a set of
[00:59] of yes, no, or a choice from a set of options. So you can see in the UI below
[01:02] options. So you can see in the UI below what's happening. So the trick most of
[01:03] what's happening. So the trick most of these demos use is they hardcode a bunch
[01:05] these demos use is they hardcode a bunch of options and they have Jev pick from
[01:07] of options and they have Jev pick from the options and then go, "Wow, look what
[01:09] the options and then go, "Wow, look what Jev did." So for instance in this case
[01:11] Jev did." So for instance in this case we're hardcoding a bunch of components
[01:12] we're hardcoding a bunch of components and static prop options and we're
[01:14] and static prop options and we're saying, "Wow, Jev designed the UI." Jev
[01:16] saying, "Wow, Jev designed the UI." Jev did not design the UI. Jev chose card,
[01:19] did not design the UI. Jev chose card, button, and one of a few preconfigured
[01:21] button, and one of a few preconfigured text options. This is not useful. This
[01:23] text options. This is not useful. This does not give you generated UI, the
[01:25] does not give you generated UI, the ability to give you dynamic UIs on the
[01:26] ability to give you dynamic UIs on the fly, it lets you pick from a set of
[01:28] fly, it lets you pick from a set of prebuilt options. This is not like a
[01:30] prebuilt options. This is not like a here's the future demo, it'll get better
[01:33] here's the future demo, it'll get better as we get better with it. This is just
[01:34] as we get better with it. This is just not what the model does. This doesn't
[01:36] not what the model does. This doesn't get better unless you're going to make
[01:37] get better unless you're going to make infinity options, which truly for this
[01:39] infinity options, which truly for this use case of design and UI generation
[01:41] use case of design and UI generation makes no sense. But going back to our
[01:42] makes no sense. But going back to our first video, how do they map this to a
[01:44] first video, how do they map this to a set of options? They kind of fake it.
[01:46] set of options? They kind of fake it. The set of options that are clearly here
[01:47] The set of options that are clearly here are things like add circle. Now again,
[01:49] are things like add circle. Now again, it's a drawing program, but you don't
[01:51] it's a drawing program, but you don't actually get to choose the size of the
[01:53] actually get to choose the size of the circle, the position of the circle. It
[01:54] circle, the position of the circle. It just add circle where cursor is. He
[01:57] just add circle where cursor is. He moves his cursor, asks for blue square,
[01:59] moves his cursor, asks for blue square, it gives you square that is blue. Not a
[02:01] it gives you square that is blue. Not a precise blue, just the hard-coded blue,
[02:03] precise blue, just the hard-coded blue, and it places it. Diamond, too. And a
[02:04] and it places it. Diamond, too. And a few other hard-coded actions. Move here,
[02:07] few other hard-coded actions. Move here, undo, select. This is not a demo of the
[02:09] undo, select. This is not a demo of the future of how to use Jeff for
[02:11] future of how to use Jeff for programmatic application use. This is
[02:13] programmatic application use. This is your typical misleading AI demo, where
[02:15] your typical misleading AI demo, where you hard-coded some options, and then
[02:16] you hard-coded some options, and then you ran through them, and acted like
[02:18] you ran through them, and acted like this all extends to real workflows, but
[02:20] this all extends to real workflows, but it truly doesn't. This will not extend
[02:22] it truly doesn't. This will not extend to real workflows. Real workflows, you
[02:24] to real workflows. Real workflows, you need to put things in precise places,
[02:26] need to put things in precise places, and drag them to precise sizes, and
[02:27] and drag them to precise sizes, and choose precise colors, and arrange them
[02:29] choose precise colors, and arrange them in precise compositions. That's not what
[02:31] in precise compositions. That's not what Jeff does. Jeff doesn't give you that
[02:33] Jeff does. Jeff doesn't give you that control, flexibility, or precision.
[02:34] control, flexibility, or precision. Again, it's choosing from a set of
[02:36] Again, it's choosing from a set of finite options. Let's take full
[02:37] finite options. Let's take full self-driving. First of all, Jeff cannot
[02:40] self-driving. First of all, Jeff cannot take in images or video input. So, when
[02:42] take in images or video input. So, when you see things like Jeff playing Doom,
[02:43] you see things like Jeff playing Doom, or Jeff driving a car, Jeff is actually
[02:46] or Jeff driving a car, Jeff is actually being passed internal game state. It
[02:47] being passed internal game state. It can't see pixels. So, you need to use a
[02:49] can't see pixels. So, you need to use a custom version of a game, where it can
[02:51] custom version of a game, where it can look at internal state, and choose
[02:52] look at internal state, and choose between, usually, the controller
[02:53] between, usually, the controller options, like the fire button, move left
[02:56] options, like the fire button, move left button, move right button, etc. For
[02:58] button, move right button, etc. For driving, it just sees the state, and
[03:00] driving, it just sees the state, and decides turn left, turn right, etc.
[03:02] decides turn left, turn right, etc. Maybe it's a little more advanced than
[03:03] Maybe it's a little more advanced than that, but it's nowhere near what this
[03:05] that, but it's nowhere near what this guy is saying, that it's full
[03:07] guy is saying, that it's full self-driving. And maybe that's a joke,
[03:09] self-driving. And maybe that's a joke, and maybe Jack didn't intend for this to
[03:10] and maybe Jack didn't intend for this to be taken the way it did, or Chris, or
[03:12] be taken the way it did, or Chris, or anyone. But, the reality doesn't change.
[03:14] anyone. But, the reality doesn't change. People are walking away thinking Jeff
[03:15] People are walking away thinking Jeff does all kinds of things it does not.
[03:17] does all kinds of things it does not. This is a cool example of something it
[03:18] This is a cool example of something it kind of can do. It's still pretty much
[03:20] kind of can do. It's still pretty much not realistic, and probably will never
[03:22] not realistic, and probably will never actually be used realistically in this
[03:23] actually be used realistically in this way. But, yes, Jeff is deciding to add
[03:26] way. But, yes, Jeff is deciding to add floor tiles. And probably from a fixed
[03:28] floor tiles. And probably from a fixed set of heights. So, there's height 1, 2,
[03:29] set of heights. So, there's height 1, 2, 3, 4, 5, blah, blah, blah. And that's
[03:30] 3, 4, 5, blah, blah, blah. And that's pretty cool. It's assembling a simple
[03:32] pretty cool. It's assembling a simple level. But, so, it only works for a very
[03:34] level. But, so, it only works for a very simple game that would probably get very
[03:35] simple game that would probably get very monotonous. Because, again, it's
[03:36] monotonous. Because, again, it's choosing from a fixed set of options
[03:38] choosing from a fixed set of options every time. Now, let's take this demo
[03:40] every time. Now, let's take this demo from Zacky. This is a super cool,
[03:42] from Zacky. This is a super cool, interesting idea, where you just have a
[03:44] interesting idea, where you just have a Jeff Postgres function, write in natural
[03:46] Jeff Postgres function, write in natural language, and query and filter all rows
[03:48] language, and query and filter all rows based on that, using Jeff to classify,
[03:51] based on that, using Jeff to classify, basically, likely yes, likely no, on
[03:53] basically, likely yes, likely no, on every row. When I first saw this, I
[03:54] every row. When I first saw this, I thought this is a pretty exciting idea
[03:56] thought this is a pretty exciting idea because it is very fast and very cheap.
[03:58] because it is very fast and very cheap. But realistically, this is only going to
[04:00] But realistically, this is only going to work on very small data sets. It's going
[04:02] work on very small data sets. It's going to be far too expensive and slow to run
[04:04] to be far too expensive and slow to run AI, even a fast AI, on every single row
[04:07] AI, even a fast AI, on every single row of a real production-size database. So,
[04:10] of a real production-size database. So, cool demo, probably ain't never going to
[04:12] cool demo, probably ain't never going to use this. Now, a similar demo that
[04:14] use this. Now, a similar demo that actually could work is like this from
[04:15] actually could work is like this from Nader, where he's taken a more finite
[04:17] Nader, where he's taken a more finite set of options and doing a fast
[04:19] set of options and doing a fast autocomplete like a command K menu. That
[04:21] autocomplete like a command K menu. That could work in a cool semantic way
[04:22] could work in a cool semantic way because it'll never be a huge data set.
[04:24] because it'll never be a huge data set. So, this is my opinion is one of the
[04:25] So, this is my opinion is one of the first real practical demos here. Another
[04:27] first real practical demos here. Another one that I thought was super cool until
[04:29] one that I thought was super cool until I realized it makes zero sense was this
[04:31] I realized it makes zero sense was this one, instant compaction for code. It's a
[04:33] one, instant compaction for code. It's a really snazzy visualization. Tomorrow
[04:35] really snazzy visualization. Tomorrow did a great job visualizing the
[04:36] did a great job visualizing the technique, but unfortunately, the
[04:37] technique, but unfortunately, the technique makes no sense. Compaction is
[04:39] technique makes no sense. Compaction is not about keeping some lines and
[04:41] not about keeping some lines and discarding some lines. It's about
[04:43] discarding some lines. It's about summarizing the most important
[04:44] summarizing the most important information that happened. That's almost
[04:46] information that happened. That's almost never just taking things verbatim. I've
[04:48] never just taking things verbatim. I've seen a lot of other code examples that
[04:49] seen a lot of other code examples that are in this vein, and they kind of just
[04:51] are in this vein, and they kind of just pretend that AI coding works differently
[04:52] pretend that AI coding works differently than it does. So, cool idea in theory,
[04:55] than it does. So, cool idea in theory, but no, this is not an effective
[04:56] but no, this is not an effective compaction technique at all. One cool
[04:57] compaction technique at all. One cool one by Riley is email classification.
[04:59] one by Riley is email classification. Rapidly tag emails, create a much
[05:01] Rapidly tag emails, create a much smarter spam filter because Gmail's is
[05:03] smarter spam filter because Gmail's is terrible and I get spam all the time
[05:05] terrible and I get spam all the time every day. I like this one so much that
[05:06] every day. I like this one so much that I built it right into Agent Native Mail.
[05:08] I built it right into Agent Native Mail. Add your own custom prompts to describe
[05:10] Add your own custom prompts to describe what emails should get what tags, add
[05:12] what emails should get what tags, add any context about what things should be
[05:14] any context about what things should be spam that are not currently marked as
[05:15] spam that are not currently marked as spam, and Jeff for every email will
[05:17] spam, and Jeff for every email will auto-tag, auto-filter, and you'll have a
[05:19] auto-tag, auto-filter, and you'll have a much smarter, much more controlled spam
[05:21] much smarter, much more controlled spam filter than you ever had. Agent Native
[05:22] filter than you ever had. Agent Native Mail is also free, open source, and
[05:24] Mail is also free, open source, and totally agentic. Try it out sometime.
[05:26] totally agentic. Try it out sometime. Let's see some more demos. Here is
[05:27] Let's see some more demos. Here is actually one of the coolest, mostly
[05:29] actually one of the coolest, mostly realistic demos. Browser use. Because
[05:31] realistic demos. Browser use. Because browsers are HTML, you can pass that
[05:33] browsers are HTML, you can pass that HTML as the input to Jeff. You can
[05:35] HTML as the input to Jeff. You can assign every clickable location an ID
[05:37] assign every clickable location an ID and tell Jeff to choose what ID to
[05:39] and tell Jeff to choose what ID to interact with next. Now, keep in mind,
[05:40] interact with next. Now, keep in mind, Jeff cannot type, and Jeff cannot see.
[05:43] Jeff cannot type, and Jeff cannot see. So, you're passing HTML that's unstyled.
[05:45] So, you're passing HTML that's unstyled. But if you have good, clean, accessible
[05:47] But if you have good, clean, accessible markup, which at least some websites do,
[05:49] markup, which at least some websites do, Jeff should be able to navigate it crazy
[05:51] Jeff should be able to navigate it crazy fast and cheap. For website uses
[05:52] fast and cheap. For website uses canvases, WebGL, complex, and not really
[05:55] canvases, WebGL, complex, and not really optimized for accessibility markup, your
[05:57] optimized for accessibility markup, your results might vary. It's likely not as
[05:59] results might vary. It's likely not as reliable as LLM computer use. But when
[06:01] reliable as LLM computer use. But when it works, it's fast and cheap. There's a
[06:03] it works, it's fast and cheap. There's a lot of browser use demos coming out. I
[06:05] lot of browser use demos coming out. I will say some are a little bit faked.
[06:07] will say some are a little bit faked. This one shows things like typing, which
[06:09] This one shows things like typing, which it can only type if you give it a
[06:10] it can only type if you give it a specific set of strings that it can
[06:12] specific set of strings that it can input. So, I've seen some things that
[06:13] input. So, I've seen some things that are a bit misleading, in my opinion,
[06:15] are a bit misleading, in my opinion, like this. It can still kind of use
[06:16] like this. It can still kind of use browsers, yeah. It's still kind of cool.
[06:18] browsers, yeah. It's still kind of cool. Trading is another use case people
[06:19] Trading is another use case people brought up. I mean, yes, kind of. I
[06:21] brought up. I mean, yes, kind of. I don't know if you really want to just
[06:22] don't know if you really want to just buy and sell in real time like this. I
[06:24] buy and sell in real time like this. I don't know if you want to compete with
[06:25] don't know if you want to compete with actual high-frequency traders. But it's
[06:27] actual high-frequency traders. But it's cool, and it can do it. I will say this
[06:29] cool, and it can do it. I will say this is one of the coolest things I've seen,
[06:31] is one of the coolest things I've seen, by Steve at Cloudflare. A special syntax
[06:33] by Steve at Cloudflare. A special syntax to be able to define flows and have
[06:35] to be able to define flows and have probabilistic decisions as part of the
[06:36] probabilistic decisions as part of the flows, right in the syntax. It's a
[06:39] flows, right in the syntax. It's a really cool idea, but I don't know if
[06:40] really cool idea, but I don't know if I'm trying to switch languages right
[06:42] I'm trying to switch languages right now. Though I have seen some JavaScript
[06:43] now. Though I have seen some JavaScript libraries that use await template syntax
[06:45] libraries that use await template syntax like this. That's That's kind of cool.
[06:47] like this. That's That's kind of cool. There are some other demos that are just
[06:48] There are some other demos that are just kind of misleading in subtle ways. You
[06:50] kind of misleading in subtle ways. You can definitely hardcode Jeff to do
[06:52] can definitely hardcode Jeff to do things like launch app from a set of
[06:53] things like launch app from a set of apps. This shows typing though, and
[06:55] apps. This shows typing though, and maybe they're using clever tricks to
[06:56] maybe they're using clever tricks to have Jeff pull in like the last text you
[06:58] have Jeff pull in like the last text you stated. That's coming from like a local
[07:00] stated. That's coming from like a local transcription model. A lot of computers
[07:02] transcription model. A lot of computers like Macs have one built in. Or
[07:03] like Macs have one built in. Or combining with a very fast LLM just to
[07:05] combining with a very fast LLM just to pull text. Time will tell if these broad
[07:07] pull text. Time will tell if these broad computer use examples scale. There's
[07:08] computer use examples scale. There's also things like this that again, highly
[07:10] also things like this that again, highly misleading, acting like it's a Jeff
[07:11] misleading, acting like it's a Jeff built chatbot. But really, it's just
[07:13] built chatbot. But really, it's just kind of weird, wacky hacks for Jeff to
[07:15] kind of weird, wacky hacks for Jeff to choose a tool, and it passes the whole
[07:17] choose a tool, and it passes the whole prompt in and lets Jeff choose if
[07:19] prompt in and lets Jeff choose if certain words should go into inputs to
[07:21] certain words should go into inputs to the tool like web search. It's kind of
[07:23] the tool like web search. It's kind of interesting, kind of weird. I don't buy
[07:24] interesting, kind of weird. I don't buy it. Cool demo, but don't expect to build
[07:26] it. Cool demo, but don't expect to build Jeff-based chatbots or Tesla full
[07:28] Jeff-based chatbots or Tesla full self-driving anytime. But here's what I
[07:30] self-driving anytime. But here's what I have used Jeff to implement, and it's
[07:31] have used Jeff to implement, and it's pretty exciting. AgentNative is now the
[07:33] pretty exciting. AgentNative is now the first framework to use Jeff
[07:34] first framework to use Jeff fundamentally in the core agent loop.
[07:37] fundamentally in the core agent loop. Rather using token expensive or flaky
[07:39] Rather using token expensive or flaky techniques for dealing with large sets
[07:40] techniques for dealing with large sets of tools, skills, and instructions.
[07:42] of tools, skills, and instructions. Agent Native uses Jev, now for every
[07:45] Agent Native uses Jev, now for every prompt. Based on your prompts, it'll
[07:47] prompt. Based on your prompts, it'll search through and find the most
[07:48] search through and find the most relevant tools and put that in the LLM
[07:50] relevant tools and put that in the LLM context, saving you from putting every
[07:52] context, saving you from putting every tool in the context, including all the
[07:53] tool in the context, including all the not relevant ones from all your MCP
[07:55] not relevant ones from all your MCP servers, and saving you from having to
[07:56] servers, and saving you from having to have the agents know to do a tool
[07:58] have the agents know to do a tool search, and what to search for, and hope
[08:00] search, and what to search for, and hope it finds the right thing, and hoping
[08:02] it finds the right thing, and hoping your search logic is actually good,
[08:03] your search logic is actually good, which in my experience, tool search is a
[08:04] which in my experience, tool search is a cool idea, but kind of doesn't work
[08:06] cool idea, but kind of doesn't work amazingly in practice. We also applied
[08:08] amazingly in practice. We also applied it for skills and resources. We find
[08:10] it for skills and resources. We find agents, especially the more
[08:11] agents, especially the more cost-effective ones, which are amazing
[08:13] cost-effective ones, which are amazing for speed and price, are not the best
[08:15] for speed and price, are not the best judges on when they should find a skill
[08:16] judges on when they should find a skill and apply a skill. To pack every skill
[08:18] and apply a skill. To pack every skill and a description into context is is
[08:20] and a description into context is is expensive, bloats the window, and slows
[08:22] expensive, bloats the window, and slows down responses. Instead, we
[08:24] down responses. Instead, we automatically include just the tools,
[08:26] automatically include just the tools, skills, and resources that are relevant,
[08:27] skills, and resources that are relevant, which we can do wicked fast and make
[08:29] which we can do wicked fast and make sure any type of model has exactly the
[08:31] sure any type of model has exactly the right tools in context highlighted in
[08:33] right tools in context highlighted in real time to work much safer and more
[08:35] real time to work much safer and more efficiently. These types of hybrid
[08:36] efficiently. These types of hybrid approaches where we're using Jev where
[08:38] approaches where we're using Jev where Jev shines, and LLMs where they're
[08:40] Jev shines, and LLMs where they're strong, in combination, I think is
[08:41] strong, in combination, I think is pretty incredible. So, now if you build
[08:43] pretty incredible. So, now if you build an Agent Native app, you can have a
[08:44] an Agent Native app, you can have a smarter agent for cheaper than ever
[08:46] smarter agent for cheaper than ever before, higher quality results from
[08:49] before, higher quality results from lower cost faster models, meaning your
[08:50] lower cost faster models, meaning your apps just work better and cost less to
[08:52] apps just work better and cost less to run. That is a huge win. There's a bunch
[08:54] run. That is a huge win. There's a bunch of other really cool real Jev use cases.
[08:56] of other really cool real Jev use cases. Most of them are a bit more boring, like
[08:58] Most of them are a bit more boring, like classification style use cases, but this
[09:00] classification style use cases, but this model is truly unique, truly amazing,
[09:02] model is truly unique, truly amazing, truly fast, truly cheap, and truly
[09:05] truly fast, truly cheap, and truly exciting. I wish people would stop
[09:06] exciting. I wish people would stop misleading people online with demos that
[09:08] misleading people online with demos that are obviously a highly fuzzed over the
[09:10] are obviously a highly fuzzed over the details and giving you the wrong
[09:12] details and giving you the wrong impression completely, and set the real
[09:14] impression completely, and set the real actual software you can build with this
[09:15] actual software you can build with this thing. Maybe it gets less hype, but at
[09:17] thing. Maybe it gets less hype, but at least you're not being a jerk. But
[09:18] least you're not being a jerk. But anyway, try the Agent Native framework
[09:19] anyway, try the Agent Native framework if you want a real agentic loop
[09:21] if you want a real agentic loop optimized by Jev that you can build your
[09:23] optimized by Jev that you can build your own applications on top of. Or tell me
[09:24] own applications on top of. Or tell me in the comments, what are you building
[09:25] in the comments, what are you building with Jev, and what are the you coolest
[09:27] with Jev, and what are the you coolest use cases you've seen that are actually
[09:28] use cases you've seen that are actually real and would actually work. Thanks for
[09:30] real and would actually work. Thanks for watching.
```

## All frames

_Total: 27. Hero frames flagged with star._

* `<scratchpad>/watch-jev/frames/frame_0001.jpg` (t=00:00)
  `<scratchpad>/watch-jev/frames/frame_0002.jpg` (t=00:04)
  `<scratchpad>/watch-jev/frames/frame_0003.jpg` (t=00:07)
  `<scratchpad>/watch-jev/frames/frame_0004.jpg` (t=00:09)
  `<scratchpad>/watch-jev/frames/frame_0005.jpg` (t=00:11)
* `<scratchpad>/watch-jev/frames/frame_0006.jpg` (t=00:13)
  `<scratchpad>/watch-jev/frames/frame_0007.jpg` (t=00:18)
  `<scratchpad>/watch-jev/frames/frame_0008.jpg` (t=00:27)
  `<scratchpad>/watch-jev/frames/frame_0009.jpg` (t=00:44)
  `<scratchpad>/watch-jev/frames/frame_0010.jpg` (t=00:45)
* `<scratchpad>/watch-jev/frames/frame_0011.jpg` (t=00:52)
  `<scratchpad>/watch-jev/frames/frame_0012.jpg` (t=00:54)
  `<scratchpad>/watch-jev/frames/frame_0013.jpg` (t=01:00)
  `<scratchpad>/watch-jev/frames/frame_0014.jpg` (t=01:10)
  `<scratchpad>/watch-jev/frames/frame_0015.jpg` (t=01:16)
* `<scratchpad>/watch-jev/frames/frame_0016.jpg` (t=01:26)
  `<scratchpad>/watch-jev/frames/frame_0017.jpg` (t=01:35)
  `<scratchpad>/watch-jev/frames/frame_0018.jpg` (t=01:41)
  `<scratchpad>/watch-jev/frames/frame_0019.jpg` (t=02:37)
  `<scratchpad>/watch-jev/frames/frame_0020.jpg` (t=03:09)
  `<scratchpad>/watch-jev/frames/frame_0021.jpg` (t=03:11)
  `<scratchpad>/watch-jev/frames/frame_0022.jpg` (t=03:17)
  `<scratchpad>/watch-jev/frames/frame_0023.jpg` (t=05:27)
  `<scratchpad>/watch-jev/frames/frame_0024.jpg` (t=06:07)
  `<scratchpad>/watch-jev/frames/frame_0025.jpg` (t=06:12)
  `<scratchpad>/watch-jev/frames/frame_0026.jpg` (t=06:18)
* `<scratchpad>/watch-jev/frames/frame_0027.jpg` (t=06:28)
